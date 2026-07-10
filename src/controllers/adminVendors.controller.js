/**
 * Super-admin view of a single vendor.
 *
 * The marketplace operator deliberately cannot see a vendor's device key,
 * transactions, or wallet (see merchant.routes.js). The admin is the escalation
 * path: when a seller says "my payment never arrived" or "I'm locked out", this
 * is where support looks — and where they can top up a wallet or reset a
 * password on the seller's behalf.
 *
 * Everything here is read-only except:
 *   POST /api/admin/vendors/:id/wallet          — credit / debit the wallet
 *   POST /api/admin/vendors/:id/reset-password  — set or generate a password
 */
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A vendor is a non-Primary account. Primary belongs to the merchant itself and
// must never be reachable through these endpoints.
async function loadVendor(id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  const r = await pool.query(
    `SELECT a.id, a.label, a.username, a.external_id, a.device_auth_key,
            a.keys_unlocked, a.activated_at, a.activation_fee, a.wallet_balance,
            a.last_login_at, a.created_at,
            a.merchant_id, m.name AS merchant_name, m.username AS merchant_username,
            m.is_suspended AS merchant_suspended
       FROM accounts a
       JOIN merchants m ON m.id = a.merchant_id
      WHERE a.id = $1 AND a.is_default = FALSE`,
    [id]
  );
  return r.rows[0] || null;
}

/* ─── GET /api/admin/vendors/:id ─── */
async function getVendor(req, res, next) {
  try {
    const v = await loadVendor(req.params.id);
    if (!v) return res.status(404).json({ error: 'Vendor not found' });

    const [gateways, devices, txns, ledger, platformPayments] = await Promise.all([
      pool.query(
        `SELECT id, provider, variant, account_number, label, is_enabled,
                min_amount, max_amount, charge_value, charge_type,
                discount_value, discount_type, created_at
           FROM gateways WHERE account_id = $1 ORDER BY created_at ASC`,
        [v.id]
      ),
      pool.query(
        `SELECT id, device_id, model, manufacturer, binder_name, telegram_handle, whatsapp,
                last_seen_at, created_at, unbound_at
           FROM devices WHERE account_id = $1 ORDER BY created_at DESC`,
        [v.id]
      ),
      // Payments this vendor RECEIVED from customers.
      pool.query(
        `SELECT t.id, t.txnid_submitted, t.amount, t.status, t.result_source,
                t.sender_account, t.failure_reason, t.verified_at, t.created_at,
                g.provider, g.variant, g.account_number,
                s.order_id
           FROM transactions t
           JOIN gateways g ON g.id = t.gateway_id
           LEFT JOIN payment_sessions s ON s.id = t.session_id
          WHERE g.account_id = $1
          ORDER BY t.created_at DESC
          LIMIT 50`,
        [v.id]
      ),
      pool.query(
        `SELECT id, amount, kind, note, created_at
           FROM wallet_ledger WHERE account_id = $1
          ORDER BY created_at DESC LIMIT 50`,
        [v.id]
      ),
      // Payments this vendor MADE to the platform (activation + top-ups).
      pool.query(
        `SELECT id, amount, status, txnid_submitted, created_at, verified_at,
                (activation_account_id IS NOT NULL) AS is_activation
           FROM transactions
          WHERE activation_account_id = $1 OR vendor_topup_account_id = $1
          ORDER BY created_at DESC LIMIT 50`,
        [v.id]
      ),
    ]);

    res.json({
      vendor: {
        id: v.id,
        label: v.label,
        username: v.username,
        has_login: v.username != null,
        external_id: v.external_id,
        device_auth_key: v.device_auth_key,   // admin only — never sent to the merchant
        keys_unlocked: v.keys_unlocked,
        is_activated: v.activated_at != null,
        activated_at: v.activated_at,
        activation_fee: Number(v.activation_fee || 0),
        wallet_balance: Number(v.wallet_balance || 0),
        last_login_at: v.last_login_at,
        created_at: v.created_at,
        merchant: {
          id: v.merchant_id,
          name: v.merchant_name,
          username: v.merchant_username,
          is_suspended: v.merchant_suspended,
        },
        gateways: gateways.rows,
        devices: devices.rows,
        transactions: txns.rows,
        ledger: ledger.rows,
        platform_payments: platformPayments.rows,
      },
    });
  } catch (e) { next(e); }
}

/* ─── POST /api/admin/vendors/:id/wallet ───
 * body: { amount, note? }  — a CREDIT only. `amount` must be positive.
 *
 * Deliberately one-directional. An admin may add balance (a top-up that never
 * auto-matched, a refund, comping a new seller) but may never take it away: a
 * mis-typed debit would empty a seller's wallet mid-trading and knock them
 * offline at checkout. To claw money back, debit through the normal fee path or
 * suspend the marketplace.
 *
 * No money is collected here and no platform revenue is booked — this creates
 * spendable balance. The ledger row is the only trace, and the vendor sees it.
 */
async function creditVendorWallet(req, res, next) {
  const client = await pool.connect();
  try {
    const amount = Number(req.body && req.body.amount);
    const note = String((req.body && req.body.note) || '').slice(0, 500) || 'Admin top-up';

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number — wallets can only be topped up, not debited' });
    }
    if (amount > 10_000_000) {
      return res.status(400).json({ error: 'amount out of range' });
    }
    if (!UUID_RE.test(String(req.params.id || ''))) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    await client.query('BEGIN');

    const a = await client.query(
      `SELECT id, merchant_id, wallet_balance FROM accounts
        WHERE id = $1 AND is_default = FALSE FOR UPDATE`,
      [req.params.id]
    );
    if (a.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Vendor not found' });
    }

    // account_id is what scopes this row to the vendor's own ledger; merchant_id
    // is still stamped because the column is NOT NULL.
    const ledger = await client.query(
      `INSERT INTO wallet_ledger (merchant_id, account_id, amount, kind, note)
       VALUES ($1, $2, $3, 'adjustment', $4)
       RETURNING id, amount, kind, note, created_at`,
      [a.rows[0].merchant_id, a.rows[0].id, amount, note]
    );
    const upd = await client.query(
      `UPDATE accounts SET wallet_balance = wallet_balance + $1 WHERE id = $2
       RETURNING wallet_balance`,
      [amount, a.rows[0].id]
    );

    await client.query('COMMIT');
    res.json({
      ok: true,
      vendor_id: a.rows[0].id,
      balance: Number(upd.rows[0].wallet_balance),
      ledger: ledger.rows[0],
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    next(e);
  } finally {
    client.release();
  }
}

/* ─── POST /api/admin/vendors/:id/reset-password ───
 * body: { new_password? } — omit to have one generated. Returned ONCE, never stored.
 */
async function resetVendorPassword(req, res, next) {
  try {
    const v = await loadVendor(req.params.id);
    if (!v) return res.status(404).json({ error: 'Vendor not found' });
    if (!v.username) {
      // No panel login exists yet — the seller has never registered, so there's
      // no password to reset. They claim the account with their device key.
      return res.status(400).json({
        error: 'This vendor has not registered a panel login yet. They claim it with their device key at /vendor/register.',
        code: 'no_login',
      });
    }

    let supplied = req.body && req.body.new_password ? String(req.body.new_password) : null;
    const generated = !supplied;

    if (supplied != null && supplied.length < 6) {
      return res.status(400).json({ error: 'new_password must be at least 6 characters' });
    }
    if (!supplied) {
      const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; // no 0/O/1/l
      supplied = '';
      for (let i = 0; i < 12; i++) supplied += alpha[Math.floor(Math.random() * alpha.length)];
    }

    const hash = await bcrypt.hash(supplied, 10);
    const r = await pool.query(
      `UPDATE accounts SET password_hash = $1 WHERE id = $2 AND is_default = FALSE
       RETURNING id, username, label`,
      [hash, v.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Vendor not found' });

    res.json({ ok: true, password: supplied, generated, vendor: r.rows[0] });
  } catch (e) { next(e); }
}

module.exports = { getVendor, creditVendorWallet, resetVendorPassword };
