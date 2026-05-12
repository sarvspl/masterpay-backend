const pool = require('../db/pool');

/**
 * Auth middleware for merchant-server-to-PayVerify calls.
 * Reads `X-API-Key` header (or `api_key` body field as fallback),
 * resolves it to a brand + merchant, attaches them to `req`.
 */
async function requireApiKey(req, res, next) {
  try {
    const headerKey = req.headers['x-api-key'];
    const bodyKey = req.body && req.body.api_key;
    const apiKey = String(headerKey || bodyKey || '').trim();
    if (!apiKey) return res.status(401).json({ error: 'API key required (X-API-Key header)' });

    const r = await pool.query(
      `SELECT b.id        AS brand_id,
              b.merchant_id,
              b.name      AS brand_name,
              b.domain    AS brand_domain,
              b.secret_key,
              m.name      AS merchant_name,
              m.is_suspended,
              m.suspended_reason
         FROM brands b
         JOIN merchants m ON m.id = b.merchant_id
        WHERE b.api_key = $1`,
      [apiKey]
    );
    if (r.rowCount === 0) return res.status(401).json({ error: 'Invalid API key' });
    if (r.rows[0].is_suspended) {
      return res.status(403).json({
        error: r.rows[0].suspended_reason
          ? `Merchant account is suspended: ${r.rows[0].suspended_reason}`
          : 'Merchant account is suspended.',
        suspended: true,
      });
    }

    req.brand = r.rows[0];
    next();
  } catch (e) {
    next(e);
  }
}

module.exports = { requireApiKey };
