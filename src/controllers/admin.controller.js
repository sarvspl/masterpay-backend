const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { sign } = require('../utils/jwt');
const {
  generateApiKey,
  generateSecretKey,
  generateDeviceAuthKey,
  maskKey,
} = require('../utils/keys');
const { generateUniqueUsername } = require('../utils/username');
const { currencyForCountry } = require('../utils/currency');
const { COOKIE_NAMES, setSessionCookie, clearSessionCookie } = require('../utils/cookies');

const USERNAME_RE = /^[a-z0-9_]{3,40}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function login(req, res, next) {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password required' });
    }
    const { rows } = await pool.query(
      'SELECT id, username, password_hash FROM admins WHERE username = $1',
      [username]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = sign({ sub: rows[0].id, username: rows[0].username, role: 'admin' });
    setSessionCookie(res, COOKIE_NAMES.admin, token);
    res.json({ token });
  } catch (e) {
    next(e);
  }
}

// Clear the admin session cookie. No auth required so an expired/invalid
// session can still be cleared cleanly.
function logout(req, res) {
  clearSessionCookie(res, COOKIE_NAMES.admin);
  res.json({ ok: true });
}

async function listMerchants(req, res, next) {
  try {
    const limit  = Math.min(200, Math.max(1, Number(req.query.limit) || 20));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const q      = req.query.q ? String(req.query.q).trim().toLowerCase() : null;
    const filter = ['active', 'suspended'].includes(req.query.filter) ? req.query.filter : 'all';

    const where  = ['m.is_platform = FALSE'];
    const params = [];

    if (q) {
      params.push(`%${q}%`);
      where.push(`(
        LOWER(m.name) LIKE $${params.length} OR
        LOWER(m.username) LIKE $${params.length} OR
        LOWER(m.email) LIKE $${params.length} OR
        LOWER(m.domain) LIKE $${params.length} OR
        LOWER(m.mobile) LIKE $${params.length}
      )`);
    }

    // Two WHERE clauses on purpose.
    //
    // The LIST honours the status filter. The STATS must NOT: they feed the
    // "All / Active / Suspended" chips and the stat cards. If the stats were
    // filtered too, viewing "Active" would show "Suspended 0" even when
    // suspended merchants exist — the chip would hide the very rows it exists
    // to reveal. Search still narrows both, which is what an admin expects.
    const statsWhereSql = `WHERE ${where.join(' AND ')}`;

    const listWhere = [...where];
    if (filter === 'active')    listWhere.push('m.is_suspended = FALSE');
    if (filter === 'suspended') listWhere.push('m.is_suspended = TRUE');
    const whereSql = `WHERE ${listWhere.join(' AND ')}`;

    const statsR = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE m.is_suspended = FALSE)::int AS active,
              COUNT(*) FILTER (WHERE m.is_suspended = TRUE)::int  AS suspended,
              COALESCE(SUM(m.wallet_balance), 0)::numeric         AS wallet_sum
         FROM merchants m
         ${statsWhereSql}`,
      params
    );
    const stats = {
      total:      statsR.rows[0].total,
      active:     statsR.rows[0].active,
      suspended:  statsR.rows[0].suspended,
      wallet_sum: Number(statsR.rows[0].wallet_sum),
    };

    const pageParams = [...params, limit, offset];
    const { rows } = await pool.query(
      `SELECT m.id, m.name, m.username, m.mobile, m.email, m.domain, m.industry, m.country, m.state,
              m.currency, m.wallet_balance, m.is_suspended, m.suspended_at, m.suspended_reason, m.created_at,
              k.device_auth_key,
              b.api_key AS default_api_key,
              (SELECT COUNT(*) FROM brands WHERE merchant_id = m.id) AS brand_count
         FROM merchants m
         JOIN merchant_keys k ON k.merchant_id = m.id
         LEFT JOIN brands b ON b.merchant_id = m.id AND b.is_default = TRUE
         ${whereSql}
        ORDER BY m.created_at DESC
        LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
      pageParams
    );
    const merchants = rows.map((r) => ({
      ...r,
      brand_count: Number(r.brand_count) || 0,
      api_key_masked: maskKey(r.default_api_key, 4),
      device_auth_key_masked: maskKey(r.device_auth_key, 4),
      default_api_key: undefined,
      device_auth_key: undefined,
    }));
    // Pagination total = rows matching the LIST filter, not the stat cards
    // (which are deliberately unfiltered). The three counts already partition
    // the searched set, so this needs no extra query.
    const total = filter === 'active'    ? stats.active
                : filter === 'suspended' ? stats.suspended
                : stats.total;

    res.json({ merchants, total, limit, offset, stats });
  } catch (e) {
    next(e);
  }
}

async function getMerchant(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.name, m.username, m.mobile, m.email, m.domain, m.industry, m.country, m.state,
              m.currency, m.wallet_balance, m.is_suspended, m.suspended_at, m.suspended_reason, m.created_at,
              k.device_auth_key,
              b.api_key AS default_api_key
         FROM merchants m
         JOIN merchant_keys k ON k.merchant_id = m.id
         LEFT JOIN brands b ON b.merchant_id = m.id AND b.is_default = TRUE
        WHERE m.id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Merchant not found' });
    const r = rows[0];

    const brandsRes = await pool.query(
      `SELECT id, name, domain, api_key, is_default, created_at
         FROM brands WHERE merchant_id = $1 ORDER BY is_default DESC, created_at ASC`,
      [req.params.id]
    );
    const brands = brandsRes.rows.map((b) => ({
      ...b,
      api_key_masked: maskKey(b.api_key, 4),
      api_key: undefined,
    }));

    // No devices are returned here. A merchant binds no phone — every device
    // belongs to one of its vendors, and a vendor's phones (with the binder's
    // name / Telegram / WhatsApp) are shown under that vendor, on
    // GET /api/admin/vendors/:id. Listing them under the merchant filed a
    // seller's contact details against the wrong owner.

    // Vendors = this merchant's non-Primary accounts, with headline status so
    // the admin can review the marketplace's sellers.
    const vendorsRes = await pool.query(
      `SELECT a.id, a.label, a.username, a.external_id, a.activated_at, a.wallet_balance, a.created_at,
              (SELECT COUNT(*)::int FROM gateways g WHERE g.account_id = a.id AND g.is_enabled = TRUE)                                   AS gateway_count,
              (SELECT COUNT(*)::int FROM devices dv WHERE dv.account_id = a.id AND dv.unbound_at IS NULL)                                AS device_count,
              (SELECT COUNT(*)::int      FROM transactions t JOIN gateways g2 ON g2.id = t.gateway_id WHERE g2.account_id = a.id AND t.status = 'success') AS txn_count,
              (SELECT COALESCE(SUM(t.amount),0)::numeric FROM transactions t JOIN gateways g2 ON g2.id = t.gateway_id WHERE g2.account_id = a.id AND t.status = 'success') AS txn_total,
              (SELECT COUNT(*)::int FROM transactions t WHERE (t.activation_account_id = a.id OR t.vendor_topup_account_id = a.id) AND t.status = 'pending') AS pending_payments
         FROM accounts a
        WHERE a.merchant_id = $1 AND a.is_default = FALSE
        ORDER BY a.created_at ASC`,
      [req.params.id]
    );
    const vendors = vendorsRes.rows.map((v) => ({
      id: v.id,
      label: v.label,
      username: v.username,
      external_id: v.external_id,
      has_login: v.username != null,
      is_activated: v.activated_at != null,
      activated_at: v.activated_at,
      wallet_balance: Number(v.wallet_balance || 0),
      gateway_count: v.gateway_count,
      device_count: v.device_count,
      txn_count: v.txn_count,
      txn_total: Number(v.txn_total || 0),
      pending_payments: v.pending_payments,
      created_at: v.created_at,
    }));

    res.json({
      merchant: {
        ...r,
        api_key_masked: maskKey(r.default_api_key, 4),
        default_api_key: undefined,
        // The Primary account's device_auth_key is not surfaced: a marketplace
        // has no phone to bind. Each vendor's key lives on their own record.
        device_auth_key: undefined,
        brands,
        vendors,
      },
    });
  } catch (e) {
    next(e);
  }
}

const REQUIRED_FIELDS = ['name', 'password', 'mobile', 'email', 'domain', 'industry', 'country', 'state'];

async function createMerchant(req, res, next) {
  try {
    const missing = REQUIRED_FIELDS.filter((f) => !req.body[f] || String(req.body[f]).trim() === '');
    if (missing.length) {
      return res.status(400).json({ error: `Missing fields: ${missing.join(', ')}` });
    }
    if (String(req.body.password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (!EMAIL_RE.test(String(req.body.email))) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    if (req.body.username && !USERNAME_RE.test(String(req.body.username))) {
      return res.status(400).json({ error: 'Username must be 3–40 lowercase letters, numbers, or underscores' });
    }

    const { name, password, mobile, email, domain, industry, country, state } = req.body;
    let username = req.body.username ? String(req.body.username).trim().toLowerCase() : null;

    if (username) {
      const exists = await pool.query('SELECT 1 FROM merchants WHERE username = $1', [username]);
      if (exists.rowCount > 0) return res.status(409).json({ error: 'Username is already taken', field: 'username' });
    } else {
      username = await generateUniqueUsername(name);
    }

    const emailExists = await pool.query('SELECT 1 FROM merchants WHERE LOWER(email) = LOWER($1)', [email]);
    if (emailExists.rowCount > 0) {
      return res.status(409).json({ error: 'Email is already registered', field: 'email' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const apiKey = generateApiKey();
    const secretKey = generateSecretKey();
    const deviceAuthKey = generateDeviceAuthKey();
    const currency = currencyForCountry(country);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const m = await client.query(
        `INSERT INTO merchants (name, username, password_hash, mobile, email, domain, industry, country, state, currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, name, username, mobile, email, domain, industry, country, state, currency, wallet_balance, created_at`,
        [name, username, passwordHash, mobile, email, domain, industry, country, state, currency]
      );
      const merchant = m.rows[0];
      await client.query(
        `INSERT INTO merchant_keys (merchant_id, device_auth_key) VALUES ($1, $2)`,
        [merchant.id, deviceAuthKey]
      );
      await client.query(
        `INSERT INTO brands (merchant_id, name, domain, api_key, secret_key, is_default)
         VALUES ($1, $2, $3, $4, $5, TRUE)`,
        [merchant.id, name, domain, apiKey, secretKey]
      );
      // Primary (domain) account — carries the device auth key + its gateways.
      // Unlock state mirrors merchants.keys_unlocked (default FALSE) so the
      // existing one-time-unlock gate is preserved for admin-created merchants.
      await client.query(
        `INSERT INTO accounts (merchant_id, label, device_auth_key, keys_unlocked, is_default)
         VALUES ($1, 'Primary', $2, FALSE, TRUE)`,
        [merchant.id, deviceAuthKey]
      );
      await client.query('COMMIT');

      res.status(201).json({
        merchant: { ...merchant, api_key: apiKey, device_auth_key: deviceAuthKey },
      });
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505') {
        return res.status(409).json({ error: 'Username, email, or key collision' });
      }
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    next(e);
  }
}

async function suspendMerchant(req, res, next) {
  try {
    const reason = req.body.reason ? String(req.body.reason).slice(0, 240) : null;
    const forceUnbind = req.body.force_unbind === true;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const r = await client.query(
        `UPDATE merchants
            SET is_suspended = TRUE,
                suspended_at = NOW(),
                suspended_reason = $2,
                updated_at = NOW()
          WHERE id = $1
          RETURNING id, is_suspended, suspended_at, suspended_reason`,
        [req.params.id, reason]
      );
      if (r.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Merchant not found' });
      }

      let unboundCount = 0;
      if (forceUnbind) {
        const u = await client.query(
          `UPDATE devices
              SET unbound_at = NOW(),
                  unbound_reason = 'admin_suspend'
            WHERE merchant_id = $1 AND unbound_at IS NULL
            RETURNING id`,
          [req.params.id]
        );
        unboundCount = u.rowCount;
      }

      await client.query('COMMIT');
      res.json({ ok: true, merchant: r.rows[0], devices_unbound: unboundCount });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      client.release();
    }
  } catch (e) { next(e); }
}

async function unsuspendMerchant(req, res, next) {
  try {
    const r = await pool.query(
      `UPDATE merchants
          SET is_suspended = FALSE,
              suspended_at = NULL,
              suspended_reason = NULL,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, is_suspended`,
      [req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Merchant not found' });
    res.json({ ok: true, merchant: r.rows[0] });
  } catch (e) { next(e); }
}

/* ─── Super-admin wallet adjustment ───
 *   POST /admin/merchants/:id/wallet
 *   body: { amount: number, note?: string }
 *     amount > 0  → credit
 *     amount < 0  → debit  (refuses to go below 0)
 *   Writes an audit row in wallet_ledger (kind='adjustment') and updates
 *   merchants.wallet_balance in one transaction.
 */
async function adjustWallet(req, res, next) {
  const client = await pool.connect();
  try {
    const merchantId = req.params.id;
    const amount = Number(req.body && req.body.amount);
    const note = String((req.body && req.body.note) || '').slice(0, 500) || 'Admin adjustment';

    if (!Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ error: 'amount must be a non-zero number' });
    }
    if (Math.abs(amount) > 10_000_000) {
      return res.status(400).json({ error: 'amount out of range' });
    }

    await client.query('BEGIN');

    const m = await client.query(
      `SELECT id, name, wallet_balance, is_platform
         FROM merchants
        WHERE id = $1
        FOR UPDATE`,
      [merchantId]
    );
    if (m.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Merchant not found' });
    }
    if (m.rows[0].is_platform) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot adjust the platform merchant' });
    }

    const currentBalance = Number(m.rows[0].wallet_balance);
    const newBalance = currentBalance + amount;
    if (newBalance < 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Insufficient balance for this debit',
        balance: currentBalance,
      });
    }

    const ledger = await client.query(
      `INSERT INTO wallet_ledger (merchant_id, amount, kind, note)
       VALUES ($1, $2, 'adjustment', $3)
       RETURNING id, amount, kind, note, created_at`,
      [merchantId, amount, note]
    );

    const upd = await client.query(
      `UPDATE merchants
          SET wallet_balance = wallet_balance + $1,
              updated_at     = NOW()
        WHERE id = $2
        RETURNING wallet_balance`,
      [amount, merchantId]
    );

    await client.query('COMMIT');
    res.json({
      ok: true,
      merchant_id: merchantId,
      balance: Number(upd.rows[0].wallet_balance),
      ledger:  ledger.rows[0],
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    next(e);
  } finally {
    client.release();
  }
}

/* ─── Per-merchant wallet ledger (admin view of merchant.wallet history) ─── */
async function getMerchantLedger(req, res, next) {
  try {
    const limit  = Math.min(200, Math.max(1, Number(req.query.limit)  || 20));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const m = await pool.query(
      'SELECT id, wallet_balance, currency FROM merchants WHERE id = $1',
      [req.params.id]
    );
    if (m.rowCount === 0) return res.status(404).json({ error: 'Merchant not found' });

    const totalR = await pool.query(
      'SELECT COUNT(*)::int AS n FROM wallet_ledger WHERE merchant_id = $1 AND account_id IS NULL',
      [req.params.id]
    );
    // `balance_after` = running wallet balance immediately after each entry.
    // Cumulative sum from the OLDEST entry (the wallet starts at 0 and every
    // balance change writes a ledger row, so the final cumulative equals the
    // merchant's current wallet_balance). The window runs over the full ledger,
    // so the figure stays correct on any paginated slice.
    const ledgerR = await pool.query(
      `SELECT id, amount, kind, source_session_id, source_transaction_id, note, created_at, balance_after
         FROM (
           SELECT id, amount, kind, source_session_id, source_transaction_id, note, created_at,
                  SUM(amount) OVER (ORDER BY created_at ASC, id ASC) AS balance_after
             FROM wallet_ledger
            WHERE merchant_id = $1 AND account_id IS NULL
         ) x
        ORDER BY created_at DESC, id DESC
        LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset]
    );

    res.json({
      balance:  Number(m.rows[0].wallet_balance),
      currency: m.rows[0].currency,
      ledger:   ledgerR.rows,
      total:    totalR.rows[0].n,
      limit, offset,
    });
  } catch (e) { next(e); }
}

/* ─── Per-merchant top-up history (recharge sessions) ─── */
async function getMerchantRecharges(req, res, next) {
  try {
    const limit  = Math.min(200, Math.max(1, Number(req.query.limit)  || 20));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const totalR = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM payment_sessions s
        WHERE s.metadata->>'type' = 'wallet_topup'
          AND s.metadata->>'recharge_for_merchant_id' = $1::text`,
      [req.params.id]
    );
    const r = await pool.query(
      `SELECT s.id AS session_id, s.amount, s.currency, s.status AS session_status,
              s.created_at, s.expires_at,
              t.id AS transaction_id, t.txnid_submitted, t.status AS tx_status,
              t.result_source, t.verified_at, t.failure_reason,
              g.provider, g.variant, g.account_number, g.label AS gateway_label
         FROM payment_sessions s
         LEFT JOIN LATERAL (
           SELECT id, txnid_submitted, status, result_source, verified_at, failure_reason, gateway_id
             FROM transactions
            WHERE session_id = s.id
            ORDER BY created_at DESC LIMIT 1
         ) t ON TRUE
         LEFT JOIN gateways g ON g.id = t.gateway_id
        WHERE s.metadata->>'type' = 'wallet_topup'
          AND s.metadata->>'recharge_for_merchant_id' = $1::text
        ORDER BY s.created_at DESC
        LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset]
    );
    res.json({ recharges: r.rows, total: totalR.rows[0].n, limit, offset });
  } catch (e) { next(e); }
}

/* ─── Reset a merchant's password ───
 *   POST /admin/merchants/:id/reset-password
 *   body: { new_password?: string }
 *   - If new_password provided, it must be ≥ 6 chars.
 *   - If absent, server generates a 12-char random one.
 *   - Returns the plaintext ONCE; admin must copy it now (we don't store
 *     plaintext anywhere recoverable afterwards).
 */
async function resetMerchantPassword(req, res, next) {
  try {
    let supplied = req.body && req.body.new_password ? String(req.body.new_password) : null;
    const generated = !supplied;

    if (supplied != null && supplied.length < 6) {
      return res.status(400).json({ error: 'new_password must be at least 6 characters' });
    }
    if (!supplied) {
      // 12 char random: uppercase + lowercase + digit so it satisfies usual policies.
      const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; // no 0/O/1/l for readability
      supplied = '';
      for (let i = 0; i < 12; i++) supplied += alpha[Math.floor(Math.random() * alpha.length)];
    }

    const hash = await bcrypt.hash(supplied, 10);
    const r = await pool.query(
      `UPDATE merchants SET password_hash = $1, updated_at = NOW()
        WHERE id = $2 AND is_platform = FALSE
        RETURNING id, username, email`,
      [hash, req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Merchant not found' });

    res.json({
      ok: true,
      password: supplied,           // shown ONCE, never stored
      generated,                    // tells the UI whether to label it "generated" vs "set"
      merchant: r.rows[0],
    });
  } catch (e) { next(e); }
}

/* ─── Admin: edit a device's name / Telegram / WhatsApp ───
 *   PATCH /api/admin/devices/:id
 *   body { model?, binder_name?, telegram_handle? (or telegram), whatsapp? }
 *   Only the supplied fields change. Works on any merchant's (or the platform's)
 *   bound device.
 */
async function updateDevice(req, res, next) {
  try {
    const fields = {};

    if (req.body.model !== undefined) {
      fields.model = String(req.body.model).trim() || null;
    }
    if (req.body.binder_name !== undefined) {
      const bn = String(req.body.binder_name).trim();
      if (bn && bn.length < 2) return res.status(400).json({ error: 'Binder name must be at least 2 characters' });
      fields.binder_name = bn || null;
    }
    if (req.body.telegram_handle !== undefined || req.body.telegram !== undefined) {
      let tg = String(req.body.telegram_handle ?? req.body.telegram ?? '').trim();
      tg = tg.replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '').replace(/^@/, '').trim();
      if (tg && !/^[a-zA-Z0-9_]{4,32}$/.test(tg)) {
        return res.status(400).json({ error: 'Invalid Telegram username (4–32 letters, digits or underscore)' });
      }
      fields.telegram_handle = tg || null;
    }
    if (req.body.whatsapp !== undefined) {
      let wa = String(req.body.whatsapp || '').trim()
        .replace(/^https?:\/\/(wa\.me|api\.whatsapp\.com)\//i, '')
        .replace(/[\s\-()]/g, '')
        .replace(/^\+/, '');
      if (wa && !/^\d{7,15}$/.test(wa)) {
        return res.status(400).json({ error: 'Invalid WhatsApp number (7–15 digits, optionally with country code)' });
      }
      fields.whatsapp = wa || null;
    }

    const cols = Object.keys(fields); // whitelisted keys only — safe to interpolate
    if (cols.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    const vals = cols.map((c) => fields[c]);
    const r = await pool.query(
      `UPDATE devices SET ${sets}
        WHERE id = $1 AND unbound_at IS NULL
        RETURNING id, device_id, model, manufacturer, os_version, binder_name,
                  telegram_handle, whatsapp, account_id`,
      [req.params.id, ...vals]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Device not found or unbound' });
    res.json({ device: r.rows[0] });
  } catch (e) { next(e); }
}

/* ─── POST /api/admin/me/password ───
 * body: { current_password, new_password }
 *
 * The admin changes their OWN password. The current one is re-checked against
 * the hash here, never trusted from the client: a stolen session cookie must not
 * be enough to lock the real admin out of their own account.
 *
 * Note the existing JWT stays valid — it carries no password material. Other
 * signed-in sessions keep working until they expire.
 */
async function changeOwnPassword(req, res, next) {
  try {
    const current = String((req.body && req.body.current_password) || '');
    const next_ = String((req.body && req.body.new_password) || '');

    if (!current) return res.status(400).json({ error: 'current_password is required' });
    if (next_.length < 8) return res.status(400).json({ error: 'new_password must be at least 8 characters' });
    if (next_ === current) return res.status(400).json({ error: 'The new password must be different from the current one.' });

    const r = await pool.query('SELECT id, password_hash FROM admins WHERE id = $1', [req.admin.id]);
    if (r.rowCount === 0) return res.status(401).json({ error: 'Account no longer exists' });

    const ok = await bcrypt.compare(current, r.rows[0].password_hash);
    // Deliberately vague and identical in shape to a wrong-username login, so a
    // stolen cookie can't be used to brute-force the current password quietly.
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });

    const hash = await bcrypt.hash(next_, 10);
    await pool.query('UPDATE admins SET password_hash = $1 WHERE id = $2', [hash, req.admin.id]);

    res.json({ ok: true });
  } catch (e) { next(e); }
}

module.exports = {
  login, logout, listMerchants, getMerchant, createMerchant,
  suspendMerchant, unsuspendMerchant, adjustWallet,
  getMerchantLedger, getMerchantRecharges, resetMerchantPassword,
  updateDevice, changeOwnPassword,
};
