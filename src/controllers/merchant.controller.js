const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { sign } = require('../utils/jwt');
const {
  generateApiKey,
  generateSecretKey,
  generateDeviceAuthKey,
} = require('../utils/keys');
const { generateUniqueUsername, slugify } = require('../utils/username');
const { currencyForCountry } = require('../utils/currency');

const USERNAME_RE = /^[a-z0-9_]{3,40}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const REQUIRED_FIELDS = [
  'name', 'password', 'mobile', 'email',
  'domain', 'industry', 'country', 'state',
];

function validatePayload(body) {
  const missing = REQUIRED_FIELDS.filter((f) => !body[f] || String(body[f]).trim() === '');
  if (missing.length) return `Missing fields: ${missing.join(', ')}`;
  if (String(body.password).length < 6) return 'Password must be at least 6 characters';
  if (!EMAIL_RE.test(String(body.email))) return 'Invalid email address';
  if (body.username && !USERNAME_RE.test(String(body.username))) {
    return 'Username must be 3–40 lowercase letters, numbers, or underscores';
  }
  return null;
}

async function isUsernameTaken(username) {
  const r = await pool.query('SELECT 1 FROM merchants WHERE username = $1', [username]);
  return r.rowCount > 0;
}

async function isEmailTaken(email) {
  const r = await pool.query('SELECT 1 FROM merchants WHERE LOWER(email) = LOWER($1)', [email]);
  return r.rowCount > 0;
}

async function register(req, res, next) {
  try {
    const err = validatePayload(req.body);
    if (err) return res.status(400).json({ error: err });

    const { name, password, mobile, email, domain, industry, country, state } = req.body;
    let username = req.body.username ? String(req.body.username).trim().toLowerCase() : null;

    if (username) {
      if (await isUsernameTaken(username)) {
        return res.status(409).json({ error: 'Username is already taken', field: 'username' });
      }
    } else {
      username = await generateUniqueUsername(name);
    }

    if (await isEmailTaken(email)) {
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

      const token = sign({ sub: merchant.id, username: merchant.username, role: 'merchant' });
      res.status(201).json({
        token,
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

async function login(req, res, next) {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'username/email and password required' });
    }
    const identifier = String(username).trim();
    const isEmail = identifier.includes('@');
    const sql = isEmail
      ? 'SELECT id, username, password_hash, is_suspended, suspended_reason FROM merchants WHERE LOWER(email) = LOWER($1)'
      : 'SELECT id, username, password_hash, is_suspended, suspended_reason FROM merchants WHERE username = $1';
    const { rows } = await pool.query(sql, [identifier]);
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    if (rows[0].is_suspended) {
      return res.status(403).json({
        error: rows[0].suspended_reason
          ? `Your account is suspended: ${rows[0].suspended_reason}`
          : 'Your account is suspended. Contact support.',
      });
    }

    const token = sign({ sub: rows[0].id, username: rows[0].username, role: 'merchant' });
    res.json({ token });
  } catch (e) {
    next(e);
  }
}

async function me(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.name, m.username, m.mobile, m.email, m.domain, m.industry, m.country, m.state,
              m.currency, m.wallet_balance, m.created_at,
              k.device_auth_key,
              b.api_key, b.id AS default_brand_id
         FROM merchants m
         JOIN merchant_keys k ON k.merchant_id = m.id
         LEFT JOIN brands b ON b.merchant_id = m.id AND b.is_default = TRUE
        WHERE m.id = $1`,
      [req.merchant.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Merchant not found' });
    res.json({ merchant: rows[0] });
  } catch (e) {
    next(e);
  }
}

async function updateMe(req, res, next) {
  try {
    const name = req.body.name == null ? null : String(req.body.name).trim();
    const mobile = req.body.mobile == null ? null : String(req.body.mobile).trim();

    if (name == null && mobile == null) {
      return res.status(400).json({ error: 'Nothing to update' });
    }
    if (name !== null && name.length < 2) {
      return res.status(400).json({ error: 'Name must be at least 2 characters' });
    }
    if (mobile !== null && mobile.length < 6) {
      return res.status(400).json({ error: 'Mobile number is too short' });
    }

    const r = await pool.query(
      `UPDATE merchants SET
         name       = COALESCE($2, name),
         mobile     = COALESCE($3, mobile),
         updated_at = NOW()
       WHERE id = $1
       RETURNING id, name, username, mobile, email, domain, industry, country, state, currency, wallet_balance, created_at`,
      [req.merchant.id, name || null, mobile || null]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Merchant not found' });
    res.json({ merchant: r.rows[0] });
  } catch (e) { next(e); }
}

async function changePassword(req, res, next) {
  try {
    const current = String(req.body.current_password || '');
    const next = String(req.body.new_password || '');
    if (!current || !next) {
      return res.status(400).json({ error: 'Both current and new password are required' });
    }
    if (next.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    if (current === next) {
      return res.status(400).json({ error: 'New password must be different from current password' });
    }

    const r = await pool.query('SELECT password_hash FROM merchants WHERE id = $1', [req.merchant.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Merchant not found' });

    const ok = await bcrypt.compare(current, r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect', field: 'current_password' });

    const newHash = await bcrypt.hash(next, 10);
    await pool.query('UPDATE merchants SET password_hash = $1, updated_at = NOW() WHERE id = $2', [newHash, req.merchant.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
}

async function checkUsername(req, res, next) {
  try {
    const raw = String(req.query.username || '').trim().toLowerCase();
    if (!raw) {
      return res.status(400).json({ available: false, reason: 'missing' });
    }
    if (!USERNAME_RE.test(raw)) {
      return res.json({ available: false, reason: 'invalid_format', suggestion: slugify(raw) });
    }
    const taken = await isUsernameTaken(raw);
    res.json({ available: !taken, reason: taken ? 'taken' : 'ok' });
  } catch (e) {
    next(e);
  }
}

/* ─── Brands ─── */

async function listBrands(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, domain, api_key, secret_key, is_default, created_at
         FROM brands
        WHERE merchant_id = $1
        ORDER BY is_default DESC, created_at ASC`,
      [req.merchant.id]
    );
    res.json({ brands: rows });
  } catch (e) {
    next(e);
  }
}

async function createBrand(req, res, next) {
  try {
    const name = (req.body.name || '').trim();
    const domain = (req.body.domain || '').trim();
    if (!name) return res.status(400).json({ error: 'Brand name is required', field: 'name' });
    if (!domain) return res.status(400).json({ error: 'Domain is required', field: 'domain' });

    // Optional: prevent duplicate domain under the same merchant
    const dup = await pool.query(
      'SELECT 1 FROM brands WHERE merchant_id = $1 AND LOWER(domain) = LOWER($2)',
      [req.merchant.id, domain]
    );
    if (dup.rowCount > 0) {
      return res.status(409).json({ error: 'You already have a brand for this domain', field: 'domain' });
    }

    const apiKey = generateApiKey();
    const secretKey = generateSecretKey();

    const { rows } = await pool.query(
      `INSERT INTO brands (merchant_id, name, domain, api_key, secret_key, is_default)
       VALUES ($1, $2, $3, $4, $5, FALSE)
       RETURNING id, name, domain, api_key, secret_key, is_default, created_at`,
      [req.merchant.id, name, domain, apiKey, secretKey]
    );
    res.status(201).json({ brand: rows[0] });
  } catch (e) {
    next(e);
  }
}

async function deleteBrand(req, res, next) {
  try {
    const r = await pool.query(
      `DELETE FROM brands
        WHERE id = $1 AND merchant_id = $2 AND is_default = FALSE
        RETURNING id`,
      [req.params.id, req.merchant.id]
    );
    if (r.rowCount === 0) {
      return res.status(400).json({
        error: 'Cannot delete this brand. It either does not exist or is the default brand.',
      });
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
}

module.exports = {
  register, login, me, updateMe, changePassword, checkUsername,
  listBrands, createBrand, deleteBrand,
};
