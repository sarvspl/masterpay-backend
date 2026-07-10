/**
 * Settlement hook for vendor→platform payments. Called from every place a
 * transaction can flip to `success` (SMS auto-match, manual/admin approve).
 * A single platform payment is one of:
 *   - a vendor ACTIVATION  (transactions.activation_account_id set) → activate, or
 *   - a vendor wallet TOP-UP (transactions.vendor_topup_account_id set) → credit.
 * Both are idempotent. Accepts a pool or an in-transaction client.
 */
async function settleForTransaction(db, transactionId) {
  if (!transactionId) return false;
  let did = false;

  // 1) Activation → set activated_at + record the fee as platform revenue.
  const r = await db.query(
    `UPDATE accounts a
        SET activated_at = NOW()
       FROM transactions t
      WHERE t.id = $1
        AND t.activation_account_id = a.id
        AND a.activated_at IS NULL
      RETURNING a.id, a.merchant_id, t.amount`,
    [transactionId]
  );
  if (r.rowCount > 0) {
    did = true;
    try {
      const { recordPlatformRevenue, getPlatformSettings, computeMerchantCommission, creditMerchantCommission } = require('./wallet');
      const settings = await getPlatformSettings().catch(() => ({ verify_charge_currency: 'BDT' }));
      const fee = Number(r.rows[0].amount);
      // Commission split: merchant earns a % of the joining fee; platform keeps the rest.
      const commission = computeMerchantCommission(settings, 'join', fee);
      if (commission > 0) {
        // r.rows[0].id is the vendor account we just activated.
        await creditMerchantCommission(
          db, r.rows[0].merchant_id, commission, transactionId, 'Vendor joining commission',
          { type: 'join', accountId: r.rows[0].id }
        );
      }
      await recordPlatformRevenue(db, {
        type: 'vendor_activation',
        amount: fee - commission,
        currency: settings.verify_charge_currency || 'BDT',
        sourceTransactionId: transactionId,
        note: 'Vendor activation fee',
      });
    } catch (e) {
      console.error('[settle] activation settle failed:', e.message);
    }
  }

  // 2) Top-up → credit the vendor's wallet.
  try {
    const { creditVendorTopup } = require('./wallet');
    if (await creditVendorTopup(db, transactionId)) did = true;
  } catch (e) {
    console.error('[settle] vendor topup credit failed:', e.message);
  }

  return did;
}

module.exports = { settleForTransaction, activateForTransaction: settleForTransaction };
