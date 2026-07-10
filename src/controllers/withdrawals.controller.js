/**
 * Merchant wallet withdrawals.
 *
 * The balance is HELD when the request is filed, not when the admin approves:
 *   request → debit the wallet, write a `withdrawal` ledger row (negative)
 *   approve → nothing moves; the payout happened off-platform (bank / bKash)
 *   reject  → credit it back, write a `withdrawal_refund` ledger row (positive)
 *
 * Holding at request time is what stops a merchant with 100 filing five 100
 * requests and having all five approved. It also means the balance a merchant
 * sees is always the balance they can actually spend or withdraw.
 */
const pool = require('../db/pool');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AMOUNT = 10_000_000;

// Bank account numbers vary wildly; mobile wallets are phone numbers.
const BANK_ACCOUNT_RE   = /^[A-Za-z0-9\-\s]{4,34}$/;
const MOBILE_ACCOUNT_RE = /^[0-9+\-\s]{6,20}$/;

const clean = (v, max = 120) => String(v ?? '').trim().slice(0, max);

/** Shape a row for the API. Bank/mobile fields are nulled out when irrelevant. */
function serialize(w) {
  const base = {
    id: w.id,
    amount: Number(w.amount),
    currency: w.currency,
    method: w.method,
    account_holder: w.account_holder,
    account_number: w.account_number,
    status: w.status,
    merchant_note: w.merchant_note,
    admin_note: w.admin_note,
    payout_reference: w.payout_reference,
    requested_at: w.requested_at,
    resolved_at: w.resolved_at,
    resolved_by: w.resolved_by,
  };
  if (w.method === 'bank') {
    return { ...base, bank_name: w.bank_name, branch: w.branch, routing_number: w.routing_number };
  }
  return { ...base, provider: w.provider, variant: w.variant };
}

/**
 * Validate the payload. Returns { error } or { data }.
 * Mobile provider/variant are checked against the live `providers` catalog, so
 * the withdraw form always offers exactly what the platform supports today.
 */
async function validate(body) {
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'amount must be a positive number' };
  if (amount > MAX_AMOUNT) return { error: 'amount out of range' };

  const method = clean(body.method, 16).toLowerCase();
  if (!['bank', 'mobile'].includes(method)) return { error: 'method must be "bank" or "mobile"' };

  const account_holder = clean(body.account_holder);
  const account_number = clean(body.account_number, 64);
  if (account_holder.length < 2) return { error: 'account_holder is required' };
  if (!account_number)           return { error: 'account_number is required' };

  const data = {
    amount: Math.round(amount * 100) / 100,
    method,
    account_holder,
    account_number,
    merchant_note: clean(body.merchant_note, 500) || null,
    bank_name: null, branch: null, routing_number: null,
    provider: null, variant: null,
  };

  if (method === 'bank') {
    if (!BANK_ACCOUNT_RE.test(account_number)) {
      return { error: 'Enter a valid bank account number (4–34 letters, digits, spaces or dashes)' };
    }
    data.bank_name = clean(body.bank_name);
    if (data.bank_name.length < 2) return { error: 'bank_name is required for a bank withdrawal' };
    data.branch = clean(body.branch) || null;
    data.routing_number = clean(body.routing_number, 40) || null;
  } else {
    if (!MOBILE_ACCOUNT_RE.test(account_number)) {
      return { error: 'Enter a valid mobile wallet number' };
    }
    const provider = clean(body.provider, 40).toLowerCase();
    const variant  = clean(body.variant, 20).toLowerCase();
    const p = await pool.query('SELECT variants FROM providers WHERE id = $1 AND is_enabled = TRUE', [provider]);
    if (p.rowCount === 0) return { error: `Provider "${provider}" not found or disabled` };
    const variants = p.rows[0].variants || [];
    if (!variants.includes(variant)) {
      return { error: `Invalid account type for ${provider}. Allowed: ${variants.join(', ')}` };
    }
    data.provider = provider;
    data.variant = variant;
  }
  return { data };
}

/* ─── POST /api/merchant/withdrawals ─── */
async function create(req, res, next) {
  const client = await pool.connect();
  try {
    const v = await validate(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    const d = v.data;

    await client.query('BEGIN');

    // Lock the wallet so two simultaneous requests can't both pass the check.
    const m = await client.query(
      'SELECT id, wallet_balance, currency FROM merchants WHERE id = $1 FOR UPDATE',
      [req.merchant.id]
    );
    if (m.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Merchant not found' }); }

    const balance = Number(m.rows[0].wallet_balance);
    if (d.amount > balance) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `You can withdraw at most ${balance.toFixed(2)}.`,
        code: 'insufficient_balance',
        balance,
      });
    }

    const note = d.method === 'bank'
      ? `Withdrawal to ${d.bank_name} · ${d.account_number}`
      : `Withdrawal to ${d.provider} ${d.variant} · ${d.account_number}`;

    // Hold the money now.
    const ledger = await client.query(
      `INSERT INTO wallet_ledger (merchant_id, amount, kind, note)
       VALUES ($1, $2, 'withdrawal', $3) RETURNING id`,
      [req.merchant.id, -d.amount, note]
    );
    await client.query(
      'UPDATE merchants SET wallet_balance = wallet_balance - $1, updated_at = NOW() WHERE id = $2',
      [d.amount, req.merchant.id]
    );

    const w = await client.query(
      `INSERT INTO withdrawals
         (merchant_id, amount, currency, method, account_holder, account_number,
          bank_name, branch, routing_number, provider, variant, merchant_note, hold_ledger_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [req.merchant.id, d.amount, m.rows[0].currency || 'BDT', d.method, d.account_holder, d.account_number,
       d.bank_name, d.branch, d.routing_number, d.provider, d.variant, d.merchant_note, ledger.rows[0].id]
    );

    await client.query('COMMIT');
    res.status(201).json({ withdrawal: serialize(w.rows[0]), balance: balance - d.amount });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    next(e);
  } finally {
    client.release();
  }
}

/* ─── GET /api/merchant/withdrawals ─── */
async function listForMerchant(req, res, next) {
  try {
    const r = await pool.query(
      'SELECT * FROM withdrawals WHERE merchant_id = $1 ORDER BY requested_at DESC LIMIT 100',
      [req.merchant.id]
    );
    res.json({ withdrawals: r.rows.map(serialize) });
  } catch (e) { next(e); }
}

/* ─── GET /api/admin/withdrawals?status=&q= ─── */
async function listForAdmin(req, res, next) {
  try {
    const params = [];
    let where = '1=1';
    const status = String(req.query.status || 'all').toLowerCase();
    if (['pending', 'approved', 'rejected'].includes(status)) {
      params.push(status);
      where += ` AND w.status = $${params.length}`;
    }
    if (req.query.q && String(req.query.q).trim()) {
      params.push(`%${String(req.query.q).trim().toLowerCase()}%`);
      where += ` AND (LOWER(m.name) LIKE $${params.length} OR LOWER(m.username) LIKE $${params.length}
                      OR LOWER(w.account_holder) LIKE $${params.length} OR LOWER(w.account_number) LIKE $${params.length})`;
    }

    const r = await pool.query(
      `SELECT w.*, m.name AS merchant_name, m.username AS merchant_username,
              m.email AS merchant_email, m.wallet_balance AS merchant_balance
         FROM withdrawals w JOIN merchants m ON m.id = w.merchant_id
        WHERE ${where}
        ORDER BY (w.status = 'pending') DESC, w.requested_at DESC
        LIMIT 300`,
      params
    );

    const counts = await pool.query(
      `SELECT status, COUNT(*)::int n, COALESCE(SUM(amount),0)::numeric total
         FROM withdrawals GROUP BY status`
    );
    const byStatus = { all: 0, pending: 0, approved: 0, rejected: 0 };
    let pendingTotal = 0;
    counts.rows.forEach((c) => {
      byStatus[c.status] = c.n;
      byStatus.all += c.n;
      if (c.status === 'pending') pendingTotal = Number(c.total);
    });

    res.json({
      withdrawals: r.rows.map((w) => ({
        ...serialize(w),
        merchant: {
          id: w.merchant_id,
          name: w.merchant_name,
          username: w.merchant_username,
          email: w.merchant_email,
          wallet_balance: Number(w.merchant_balance),
        },
      })),
      counts: byStatus,
      pending_total: pendingTotal,
    });
  } catch (e) { next(e); }
}

/**
 * Lock a pending withdrawal for resolution. Returns the row, or sends the
 * response itself and returns null.
 */
async function lockPending(client, id, res) {
  if (!UUID_RE.test(String(id || ''))) {
    res.status(404).json({ error: 'Withdrawal not found' });
    return null;
  }
  const r = await client.query('SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [id]);
  if (r.rowCount === 0) {
    res.status(404).json({ error: 'Withdrawal not found' });
    return null;
  }
  if (r.rows[0].status !== 'pending') {
    // Already resolved — never double-refund or double-approve.
    // Field is `current_status`, not `status`: a client that merges the body
    // into its own response object would otherwise clobber the HTTP status.
    res.status(409).json({
      error: `This withdrawal is already ${r.rows[0].status}.`,
      code: 'already_resolved',
      current_status: r.rows[0].status,
    });
    return null;
  }
  return r.rows[0];
}

/* ─── POST /api/admin/withdrawals/:id/approve ───
 * body: { payout_reference?, admin_note? }
 * The money already left the wallet at request time; this only records that the
 * payout was made and closes the request.
 */
async function approve(req, res, next) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const w = await lockPending(client, req.params.id, res);
    if (!w) { await client.query('ROLLBACK'); return; }

    const r = await client.query(
      `UPDATE withdrawals
          SET status = 'approved', resolved_at = NOW(), resolved_by = $2,
              payout_reference = $3, admin_note = $4
        WHERE id = $1 AND status = 'pending'
        RETURNING *`,
      [w.id, req.admin?.username || 'admin',
       clean(req.body?.payout_reference, 120) || null,
       clean(req.body?.admin_note, 500) || null]
    );
    await client.query('COMMIT');
    res.json({ ok: true, withdrawal: serialize(r.rows[0]) });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    next(e);
  } finally {
    client.release();
  }
}

/* ─── POST /api/admin/withdrawals/:id/reject ───
 * body: { admin_note }   (reason — the merchant sees it)
 * Refunds the held amount back to the merchant's wallet.
 */
async function reject(req, res, next) {
  const client = await pool.connect();
  try {
    const reason = clean(req.body?.admin_note, 500);
    if (reason.length < 2) return res.status(400).json({ error: 'A reason is required — the merchant sees it.' });

    await client.query('BEGIN');
    const w = await lockPending(client, req.params.id, res);
    if (!w) { await client.query('ROLLBACK'); return; }

    // Give the money back.
    const ledger = await client.query(
      `INSERT INTO wallet_ledger (merchant_id, amount, kind, note)
       VALUES ($1, $2, 'withdrawal_refund', $3) RETURNING id`,
      [w.merchant_id, Number(w.amount), `Withdrawal rejected — ${reason}`]
    );
    await client.query(
      'UPDATE merchants SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
      [Number(w.amount), w.merchant_id]
    );

    const r = await client.query(
      `UPDATE withdrawals
          SET status = 'rejected', resolved_at = NOW(), resolved_by = $2,
              admin_note = $3, refund_ledger_id = $4
        WHERE id = $1 AND status = 'pending'
        RETURNING *`,
      [w.id, req.admin?.username || 'admin', reason, ledger.rows[0].id]
    );

    await client.query('COMMIT');
    res.json({ ok: true, withdrawal: serialize(r.rows[0]), refunded: Number(w.amount) });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    next(e);
  } finally {
    client.release();
  }
}

module.exports = { create, listForMerchant, listForAdmin, approve, reject };
