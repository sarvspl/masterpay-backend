/**
 * Vendor panel — a vendor (an `accounts` row under a merchant) logging into
 * their OWN dashboard. Authenticated by a vendor JWT (role 'vendor', sub =
 * account id), issued here and verified by middleware/auth.js → requireVendor.
 *
 * Onboarding is self-service: the vendor proves ownership with the PV-XXXX
 * device_auth_key the marketplace gave them, then sets a username + password.
 *
 * Everything else a vendor does (transactions, gateways, devices) reuses the
 * existing merchant controllers, scoped to req.vendor.account_id by the routes.
 */
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { sign } = require('../utils/jwt');
const { getPlatformSettings } = require('../services/wallet');

const USERNAME_RE = /^[a-z0-9_]{3,40}$/;

// Same window→SQL mapping the accounts controller uses, kept local so the two
// don't couple.
function windowClause(window, col = 't.created_at') {
  switch (String(window || '').toLowerCase()) {
    case 'today':
    case '1d': return `AND ${col} >= NOW() - INTERVAL '1 day'`;
    case '7d': return `AND ${col} >= NOW() - INTERVAL '7 days'`;
    case '30d': return `AND ${col} >= NOW() - INTERVAL '30 days'`;
    default:   return '';
  }
}

// Is this account allowed to reveal its device key? Either it's unlocked, or the
// platform-wide key-unlock fee is disabled (0). Mirrors the merchant rule.
async function keyVisible(keysUnlocked) {
  if (keysUnlocked) return true;
  const settings = await getPlatformSettings().catch(() => ({ key_unlock_fee: 0 }));
  return Number(settings.key_unlock_fee || 0) <= 0;
}

/* ─── POST /api/vendor/register ───
 * Body: { device_auth_key, username, password }
 * Claims a vendor login for the account that owns `device_auth_key`.
 */
async function register(req, res, next) {
  try {
    const deviceKey = String(req.body.device_auth_key || '').trim();
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!deviceKey) return res.status(400).json({ error: 'Vendor (device) code is required' });
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Username must be 3–40 lowercase letters, numbers, or underscores' });
    }
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const a = await pool.query(
      `SELECT a.id, a.label, a.is_default, a.username, m.is_suspended, m.suspended_reason
         FROM accounts a
         JOIN merchants m ON m.id = a.merchant_id
        WHERE a.device_auth_key = $1`,
      [deviceKey]
    );
    if (a.rowCount === 0) return res.status(404).json({ error: 'No vendor found for that code. Check the code your marketplace gave you.' });
    const acc = a.rows[0];

    if (acc.is_default) {
      return res.status(400).json({ error: 'This code belongs to the marketplace’s primary account. Use the merchant dashboard to sign in.' });
    }
    if (acc.is_suspended) {
      return res.status(403).json({
        error: acc.suspended_reason
          ? `This marketplace account is suspended: ${acc.suspended_reason}`
          : 'This marketplace account is suspended. Contact the marketplace operator.',
        suspended: true,
      });
    }
    if (acc.username) {
      return res.status(409).json({ error: 'This vendor already has a login. Sign in instead.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    let row;
    try {
      const r = await pool.query(
        `UPDATE accounts SET username = $2, password_hash = $3, last_login_at = NOW()
          WHERE id = $1 AND username IS NULL
          RETURNING id, username, label`,
        [acc.id, username, passwordHash]
      );
      if (r.rowCount === 0) return res.status(409).json({ error: 'This vendor already has a login. Sign in instead.' });
      row = r.rows[0];
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Username is already taken', field: 'username' });
      throw e;
    }

    const token = sign({ sub: row.id, username: row.username, role: 'vendor' });
    res.status(201).json({ token, vendor: { id: row.id, username: row.username, label: row.label } });
  } catch (e) { next(e); }
}

/* ─── POST /api/vendor/login ─── Body: { username, password } */
async function login(req, res, next) {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });

    const r = await pool.query(
      `SELECT a.id, a.username, a.password_hash, a.label, m.is_suspended, m.suspended_reason
         FROM accounts a
         JOIN merchants m ON m.id = a.merchant_id
        WHERE a.username = $1`,
      [username]
    );
    if (r.rowCount === 0 || !r.rows[0].password_hash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const ok = await bcrypt.compare(password, r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    if (r.rows[0].is_suspended) {
      return res.status(403).json({
        error: r.rows[0].suspended_reason
          ? `This marketplace account is suspended: ${r.rows[0].suspended_reason}`
          : 'This marketplace account is suspended. Contact the marketplace operator.',
        suspended: true,
      });
    }

    await pool.query('UPDATE accounts SET last_login_at = NOW() WHERE id = $1', [r.rows[0].id]);
    const token = sign({ sub: r.rows[0].id, username: r.rows[0].username, role: 'vendor' });
    res.json({ token });
  } catch (e) { next(e); }
}

/* ─── GET /api/vendor/me ───
 * The vendor's profile + headline stats, scoped to their account.
 */
async function me(req, res, next) {
  try {
    const accountId = req.vendor.account_id;

    const a = await pool.query(
      `SELECT a.id, a.label, a.username, a.is_default, a.keys_unlocked, a.device_auth_key,
              a.created_at, a.last_login_at,
              m.name AS merchant_name, m.currency
         FROM accounts a
         JOIN merchants m ON m.id = a.merchant_id
        WHERE a.id = $1`,
      [accountId]
    );
    if (a.rowCount === 0) return res.status(404).json({ error: 'Vendor not found' });
    const acc = a.rows[0];

    const visible = await keyVisible(acc.keys_unlocked);

    // Successful-verification count + sum on this vendor's gateways, for the
    // requested window (mirrors the merchant accounts stats).
    const stats = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE t.status = 'success')::int                       AS txn_count,
              COALESCE(SUM(t.amount) FILTER (WHERE t.status = 'success'), 0)::numeric AS txn_total,
              COUNT(*) FILTER (WHERE t.status = 'pending')::int                       AS pending_count
         FROM transactions t
         JOIN gateways g ON g.id = t.gateway_id
        WHERE g.account_id = $1 ${windowClause(req.query.window)}`,
      [accountId]
    );
    const gw = await pool.query(
      `SELECT COUNT(*)::int AS n FROM gateways WHERE account_id = $1 AND is_enabled = TRUE`,
      [accountId]
    );
    const dev = await pool.query(
      `SELECT COUNT(*)::int AS n FROM devices WHERE account_id = $1 AND unbound_at IS NULL`,
      [accountId]
    );

    res.json({
      vendor: {
        id:              acc.id,
        label:           acc.label,
        username:        acc.username,
        merchant_name:   acc.merchant_name,
        currency:        acc.currency || 'BDT',
        keys_unlocked:   visible,
        device_auth_key: visible ? acc.device_auth_key : null,
        created_at:      acc.created_at,
        last_login_at:   acc.last_login_at,
        gateway_count:   gw.rows[0].n,
        device_count:    dev.rows[0].n,
        txn_count:       stats.rows[0].txn_count,
        txn_total:       Number(stats.rows[0].txn_total),
        pending_count:   stats.rows[0].pending_count,
      },
      window: String(req.query.window || 'all').toLowerCase(),
    });
  } catch (e) { next(e); }
}

/* ─── POST /api/vendor/me/password ─── Body: { current_password, new_password } */
async function changePassword(req, res, next) {
  try {
    const current = String(req.body.current_password || '');
    const next = String(req.body.new_password || '');
    if (!current || !next) return res.status(400).json({ error: 'Both current and new password are required' });
    if (next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
    if (current === next) return res.status(400).json({ error: 'New password must be different from current password' });

    const r = await pool.query('SELECT password_hash FROM accounts WHERE id = $1', [req.vendor.account_id]);
    if (r.rowCount === 0 || !r.rows[0].password_hash) return res.status(404).json({ error: 'Vendor not found' });

    const ok = await bcrypt.compare(current, r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect', field: 'current_password' });

    const newHash = await bcrypt.hash(next, 10);
    await pool.query('UPDATE accounts SET password_hash = $1 WHERE id = $2', [newHash, req.vendor.account_id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
}

module.exports = { register, login, me, changePassword };
