-- Marketplace-only model: a merchant owns no gateway, so no payment can ever
-- land on one, so the per-verification fee charged to a MERCHANT can never fire
-- on new traffic. The vendor pays the fee instead (vendor_verify_charge_*).
--
-- Its admin controls were removed from the console with this migration. Leaving
-- the flag ON with no way to switch it off would be a trap: legacy `pending`
-- transactions still sit on merchants' own (now-disabled) gateways from before
-- the switch, and approving one would silently debit that merchant.
--
-- We do NOT drop the columns:
--   * verify_charge_currency stamps the currency on every platform_revenue row,
--     including the VENDOR fees we actually collect.
--   * low_balance_threshold is still sent to the APK as `threshold` — which,
--     since walletGuard became vendor-aware, is the vendor's phone.
-- Only the merchant-charge switch and its rates are zeroed.

UPDATE platform_settings
   SET verify_charge_enabled = FALSE,
       verify_charge_amount  = 0,
       verify_charge_percent = 0
 WHERE id = 1;
