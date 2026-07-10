/**
 * Merchant → vendor wallet transfer.
 *
 * "Riya gave me 500 in cash, put it on her wallet." The merchant's balance goes
 * down, the vendor's goes up, and no money crosses the platform boundary. The
 * sum of all wallets is unchanged.
 *
 * Credit only. A merchant may add to a vendor's wallet, never subtract: an
 * accidental debit would empty a trading seller's wallet and silently drop them
 * out of every checkout (`vendor_wallet_empty`), with nothing they could do.
 * To move money back, the vendor withdraws it or the admin adjusts it.
 */
const pool = require('../db/pool');
const { isVendorAccount } = require('../services/vendors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AMOUNT = 10_000_000;

/* ─── POST /api/merchant/accounts/:id/topup ───
 * body: { amount, note? }
 */
async function topupVendor(req, res, next) {
  const client = await pool.connect();
  try {
    const amount = Number(req.body && req.body.amount);
    const note = String((req.body && req.body.note) || '').trim().slice(0, 300) || 'Wallet top-up from marketplace';

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number — a merchant can only add to a vendor’s wallet, not take from it' });
    }
    if (amount > MAX_AMOUNT) return res.status(400).json({ error: 'amount out of range' });
    if (!UUID_RE.test(String(req.params.id || ''))) return res.status(404).json({ error: 'Vendor not found' });

    // The target must be one of THIS merchant's vendors — never their own
    // Primary account, and never another marketplace's seller.
    if (!(await isVendorAccount(req.params.id))) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    await client.query('BEGIN');

    // Lock merchant first, then the account. Consistent ordering everywhere in
    // this file, so two concurrent transfers can never deadlock each other.
    const m = await client.query(
      'SELECT id, wallet_balance, currency FROM merchants WHERE id = $1 FOR UPDATE',
      [req.merchant.id]
    );
    if (m.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Merchant not found' }); }

    const v = await client.query(
      `SELECT id, label, wallet_balance FROM accounts
        WHERE id = $1 AND merchant_id = $2 AND is_default = FALSE FOR UPDATE`,
      [req.params.id, req.merchant.id]
    );
    if (v.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Vendor not found' }); }

    const balance = Number(m.rows[0].wallet_balance);
    if (amount > balance) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `You only have ${balance.toFixed(2)} in your wallet.`,
        code: 'insufficient_balance',
        balance,
      });
    }

    const vendor = v.rows[0];
    const currency = m.rows[0].currency || 'BDT';

    // Debit the merchant.
    const outLedger = await client.query(
      `INSERT INTO wallet_ledger (merchant_id, amount, kind, note)
       VALUES ($1, $2, 'vendor_transfer_out', $3) RETURNING id`,
      [req.merchant.id, -amount, `Wallet top-up to ${vendor.label} — ${note}`]
    );
    await client.query(
      'UPDATE merchants SET wallet_balance = wallet_balance - $1, updated_at = NOW() WHERE id = $2',
      [amount, req.merchant.id]
    );

    // Credit the vendor. account_id is what scopes the row to their own ledger.
    const inLedger = await client.query(
      `INSERT INTO wallet_ledger (merchant_id, account_id, amount, kind, note)
       VALUES ($1, $2, $3, 'vendor_transfer_in', $4) RETURNING id`,
      [req.merchant.id, vendor.id, amount, note]
    );
    await client.query(
      'UPDATE accounts SET wallet_balance = wallet_balance + $1 WHERE id = $2',
      [amount, vendor.id]
    );

    const t = await client.query(
      `INSERT INTO vendor_transfers
         (merchant_id, account_id, amount, currency, note, merchant_ledger_id, vendor_ledger_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, amount, currency, note, created_at`,
      [req.merchant.id, vendor.id, amount, currency, note, outLedger.rows[0].id, inLedger.rows[0].id]
    );

    await client.query('COMMIT');
    res.status(201).json({
      ok: true,
      transfer: t.rows[0],
      vendor: { id: vendor.id, label: vendor.label },
      // Only the MERCHANT's own new balance is returned. A vendor's balance is
      // their business — the operator never sees it (see accounts.controller).
      merchant_balance: balance - amount,
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    next(e);
  } finally {
    client.release();
  }
}

/* ─── GET /api/merchant/transfers ───
 * The merchant's own history of money they've put on their vendors' wallets.
 */
async function listForMerchant(req, res, next) {
  try {
    const r = await pool.query(
      `SELECT t.id, t.amount, t.currency, t.note, t.created_at,
              a.label AS vendor_label, a.external_id AS vendor_external_id, a.id AS vendor_id
         FROM vendor_transfers t JOIN accounts a ON a.id = t.account_id
        WHERE t.merchant_id = $1
        ORDER BY t.created_at DESC
        LIMIT 100`,
      [req.merchant.id]
    );
    res.json({ transfers: r.rows.map((t) => ({ ...t, amount: Number(t.amount) })) });
  } catch (e) { next(e); }
}

module.exports = { topupVendor, listForMerchant };
