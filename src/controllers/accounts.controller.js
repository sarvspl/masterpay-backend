const pool = require('../db/pool');
const { generateDeviceAuthKey } = require('../utils/keys');
const { getPlatformSettings, recordPlatformRevenue } = require('../services/wallet');

// Fee to unlock an *additional* account's device key — a flat 50% of the
// one-time key-unlock fee. The Primary account is covered by the full fee
// (POST /api/merchant/keys/unlock).
function extraAccountFee(fullFee) {
  return Math.round(Number(fullFee || 0) * 50) / 100; // 50%, 2dp
}

// Gateway columns surfaced under each account.
const GATEWAY_COLS = `id, provider, variant, account_number, label,
  min_amount, max_amount, charge_value, charge_type,
  discount_value, discount_type, balance_check, is_enabled,
  created_at, updated_at`;

// Map a `window` query param to a safe SQL time predicate. Keys are fixed
// strings, so the resulting clause never contains user-controlled text.
function windowClause(window, col = 't.created_at') {
  switch (String(window || '').toLowerCase()) {
    case 'today':
    case '1d': return `AND ${col} >= NOW() - INTERVAL '1 day'`;
    case '7d': return `AND ${col} >= NOW() - INTERVAL '7 days'`;
    case '30d': return `AND ${col} >= NOW() - INTERVAL '30 days'`;
    default:   return ''; // lifetime / unrecognized → no filter
  }
}

/* ─── GET /api/merchant/accounts ───
 * Accounts + their gateways. The device_auth_key is masked (null) until that
 * account is unlocked. The Primary account follows the merchant-level unlock
 * (the full key-unlock fee); extra accounts unlock for 50%.
 */
async function list(req, res, next) {
  try {
    const settings = await getPlatformSettings().catch(() => ({ key_unlock_fee: 0 }));
    const fullFee = Number(settings.key_unlock_fee || 0);
    const gateDisabled = fullFee <= 0;

    const a = await pool.query(
      `SELECT id, label, device_auth_key, keys_unlocked, is_default, created_at
         FROM accounts
        WHERE merchant_id = $1
        ORDER BY is_default DESC, created_at ASC`,
      [req.merchant.id]
    );

    const g = await pool.query(
      `SELECT ${GATEWAY_COLS}, account_id
         FROM gateways
        WHERE merchant_id = $1
        ORDER BY created_at ASC`,
      [req.merchant.id]
    );
    const gatewaysByAccount = {};
    for (const row of g.rows) {
      (gatewaysByAccount[row.account_id] ||= []).push(row);
    }

    // Per-account stats: count + sum of *successful* verifications received via
    // the account's gateways, scoped to the chosen window.
    const stats = await pool.query(
      `SELECT g.account_id,
              COUNT(*) FILTER (WHERE t.status = 'success')::int                       AS txn_count,
              COALESCE(SUM(t.amount) FILTER (WHERE t.status = 'success'), 0)::numeric AS txn_total
         FROM transactions t
         JOIN gateways g ON g.id = t.gateway_id
        WHERE t.merchant_id = $1 ${windowClause(req.query.window)}
        GROUP BY g.account_id`,
      [req.merchant.id]
    );
    const statsByAccount = {};
    for (const row of stats.rows) {
      statsByAccount[row.account_id] = { txn_count: row.txn_count, txn_total: Number(row.txn_total) };
    }

    const accounts = a.rows.map((acc) => {
      const unlocked = acc.keys_unlocked || gateDisabled;
      const s = statsByAccount[acc.id] || { txn_count: 0, txn_total: 0 };
      return {
        id: acc.id,
        label: acc.label,
        is_default: acc.is_default,
        keys_unlocked: unlocked,
        device_auth_key: unlocked ? acc.device_auth_key : null,
        created_at: acc.created_at,
        gateways: gatewaysByAccount[acc.id] || [],
        txn_count: s.txn_count,
        txn_total: s.txn_total,
      };
    });

    res.json({
      accounts,
      key_unlock_fee: fullFee,
      extra_account_fee: extraAccountFee(fullFee),
      currency: settings.verify_charge_currency || null,
      window: String(req.query.window || 'all').toLowerCase(),
    });
  } catch (e) { next(e); }
}

/* ─── POST /api/merchant/accounts ───
 * Create a new (locked) account with its own device key. Free — only unlocking
 * costs. body: { label? }
 */
async function create(req, res, next) {
  try {
    const label = String(req.body.label || '').trim();

    const count = await pool.query(
      'SELECT COUNT(*)::int AS n FROM accounts WHERE merchant_id = $1',
      [req.merchant.id]
    );
    const finalLabel = label || `Account ${count.rows[0].n + 1}`;

    // Generate a unique device key (retry on the rare UNIQUE collision).
    let row;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const r = await pool.query(
          `INSERT INTO accounts (merchant_id, label, device_auth_key, keys_unlocked, is_default)
           VALUES ($1, $2, $3, FALSE, FALSE)
           RETURNING id, label, device_auth_key, keys_unlocked, is_default, created_at`,
          [req.merchant.id, finalLabel, generateDeviceAuthKey()]
        );
        row = r.rows[0];
        break;
      } catch (e) {
        if (e.code === '23505' && attempt < 4) continue; // device_auth_key collision — retry
        throw e;
      }
    }

    // Brand-new account is locked → device key masked, no gateways yet.
    res.status(201).json({
      account: {
        id: row.id,
        label: row.label,
        is_default: row.is_default,
        keys_unlocked: false,
        device_auth_key: null,
        created_at: row.created_at,
        gateways: [],
      },
    });
  } catch (e) { next(e); }
}

/* ─── POST /api/merchant/accounts/:id/unlock ───
 * Unlock an additional account's device key for a flat 50% of the key-unlock
 * fee, paid from the wallet. The Primary account is unlocked via the
 * merchant-level full-fee flow (POST /api/merchant/keys/unlock) instead.
 */
async function unlock(req, res, next) {
  const client = await pool.connect();
  try {
    const settings = await getPlatformSettings().catch(() => ({ key_unlock_fee: 0, verify_charge_currency: 'BDT' }));
    const fullFee = Number(settings.key_unlock_fee || 0);
    const fee = extraAccountFee(fullFee);

    await client.query('BEGIN');
    const a = await client.query(
      `SELECT a.id, a.is_default, a.keys_unlocked, a.device_auth_key,
              m.id AS merchant_id, m.wallet_balance, m.currency
         FROM accounts a
         JOIN merchants m ON m.id = a.merchant_id
        WHERE a.id = $1 AND a.merchant_id = $2
        FOR UPDATE OF m`,
      [req.params.id, req.merchant.id]
    );
    if (a.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Account not found' }); }
    const acc = a.rows[0];

    if (acc.is_default) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Unlock the primary account from the integration-keys flow.', code: 'primary_account' });
    }

    // Already unlocked, or the gate is disabled (fee 0) → just reveal the key.
    if (acc.keys_unlocked || fullFee <= 0) {
      if (!acc.keys_unlocked) {
        await client.query('UPDATE accounts SET keys_unlocked = TRUE WHERE id = $1', [acc.id]);
      }
      await client.query('COMMIT');
      return res.json({ keys_unlocked: true, device_auth_key: acc.device_auth_key });
    }

    const balance = Number(acc.wallet_balance);
    if (balance < fee) {
      await client.query('ROLLBACK');
      return res.status(402).json({
        error: 'Insufficient wallet balance to unlock this account.',
        code: 'insufficient_balance',
        balance, fee,
      });
    }

    await client.query(
      `UPDATE merchants SET wallet_balance = wallet_balance - $1, updated_at = NOW() WHERE id = $2`,
      [fee, acc.merchant_id]
    );
    await client.query('UPDATE accounts SET keys_unlocked = TRUE WHERE id = $1', [acc.id]);
    await client.query(
      `INSERT INTO wallet_ledger (merchant_id, amount, kind, note)
       VALUES ($1, $2, 'key_unlock', $3)`,
      [acc.merchant_id, -fee, `Account unlock: ${acc.id}`]
    );
    await recordPlatformRevenue(client, {
      type: 'key_unlock',
      amount: fee,
      currency: settings.verify_charge_currency || acc.currency || 'BDT',
      merchantId: acc.merchant_id,
      note: 'Additional account unlock',
    });
    await client.query('COMMIT');

    res.json({
      keys_unlocked: true,
      device_auth_key: acc.device_auth_key,
      balance: balance - fee,
      fee,
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    next(e);
  } finally {
    client.release();
  }
}

/* ─── DELETE /api/merchant/accounts/:id ───
 * Remove a non-primary account. Its gateways + devices cascade away. The
 * paid unlock fee is not refunded.
 */
async function remove(req, res, next) {
  try {
    const r = await pool.query(
      `DELETE FROM accounts
        WHERE id = $1 AND merchant_id = $2 AND is_default = FALSE
        RETURNING id`,
      [req.params.id, req.merchant.id]
    );
    if (r.rowCount === 0) {
      return res.status(400).json({ error: 'Cannot delete this account. It either does not exist or is the primary account.' });
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
}

module.exports = { list, create, unlock, remove, extraAccountFee };
