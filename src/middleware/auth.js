const { verify } = require('../utils/jwt');
const pool = require('../db/pool');

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return null;
}

async function requireMerchant(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = verify(token);
    if (payload.role !== 'merchant') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    // Re-check suspension on every authenticated request so that a merchant who
    // gets suspended mid-session is kicked out within one round-trip instead of
    // waiting for their JWT to expire.
    const r = await pool.query(
      `SELECT is_suspended, suspended_reason FROM merchants WHERE id = $1`,
      [payload.sub]
    );
    if (r.rowCount === 0) {
      return res.status(401).json({ error: 'Account no longer exists' });
    }
    if (r.rows[0].is_suspended) {
      return res.status(403).json({
        error: r.rows[0].suspended_reason
          ? `Your account is suspended: ${r.rows[0].suspended_reason}`
          : 'Your account is suspended. Contact support.',
        suspended: true,
      });
    }
    req.merchant = { id: payload.sub, username: payload.username };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function requireVendor(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = verify(token);
    if (payload.role !== 'vendor') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    // Re-check on every request: the account must still exist AND its parent
    // merchant must not be suspended (a suspended marketplace freezes all its
    // vendors). payload.sub is the account id.
    const r = await pool.query(
      `SELECT a.id, a.merchant_id, a.username, a.activated_at,
              m.is_suspended, m.suspended_reason
         FROM accounts a
         JOIN merchants m ON m.id = a.merchant_id
        WHERE a.id = $1`,
      [payload.sub]
    );
    if (r.rowCount === 0) {
      return res.status(401).json({ error: 'Account no longer exists' });
    }
    if (r.rows[0].is_suspended) {
      return res.status(403).json({
        error: r.rows[0].suspended_reason
          ? `This marketplace account is suspended: ${r.rows[0].suspended_reason}`
          : 'This marketplace account is suspended. Contact the marketplace operator.',
        suspended: true,
      });
    }
    // Activation fee is a single platform-wide amount set by the admin. The
    // vendor is gated until they've paid it (when it's > 0).
    let globalFee = 0;
    try {
      const s = await require('../services/wallet').getPlatformSettings();
      globalFee = Number(s.vendor_activation_fee || 0);
    } catch { globalFee = 0; }
    const needsActivation = globalFee > 0 && r.rows[0].activated_at == null;
    req.vendor = {
      account_id:      r.rows[0].id,
      merchant_id:     r.rows[0].merchant_id,
      username:        r.rows[0].username,
      activation_fee:  globalFee,
      activated_at:    r.rows[0].activated_at,
      needs_activation: needsActivation,
    };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Block the vendor's panel data endpoints until they've paid the activation fee.
// Mount AFTER requireVendor. /me and the activation endpoints stay open so the
// panel can show the pay screen and accept the payment.
function requireActivated(req, res, next) {
  if (req.vendor && req.vendor.needs_activation) {
    return res.status(403).json({
      error: 'Activate your account to access this. Pay the one-time activation fee first.',
      code: 'activation_required',
      activation_fee: req.vendor.activation_fee,
    });
  }
  next();
}

function requireAdmin(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = verify(token);
    if (payload.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    req.admin = { id: payload.sub, username: payload.username };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { requireMerchant, requireVendor, requireActivated, requireAdmin };
