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

module.exports = { requireMerchant, requireAdmin };
