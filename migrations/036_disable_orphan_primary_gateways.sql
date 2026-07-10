-- Marketplace-only model: a merchant is a platform integrator and owns no
-- payment numbers. Every gateway belongs to a vendor.
--
-- Merchants created before that switch may still have gateways sitting on their
-- Primary (is_default) account. Those are unreachable: customer checkout now
-- requires a vendor_id, and a Primary account is not a valid vendor — so no
-- customer can ever be shown, or pay into, one of these numbers.
--
-- Leaving them `is_enabled = TRUE` is misleading: it reads as "merchants are
-- supposed to have gateways" to anyone inspecting the schema. Pause them.
--
-- We PAUSE rather than DELETE, deliberately:
--   * transactions.gateway_id is ON DELETE RESTRICT — deleting a gateway that
--     ever took a payment would destroy that payment's history (and fail).
--   * pausing is one boolean, trivially reversible if this model ever changes.
--
-- The PLATFORM merchant is excluded. Its Primary gateways are how merchants and
-- vendors pay US (wallet top-up, vendor activation) — those sessions carry
-- account_id = NULL and resolve through the merchant_id branch of
-- listCheckoutGateways. Disabling them would break every top-up.

UPDATE gateways g
   SET is_enabled = FALSE,
       updated_at = NOW()
  FROM accounts a
  JOIN merchants m ON m.id = a.merchant_id
 WHERE a.id = g.account_id
   AND a.is_default = TRUE       -- the merchant's own account, not a vendor's
   AND m.is_platform = FALSE     -- never touch the platform's receiving numbers
   AND g.is_enabled = TRUE;
