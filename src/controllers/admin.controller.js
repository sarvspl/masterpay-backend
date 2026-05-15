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
    res.json({ token });
  } catch (e) {
    next(e);
  }
}

async function listMerchants(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.name, m.username, m.mobile, m.email, m.domain, m.industry, m.country, m.state,
              m.currency, m.wallet_balance, m.is_suspended, m.suspended_at, m.suspended_reason, m.created_at,
              k.device_auth_key,
              b.api_key AS default_api_key,
              (SELECT COUNT(*) FROM brands WHERE merchant_id = m.id) AS brand_count
         FROM merchants m
         JOIN merchant_keys k ON k.merchant_id = m.id
         LEFT JOIN brands b ON b.merchant_id = m.id AND b.is_default = TRUE
        ORDER BY m.created_at DESC`
    );
    const merchants = rows.map((r) => ({
      ...r,
      brand_count: Number(r.brand_count) || 0,
      api_key_masked: maskKey(r.default_api_key, 4),
      device_auth_key_masked: maskKey(r.device_auth_key, 4),
      default_api_key: undefined,
      device_auth_key: undefined,
    }));
    res.json({ merchants });
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

    res.json({
      merchant: {
        ...r,
        api_key_masked: maskKey(r.default_api_key, 4),
        device_auth_key_masked: maskKey(r.device_auth_key, 4),
        default_api_key: undefined,
        device_auth_key: undefined,
        brands,
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

module.exports = { login, listMerchants, getMerchant, createMerchant, suspendMerchant, unsuspendMerchant };
