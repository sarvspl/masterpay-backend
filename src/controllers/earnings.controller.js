/**
 * Merchant earnings — the commission a marketplace makes from its own vendors.
 *
 * A marketplace never takes a payment itself, so its only income on the platform
 * is a cut of two fees the platform charges its sellers:
 *
 *   join   — a % of the vendor's one-time activation fee
 *   verify — a % of the per-verification fee the vendor pays on each payment
 *
 * Both land in wallet_ledger as kind='commission', tagged with `commission_type`
 * and the `commission_account_id` that produced them (migration 040).
 */
const pool = require('../db/pool');

const WINDOWS = {
  today: "date_trunc('day', NOW())",
  '7d':  "NOW() - INTERVAL '7 days'",
  '30d': "NOW() - INTERVAL '30 days'",
};

/* ─── GET /api/merchant/earnings?window=today|7d|30d|all ─── */
async function getEarnings(req, res, next) {
  try {
    const win = String(req.query.window || 'all').toLowerCase();
    const since = WINDOWS[win] || null;
    const windowClause = since ? `AND l.created_at >= ${since}` : '';

    const m = await pool.query('SELECT currency FROM merchants WHERE id = $1', [req.merchant.id]);
    const currency = (m.rows[0] && m.rows[0].currency) || 'BDT';

    // Lifetime totals never move with the window chip — a merchant wants to see
    // what they've earned in total AND in the selected period.
    const lifetime = await pool.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS total, COUNT(*)::int AS count
         FROM wallet_ledger WHERE merchant_id = $1 AND kind = 'commission'`,
      [req.merchant.id]
    );

    const summary = await pool.query(
      `SELECT COALESCE(commission_type, 'join') AS type,
              COALESCE(SUM(l.amount), 0)::numeric AS total,
              COUNT(*)::int AS count
         FROM wallet_ledger l
        WHERE l.merchant_id = $1 AND l.kind = 'commission' ${windowClause}
        GROUP BY 1`,
      [req.merchant.id]
    );

    const byType = { join: { total: 0, count: 0 }, verify: { total: 0, count: 0 } };
    summary.rows.forEach((r) => { byType[r.type] = { total: Number(r.total), count: r.count }; });

    // Which sellers earn you the most.
    const byVendor = await pool.query(
      `SELECT a.id, a.label, a.external_id,
              COALESCE(SUM(l.amount), 0)::numeric AS total,
              COUNT(*)::int AS count
         FROM wallet_ledger l
         JOIN accounts a ON a.id = l.commission_account_id
        WHERE l.merchant_id = $1 AND l.kind = 'commission' ${windowClause}
        GROUP BY a.id, a.label, a.external_id
        ORDER BY total DESC
        LIMIT 20`,
      [req.merchant.id]
    );

    const rows = await pool.query(
      `SELECT l.id, l.amount, l.commission_type AS type, l.note, l.created_at,
              a.label AS vendor_label, a.external_id AS vendor_external_id
         FROM wallet_ledger l
         LEFT JOIN accounts a ON a.id = l.commission_account_id
        WHERE l.merchant_id = $1 AND l.kind = 'commission' ${windowClause}
        ORDER BY l.created_at DESC
        LIMIT 200`,
      [req.merchant.id]
    );

    res.json({
      currency,
      window: WINDOWS[win] ? win : 'all',
      lifetime: { total: Number(lifetime.rows[0].total), count: lifetime.rows[0].count },
      period: {
        total: byType.join.total + byType.verify.total,
        count: byType.join.count + byType.verify.count,
        join: byType.join,
        verify: byType.verify,
      },
      by_vendor: byVendor.rows.map((v) => ({ ...v, total: Number(v.total) })),
      entries: rows.rows.map((r) => ({ ...r, amount: Number(r.amount) })),
    });
  } catch (e) { next(e); }
}

module.exports = { getEarnings };
