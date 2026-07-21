const pool = require('../db/pool');

const ID_RE     = /^[a-z][a-z0-9_]{1,38}$/;

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
    // The whole catalog, regardless of the merchant's registered country.
    //
    // Country used to restrict this, on the assumption that a Bangladeshi
    // business only ever collects through BD rails. That isn't true: a seller
    // anywhere may hold an Indian bank account and want to take UPI from Indian
    // customers, and a marketplace may serve both countries. Their registered
    // address doesn't decide that.
    //
    // What actually stops a mismatched payment is CURRENCY, not country, and
    // that guard is enforced where it matters rather than here:
    //
    //   - listCheckoutGateways hides rails that can't receive the session's
    //     currency, so a UPI gateway simply never appears on a BDT checkout.
    //   - submitTxn re-checks it, so a hand-crafted gateway_id can't get past.
    //   - availabilityFor reports currency_unsupported instead of creating a
    //     session whose checkout would be empty.
    //
    // That guard is real, because the two networks genuinely cannot reach each
    // other: bKash runs on Bangladesh's rails and UPI on India's NPCI, with no
    // interoperability. A bKash user cannot pay a UPI QR at all. So configuring
    // a rail is harmless — being offered one you can't pay is what hurts, and
    // that is prevented at checkout.
    //
    // providers.country is kept as descriptive metadata: the gateway form uses
    // it to label a rail's region so the choice is informed rather than blocked.
    const { rows } = await pool.query(
      `SELECT id, name, initials, color, variants, country
         FROM providers
        WHERE is_enabled = TRUE
        ORDER BY name ASC`
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