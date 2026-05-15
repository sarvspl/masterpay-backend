const pool = require('../db/pool');

const FIELDS = ['email', 'phone', 'whatsapp', 'hours', 'message'];

function trimOrNull(v) {
  if (v === undefined || v === null) return undefined; // not provided in payload
  const s = String(v).trim();
  return s.length ? s.slice(0, 500) : null;
}

async function loadConfig() {
  const r = await pool.query(
    `SELECT email, phone, whatsapp, hours, message, updated_at
       FROM support_config WHERE id = 1`
  );
  return r.rows[0] || { email: null, phone: null, whatsapp: null, hours: null, message: null };
}

/* ── Public — surfaced on login page ── */
async function getPublic(req, res, next) {
  try {
    res.json({ support: await loadConfig() });
  } catch (e) { next(e); }
}

/* ── Admin — same payload, but lets the admin verify what's stored ── */
async function getForAdmin(req, res, next) {
  try {
    res.json({ support: await loadConfig() });
  } catch (e) { next(e); }
}

/* ── Admin — PATCH-style update: only fields present in the body change ── */
async function updateForAdmin(req, res, next) {
  try {
    const patch = {};
    for (const f of FIELDS) {
      const v = trimOrNull(req.body[f]);
      if (v !== undefined) patch[f] = v;
    }
    if (Object.keys(patch).length === 0) {
      const support = await loadConfig();
      return res.json({ support });
    }

    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(patch)) {
      params.push(v);
      sets.push(`${k} = $${params.length}`);
    }
    sets.push('updated_at = NOW()');

    const sql = `UPDATE support_config SET ${sets.join(', ')} WHERE id = 1
                 RETURNING email, phone, whatsapp, hours, message, updated_at`;
    const r = await pool.query(sql, params);
    res.json({ support: r.rows[0] });
  } catch (e) { next(e); }
}

module.exports = { getPublic, getForAdmin, updateForAdmin };
