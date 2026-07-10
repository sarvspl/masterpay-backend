/**
 * Platform finance — the super-admin's view of the business.
 *
 * Three numbers that are easy to confuse, and must never be added together:
 *
 *  1. REVENUE BOOKED   — fees the platform earned (platform_revenue). Most are
 *                        debited from a wallet, not received as cash.
 *  2. CASH RECEIVED    — real money paid INTO the platform's own bKash/Nagad
 *                        numbers: vendor activations, vendor top-ups, merchant
 *                        wallet recharges. Minus approved withdrawals paid out.
 *  3. FLOAT (LIABILITY)— what merchants and vendors are holding in their wallets
 *                        plus withdrawals awaiting payout. They can all cash this
 *                        out; it is money the platform owes, not money it has.
 *
 * A page showing only (1) would tell the owner they're up half a million while
 * the bank account holds a few thousand and they owe two million.
 */
const pool = require('../db/pool');
const { getPlatformSettings } = require('../services/wallet');

const WINDOWS = {
  today: "date_trunc('day', NOW())",
  '7d':  "NOW() - INTERVAL '7 days'",
  '30d': "NOW() - INTERVAL '30 days'",
};

const num = (v) => Number(v || 0);

/* ─── GET /api/admin/finance?window=today|7d|30d|all ─── */
async function getFinance(req, res, next) {
  try {
    const win = String(req.query.window || 'all').toLowerCase();
    const since = WINDOWS[win] || null;
    const W = (col = 'created_at') => (since ? `AND ${col} >= ${since}` : '');

    const settings = await getPlatformSettings().catch(() => ({}));
    const currency = settings.verify_charge_currency || 'BDT';

    const [
      revLifetime, revPeriod, revByType,
      commLifetime, commPeriod,
      cashInLifetime, cashInPeriod, cashInByKind,
      cashOutLifetime, cashOutPeriod,
      merchantFloat, vendorFloat, pendingWd,
      topMerchants,
    ] = await Promise.all([
      pool.query('SELECT COALESCE(SUM(amount),0)::numeric s, COUNT(*)::int n FROM platform_revenue'),
      pool.query(`SELECT COALESCE(SUM(amount),0)::numeric s, COUNT(*)::int n FROM platform_revenue WHERE 1=1 ${W()}`),
      // Revenue split by WHOSE WALLET PAID it — the owner's actual question.
      //   vendor_activation → always a vendor
      //   key_unlock        → always a merchant
      //   topup_fee         → source_session_id = merchant recharge, else vendor top-up
      //   verify_fee        → look at the matching `debit_verify` ledger row:
      //                       account_id set = the VENDOR's wallet was debited.
      //
      // NOT by gateway owner: legacy rows exist where a payment sat on a vendor's
      // gateway but the MERCHANT's wallet was charged (before debitVerifyFee
      // learned to route by account). Gateway-owner attribution overstates
      // vendor income by exactly those rows. And NOT by string-matching `note`.
      pool.query(`SELECT
                    CASE
                      WHEN r.type = 'vendor_activation' THEN 'vendor'
                      WHEN r.type = 'key_unlock'        THEN 'merchant'
                      WHEN r.type = 'topup_fee'         THEN
                        CASE WHEN r.source_session_id IS NOT NULL THEN 'merchant' ELSE 'vendor' END
                      WHEN r.type = 'verify_fee'        THEN
                        CASE WHEN dl.account_id IS NOT NULL THEN 'vendor' ELSE 'merchant' END
                      ELSE 'merchant'
                    END AS payer,
                    r.type,
                    COALESCE(SUM(r.amount),0)::numeric s, COUNT(*)::int n
                  FROM platform_revenue r
                  LEFT JOIN wallet_ledger dl
                         ON dl.source_transaction_id = r.source_transaction_id
                        AND dl.kind = 'debit_verify'
                 WHERE 1=1 ${W('r.created_at')}
                 GROUP BY 1, 2 ORDER BY s DESC`),

      // Commission handed to marketplaces. platform_revenue is already net of
      // this, so it's shown as context, never subtracted again.
      pool.query("SELECT COALESCE(SUM(amount),0)::numeric s, COUNT(*)::int n FROM wallet_ledger WHERE kind='commission'"),
      pool.query(`SELECT COALESCE(SUM(amount),0)::numeric s, COUNT(*)::int n FROM wallet_ledger WHERE kind='commission' ${W()}`),

      // Real cash in: every successful payment landing on a PLATFORM gateway.
      pool.query(`SELECT COALESCE(SUM(t.amount),0)::numeric s, COUNT(*)::int n
                    FROM transactions t JOIN gateways g ON g.id=t.gateway_id JOIN merchants m ON m.id=g.merchant_id
                   WHERE m.is_platform=TRUE AND t.status='success'`),
      pool.query(`SELECT COALESCE(SUM(t.amount),0)::numeric s, COUNT(*)::int n
                    FROM transactions t JOIN gateways g ON g.id=t.gateway_id JOIN merchants m ON m.id=g.merchant_id
                   WHERE m.is_platform=TRUE AND t.status='success' ${W('t.created_at')}`),
      pool.query(`SELECT CASE
                           WHEN t.activation_account_id IS NOT NULL THEN 'vendor_activation'
                           WHEN t.vendor_topup_account_id IS NOT NULL THEN 'vendor_topup'
                           ELSE 'merchant_recharge' END AS kind,
                         COALESCE(SUM(t.amount),0)::numeric s, COUNT(*)::int n
                    FROM transactions t JOIN gateways g ON g.id=t.gateway_id JOIN merchants m ON m.id=g.merchant_id
                   WHERE m.is_platform=TRUE AND t.status='success' ${W('t.created_at')}
                   GROUP BY 1 ORDER BY s DESC`),

      // Cash out: withdrawals you actually paid.
      pool.query("SELECT COALESCE(SUM(amount),0)::numeric s, COUNT(*)::int n FROM withdrawals WHERE status='approved'"),
      pool.query(`SELECT COALESCE(SUM(amount),0)::numeric s, COUNT(*)::int n FROM withdrawals WHERE status='approved' ${W('resolved_at')}`),

      // Float — what everyone else is holding, right now. Never windowed.
      pool.query('SELECT COALESCE(SUM(wallet_balance),0)::numeric s, COUNT(*)::int n FROM merchants WHERE is_platform=FALSE'),
      pool.query('SELECT COALESCE(SUM(wallet_balance),0)::numeric s, COUNT(*)::int n FROM accounts WHERE is_default=FALSE'),
      pool.query("SELECT COALESCE(SUM(amount),0)::numeric s, COUNT(*)::int n FROM withdrawals WHERE status='pending'"),

      pool.query(`SELECT m.id, m.name, m.username,
                         COALESCE(SUM(r.amount),0)::numeric s, COUNT(*)::int n
                    FROM platform_revenue r JOIN merchants m ON m.id = r.merchant_id
                   WHERE m.is_platform = FALSE ${W('r.created_at')}
                   GROUP BY m.id, m.name, m.username
                   ORDER BY s DESC LIMIT 10`),
    ]);

    const floatTotal = num(merchantFloat.rows[0].s) + num(vendorFloat.rows[0].s) + num(pendingWd.rows[0].s);
    const cashNet = num(cashInLifetime.rows[0].s) - num(cashOutLifetime.rows[0].s);

    // { vendor: { lines: [...], total }, merchant: { lines: [...], total } }
    const byPayer = { vendor: { lines: [], total: 0 }, merchant: { lines: [], total: 0 } };
    revByType.rows.forEach((r) => {
      const side = byPayer[r.payer] || byPayer.merchant;
      side.lines.push({ type: r.type, total: num(r.s), count: r.n });
      side.total += num(r.s);
    });
    byPayer.vendor.total = Math.round(byPayer.vendor.total * 100) / 100;
    byPayer.merchant.total = Math.round(byPayer.merchant.total * 100) / 100;

    res.json({
      currency,
      window: WINDOWS[win] ? win : 'all',

      revenue: {
        lifetime: { total: num(revLifetime.rows[0].s), count: revLifetime.rows[0].n },
        period:   { total: num(revPeriod.rows[0].s),   count: revPeriod.rows[0].n },
        by_payer: byPayer,
      },

      commission_shared: {
        lifetime: { total: num(commLifetime.rows[0].s), count: commLifetime.rows[0].n },
        period:   { total: num(commPeriod.rows[0].s),   count: commPeriod.rows[0].n },
      },

      cash: {
        in:  { lifetime: num(cashInLifetime.rows[0].s),  period: num(cashInPeriod.rows[0].s),  count: cashInPeriod.rows[0].n },
        out: { lifetime: num(cashOutLifetime.rows[0].s), period: num(cashOutPeriod.rows[0].s), count: cashOutPeriod.rows[0].n },
        net_lifetime: cashNet,
        in_by_kind: cashInByKind.rows.map((r) => ({ kind: r.kind, total: num(r.s), count: r.n })),
      },

      float: {
        merchant_wallets: { total: num(merchantFloat.rows[0].s), count: merchantFloat.rows[0].n },
        vendor_wallets:   { total: num(vendorFloat.rows[0].s),   count: vendorFloat.rows[0].n },
        pending_withdrawals: { total: num(pendingWd.rows[0].s),  count: pendingWd.rows[0].n },
        total: floatTotal,
      },

      top_merchants: topMerchants.rows.map((r) => ({ id: r.id, name: r.name, username: r.username, total: num(r.s), count: r.n })),
    });
  } catch (e) { next(e); }
}

module.exports = { getFinance };
