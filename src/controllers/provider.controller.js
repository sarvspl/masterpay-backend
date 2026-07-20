const pool = require('../db/pool');

const ID_RE     = /^[a-z][a-z0-9_]{1,38}$/;

/**
 * merchants.country holds display names from frontend/src/lib/countries.js
 * ('India', 'Bangladesh'), but some legacy rows contain ISO codes instead
 * ('IN', 'BD'). Map the known aliases so those merchants still resolve to the
 * right rails instead of silently falling through to the global catalog.
 */
const COUNTRY_ALIASES = {
  in: 'India',  ind: 'India',
  bd: 'Bangladesh', bgd: 'Bangladesh',
};

function normalizeCountry(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  return COUNTRY_ALIASES[v.toLowerCase()] || v;
}
const VARIANT_RE = /^[a-z][a-z0-9_]{0,38}$/;
const COLOR_PALETTE = ['pink','orange','purple','emerald','blue','indigo','red','amber','teal','rose','slate'];

function validateBody(b, isUpdate = false) {
  if (!isUpdate) {
    if (!b.id || !ID_RE.test(String(b.id)))     return 'id must be lowercase letters/digits/underscores (3-40 chars)';
  }
  if (!b.name || String(b.name).trim().length < 1)        return 'name is required';
  if (!b.initials || String(b.initials).trim().length < 1) return 'initials is required';
  if (String(b.initials).length > 4)                       return 'initials must be at most 4 characters';
  if (b.color && !COLOR_PALETTE.includes(b.color))         return `color must be one of: ${COLOR_PALETTE.join(', ')}`;
  if (!Array.isArray(b.variants) || b.variants.length === 0) return 'variants must be a non-empty array';
  for (const v of b.variants) {
    if (typeof v !== 'string' || !VARIANT_RE.test(v))      return `invalid variant slug: "${v}"`;
  }
  return null;
}

/* ─── Public (no auth) — used by merchant gateways page ─── */
async function listPublic(req, res, next) {
  try {
    // Rule: a merchant sees the providers registered for THEIR country; if their
    // country has none registered, they fall back to the global (country IS NULL)
    // catalog.
    //
    // Concretely: India has gpay/phonepe, so Indian merchants see UPI only and
    // never bKash/Nagad. Bangladesh has no country-specific providers, so BD
    // merchants keep seeing the global catalog exactly as before — this is why
    // 041 left every pre-existing provider at country NULL. Registering a
    // Bangladesh-specific provider later flips BD over automatically.
    //
    // ?country= is a narrowing hint from the gateways page. An authenticated
    // merchant's own country always wins, so a client cannot request rails it
    // isn't entitled to.
    const country = normalizeCountry((req.merchant && req.merchant.country) || req.query.country);

    const { rows } = await pool.query(
      `SELECT id, name, initials, color, variants, country
         FROM providers
        WHERE is_enabled = TRUE
          AND CASE
                WHEN EXISTS (
                  SELECT 1 FROM providers
                   WHERE is_enabled = TRUE
                     AND $1::text IS NOT NULL
                     AND LOWER(country) = LOWER($1)
                )
                THEN LOWER(country) = LOWER($1)
                ELSE country IS NULL
              END
        ORDER BY name ASC`,
      [country]
    );
    res.json({ providers: rows });
  } catch (e) { next(e); }
}

/* Bank catalog for the UPI gateway form's bank dropdown. */
async function listBanksPublic(req, res, next) {
  try {
    res.json({ banks: require('../utils/upi').listBanks() });
  } catch (e) { next(e); }
}

/* ─── Admin (requires admin JWT) ─── */
async function adminList(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.initials, p.color, p.variants, p.is_enabled, p.country, p.created_at,
              (SELECT COUNT(*)::int FROM gateways WHERE provider = p.id) AS gateway_count
         FROM providers p
        ORDER BY p.name ASC`
    );
    res.json({ providers: rows });
  } catch (e) { next(e); }
}

async function adminCreate(req, res, next) {
  try {
    const err = validateBody(req.body);
    if (err) return res.status(400).json({ error: err });

    const id       = String(req.body.id).toLowerCase().trim();
    const name     = String(req.body.name).trim();
    const initials = String(req.body.initials).trim();
    const color    = req.body.color || 'slate';
    const variants = req.body.variants.map((v) => String(v).toLowerCase().trim());

    try {
      const r = await pool.query(
        `INSERT INTO providers (id, name, initials, color, variants)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING id, name, initials, color, variants, is_enabled, created_at`,
        [id, name, initials, color, JSON.stringify(variants)]
      );
      res.status(201).json({ provider: r.rows[0] });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: `Provider "${id}" already exists` });
      throw e;
    }
  } catch (e) { next(e); }
}

async function adminUpdate(req, res, next) {
  try {
    const err = validateBody(req.body, true);
    if (err) return res.status(400).json({ error: err });

    const name     = String(req.body.name).trim();
    const initials = String(req.body.initials).trim();
    const color    = req.body.color || 'slate';
    const variants = req.body.variants.map((v) => String(v).toLowerCase().trim());
    const is_enabled = typeof req.body.is_enabled === 'boolean' ? req.body.is_enabled : true;

    const r = await pool.query(
      `UPDATE providers
          SET name = $2, initials = $3, color = $4, variants = $5::jsonb,
              is_enabled = $6, updated_at = NOW()
        WHERE id = $1
        RETURNING id, name, initials, color, variants, is_enabled, created_at`,
      [req.params.id, name, initials, color, JSON.stringify(variants), is_enabled]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Provider not found' });
    res.json({ provider: r.rows[0] });
  } catch (e) { next(e); }
}

async function adminDelete(req, res, next) {
  try {
    // Refuse if any gateways still reference this provider
    const used = await pool.query(
      `SELECT COUNT(*)::int AS n FROM gateways WHERE provider = $1`,
      [req.params.id]
    );
    if (used.rows[0].n > 0) {
      return res.status(409).json({
        error: `Cannot delete: ${used.rows[0].n} gateway(s) are configured with this provider. Disable the provider instead.`,
        used_by_count: used.rows[0].n,
      });
    }
    const r = await pool.query(`DELETE FROM providers WHERE id = $1 RETURNING id`, [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Provider not found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
}

module.exports = {
  listPublic, listBanksPublic,
  adminList, adminCreate, adminUpdate, adminDelete,
  COLOR_PALETTE,
};