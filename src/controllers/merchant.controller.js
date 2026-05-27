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
const { getPlatformSettings, recordPlatformRevenue } = require('../services/wallet');

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

      // Primary account — the domain account. Carries the device auth key and
      // its gateways. Starts locked behind the same one-time unlock fee.
      await client.query(
        `INSERT INTO accounts (merchant_id, label, device_auth_key, keys_unlocked, is_default)
         VALUES ($1, 'Primary', $2, FALSE, TRUE)`,
        [merchant.id, deviceAuthKey]
      );

      await client.query('COMMIT');

      const token = sign({ sub: merchant.id, username: merchant.username, role: 'merchant' });
      // Keys start locked behind the one-time unlock fee — don't leak them in
      // the signup response. The dashboard prompts to unlock + pay.
      const settings = await getPlatformSettings().catch(() => ({ key_unlock_fee: 0 }));
      const fee = Number(settings.key_unlock_fee || 0);
      const unlocked = fee <= 0;
      res.status(201).json({
        token,
        merchant: {
          ...merchant,
          keys_unlocked: unlocked,
          key_unlock_fee: fee,
          api_key: unlocked ? apiKey : null,
          device_auth_key: unlocked ? deviceAuthKey : null,
        },
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
        suspended: true,
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
    // The device auth key + its unlock state now live on the Primary account.
    const { rows } = await pool.query(
      `SELECT m.id, m.name, m.username, m.mobile, m.email, m.domain, m.industry, m.country, m.state,
              m.currency, m.wallet_balance, m.created_at,
              (m.keys_unlocked OR COALESCE(a.keys_unlocked, FALSE)) AS keys_unlocked,
              a.device_auth_key,
              b.api_key, b.id AS default_brand_id
         FROM merchants m
         LEFT JOIN accounts a ON a.merchant_id = m.id AND a.is_default = TRUE
         LEFT JOIN brands b ON b.merchant_id = m.id AND b.is_default = TRUE
        WHERE m.id = $1`,
      [req.merchant.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Merchant not found' });

    // Gate the integration keys behind the one-time unlock purchase. Until the
    // fee is paid, the keys are NOT returned at all (so they can't be read off
    // the network). The frontend shows a purchase prompt instead.
    const settings = await getPlatformSettings().catch(() => ({ key_unlock_fee: 0 }));
    const fee = Number(settings.key_unlock_fee || 0);
    const m = rows[0];
    m.key_unlock_fee = fee;
    // fee<=0 means the gate is disabled — keys are effectively always unlocked.
    m.keys_unlocked = m.keys_unlocked || fee <= 0;
    if (!m.keys_unlocked) {
      m.api_key = null;
      m.device_auth_key = null;
    }
    res.json({ merchant: m });
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

    // Mask brand keys until the one-time unlock fee is paid.
    const unlocked = await keysUnlocked(req.merchant.id);
    const brands = unlocked ? rows : rows.map((b) => ({ ...b, api_key: null, secret_key: null }));
    res.json({ brands, keys_unlocked: unlocked });
  } catch (e) {
    next(e);
  }
}

// True when this merchant may see its integration keys — either it already
// paid the unlock fee, or the fee is disabled (0).
async function keysUnlocked(merchantId) {
  const r = await pool.query('SELECT keys_unlocked FROM merchants WHERE id = $1', [merchantId]);
  if (r.rowCount === 0) return false;
  if (r.rows[0].keys_unlocked) return true;
  const settings = await getPlatformSettings().catch(() => ({ key_unlock_fee: 0 }));
  return Number(settings.key_unlock_fee || 0) <= 0;
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

/* ─── One-time integration-key unlock (paid from wallet) ─── */
async function unlockKeys(req, res, next) {
  const client = await pool.connect();
  try {
    const settings = await getPlatformSettings().catch(() => ({ key_unlock_fee: 0, verify_charge_currency: 'BDT' }));
    const fee = Number(settings.key_unlock_fee || 0);

    await client.query('BEGIN');
    const m = await client.query(
      `SELECT m.id, m.wallet_balance, m.keys_unlocked, m.currency,
              a.id AS account_id, a.device_auth_key, b.api_key
         FROM merchants m
         LEFT JOIN accounts a ON a.merchant_id = m.id AND a.is_default = TRUE
         LEFT JOIN brands b ON b.merchant_id = m.id AND b.is_default = TRUE
        WHERE m.id = $1
        FOR UPDATE OF m`,
      [req.merchant.id]
    );
    if (m.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Merchant not found' }); }
    const row = m.rows[0];

    // Already unlocked, or the gate is disabled (fee 0) → just return the keys.
    if (row.keys_unlocked || fee <= 0) {
      if (!row.keys_unlocked) {
        await client.query('UPDATE merchants SET keys_unlocked = TRUE WHERE id = $1', [req.merchant.id]);
        await client.query('UPDATE accounts SET keys_unlocked = TRUE WHERE merchant_id = $1 AND is_default = TRUE', [req.merchant.id]);
      }
      await client.query('COMMIT');
      return res.json({ keys_unlocked: true, api_key: row.api_key, device_auth_key: row.device_auth_key });
    }

    const balance = Number(row.wallet_balance);
    if (balance < fee) {
      await client.query('ROLLBACK');
      return res.status(402).json({
        error: 'Insufficient wallet balance to unlock your integration keys.',
        code: 'insufficient_balance',
        balance, fee,
      });
    }

    // Debit the fee, flip the flag, log the ledger entry + platform revenue —
    // all atomically. The FOR UPDATE lock + keys_unlocked flag prevent any
    // double-charge from concurrent/repeat calls.
    await client.query(
      `UPDATE merchants
          SET wallet_balance = wallet_balance - $1, keys_unlocked = TRUE, updated_at = NOW()
        WHERE id = $2`,
      [fee, req.merchant.id]
    );
    await client.query('UPDATE accounts SET keys_unlocked = TRUE WHERE merchant_id = $1 AND is_default = TRUE', [req.merchant.id]);
    await client.query(
      `INSERT INTO wallet_ledger (merchant_id, amount, kind, note)
       VALUES ($1, $2, 'key_unlock', 'Integration key unlock')`,
      [req.merchant.id, -fee]
    );
    await recordPlatformRevenue(client, {
      type: 'key_unlock',
      amount: fee,
      currency: settings.verify_charge_currency || row.currency || 'BDT',
      merchantId: req.merchant.id,
      note: 'Integration key unlock',
    });
    await client.query('COMMIT');

    res.json({
      keys_unlocked: true,
      api_key: row.api_key,
      device_auth_key: row.device_auth_key,
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

module.exports = {
  register, login, me, updateMe, changePassword, checkUsername,
  listBrands, createBrand, deleteBrand, unlockKeys,
};
