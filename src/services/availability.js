/**
 * Vendor payment availability.
 *
 * A marketplace hosts many sellers, but only some of them ever finish
 * onboarding with us. That is the steady state, not an error — so the
 * marketplace needs to know, BEFORE it renders a "Pay online" button, whether
 * a given vendor can actually take a payment right now.
 *
 * This module is the single definition of "payable". It is used by:
 *   - GET  /api/vendors/availability   → proactive check (bulk, cheap)
 *   - POST /api/payment/sessions       → fail fast with 422 instead of minting
 *                                        a session that dead-ends at checkout
 *
 * Every non-payable answer carries BOTH:
 *   - `reason`  — a stable enum the integrator branches on in code
 *   - `display` — pre-written bilingual copy they can drop straight into an
 *                 empty state without writing any of their own
 */
const pool = require('../db/pool');
const { getPlatformSettings, computeVendorVerifyFee } = require('./wallet');

/* Stable reason codes. Never rename one — integrators branch on these. */
const REASONS = {
  NOT_ONBOARDED:       'not_onboarded',
  NOT_REGISTERED:      'not_registered',
  NOT_ACTIVATED:       'not_activated',
  NO_GATEWAYS:         'no_gateways',
  ALL_PAUSED:          'all_paused',
  AMOUNT_OUT_OF_RANGE: 'amount_out_of_range',
  VENDOR_WALLET_EMPTY: 'vendor_wallet_empty',
};

/**
 * Human-readable copy per reason, EN + BN. `suggested_action` tells the
 * integrator's UI what to do: offer a different payment method, or just ask
 * the customer to retry later.
 */
function displayFor(reason, vendorLabel) {
  const who = vendorLabel ? `“${vendorLabel}”` : 'This seller';
  switch (reason) {
    case REASONS.NOT_ONBOARDED:
    case REASONS.NOT_REGISTERED:
    case REASONS.NOT_ACTIVATED:
    case REASONS.NO_GATEWAYS:
      return {
        title: 'Online payment unavailable',
        message: `${who} hasn’t set up online payment yet.`,
        message_bn: 'এই বিক্রেতা এখনো অনলাইন পেমেন্ট চালু করেননি।',
        suggested_action: 'offer_alternate_method',
      };
    case REASONS.ALL_PAUSED:
    case REASONS.VENDOR_WALLET_EMPTY:
      return {
        title: 'Online payment paused',
        message: `${who} is not accepting online payment right now.`,
        message_bn: 'এই বিক্রেতা এই মুহূর্তে অনলাইন পেমেন্ট গ্রহণ করছেন না।',
        suggested_action: 'offer_alternate_method',
      };
    case REASONS.AMOUNT_OUT_OF_RANGE:
      return {
        title: 'Amount not supported',
        message: `${who} cannot accept online payment for this amount.`,
        message_bn: 'এই পরিমাণ অর্থের জন্য এই বিক্রেতা অনলাইন পেমেন্ট নিতে পারবেন না।',
        suggested_action: 'offer_alternate_method',
      };
    default:
      return {
        title: 'Online payment unavailable',
        message: `${who} cannot take online payment right now.`,
        message_bn: 'এই বিক্রেতা এখন অনলাইন পেমেন্ট নিতে পারছেন না।',
        suggested_action: 'offer_alternate_method',
      };
  }
}

function unavailable(vendor, reason) {
  return {
    vendor_id:   vendor ? vendor.id : null,
    external_id: vendor ? vendor.external_id || null : null,
    label:       vendor ? vendor.label : null,
    payable:     false,
    reason,
    display:     displayFor(reason, vendor && vendor.label),
    methods:     [],
  };
}

/** Does this gateway accept `amount`? A null bound means "no limit". */
function acceptsAmount(gw, amount) {
  if (amount == null) return true;
  if (gw.min_amount != null && amount < Number(gw.min_amount)) return false;
  if (gw.max_amount != null && amount > Number(gw.max_amount)) return false;
  return true;
}

/**
 * Can this vendor's wallet cover the per-verification fee for `amount`?
 *
 * Mirrors services/wallet.js → checkVendorWalletSufficient, but reads the
 * balance off the vendor row we already loaded instead of issuing its own
 * query, so a bulk check stays at two round-trips regardless of vendor count.
 */
function vendorWalletCovers(vendor, amount, settings) {
  const type = settings.vendor_verify_charge_type || 'fixed';
  const charging = settings.vendor_verify_charge_enabled && (
    type === 'percent'
      ? Number(settings.vendor_verify_charge_percent) > 0
      : Number(settings.vendor_verify_charge_amount) > 0
  );
  if (!charging) return true; // platform isn't billing vendors → infinite credit

  const balance = Number(vendor.wallet_balance || 0);
  const fee = type === 'percent'
    ? (amount != null ? computeVendorVerifyFee(settings, amount) : 0)
    : Number(settings.vendor_verify_charge_amount);
  // Percent charging with no amount in hand: we can't know the exact fee, so we
  // only require a non-empty wallet and let debitVendorVerifyFee enforce the
  // real figure later (it refuses to go negative).
  const required = (type === 'percent' && amount == null) ? 0.01 : fee;
  return balance >= required;
}

/**
 * Decide whether one vendor can take a payment, and why not if they can't.
 *
 * `amount` is optional. When supplied, a vendor whose only gateways exclude
 * that amount is reported as `amount_out_of_range` rather than payable — the
 * checkout would otherwise show a number the customer can't legitimately use.
 *
 * Reason precedence runs from "furthest from paying" to "closest", so the
 * integrator always gets the most actionable explanation.
 */
function evaluateVendor(vendor, gateways, opts) {
  const { amount, settings } = opts;

  // Never registered a panel login → the seller never claimed their code.
  if (vendor.username == null) return unavailable(vendor, REASONS.NOT_REGISTERED);

  // Registered but hasn't paid the platform's one-time activation fee. When the
  // fee is 0 the gate is disabled platform-wide and every vendor passes.
  const activationFee = Number(settings.vendor_activation_fee || 0);
  if (activationFee > 0 && vendor.activated_at == null) {
    return unavailable(vendor, REASONS.NOT_ACTIVATED);
  }

  if (gateways.length === 0)                     return unavailable(vendor, REASONS.NO_GATEWAYS);
  const enabled = gateways.filter((g) => g.is_enabled);
  if (enabled.length === 0)                      return unavailable(vendor, REASONS.ALL_PAUSED);

  const usable = enabled.filter((g) => acceptsAmount(g, amount));
  if (usable.length === 0)                       return unavailable(vendor, REASONS.AMOUNT_OUT_OF_RANGE);

  // A vendor pays the per-verification fee from their OWN wallet. If they can't
  // cover it, submitTxn would reject the customer with a 402 after they'd
  // already sent the money. Surface it here instead.
  if (!vendorWalletCovers(vendor, amount, settings)) {
    return unavailable(vendor, REASONS.VENDOR_WALLET_EMPTY);
  }

  // Deduplicate to one entry per provider+variant — checkout shows one number
  // per pair, so that's what the marketplace should advertise.
  const seen = new Set();
  const methods = [];
  for (const g of usable) {
    const key = `${g.provider}:${g.variant}`;
    if (seen.has(key)) continue;
    seen.add(key);
    methods.push({
      provider:   g.provider,
      variant:    g.variant,
      min_amount: g.min_amount != null ? Number(g.min_amount) : null,
      max_amount: g.max_amount != null ? Number(g.max_amount) : null,
    });
  }

  return {
    vendor_id:   vendor.id,
    external_id: vendor.external_id || null,
    label:       vendor.label,
    payable:     true,
    reason:      null,
    display:     null,
    methods,
  };
}

/**
 * Bulk availability for a merchant's vendors.
 *
 * Pass `ids` (our vendor_ids) and/or `externalIds` (the marketplace's own
 * seller ids). Anything that doesn't resolve to a vendor row comes back as
 * `not_onboarded` so the caller always gets one entry per key it asked about.
 *
 * Two queries total regardless of how many vendors are requested.
 */
async function availabilityFor(merchantId, { ids = [], externalIds = [], amount = null } = {}) {
  const settings = await getPlatformSettings().catch(() => ({ vendor_activation_fee: 0 }));

  const rows = (ids.length || externalIds.length)
    ? (await pool.query(
        `SELECT id, label, external_id, username, activated_at, wallet_balance
           FROM accounts
          WHERE merchant_id = $1
            AND is_default = FALSE
            AND (id = ANY($2::uuid[]) OR external_id = ANY($3::text[]))`,
        [merchantId, ids, externalIds]
      )).rows
    : (await pool.query(
        `SELECT id, label, external_id, username, activated_at, wallet_balance
           FROM accounts
          WHERE merchant_id = $1 AND is_default = FALSE
          ORDER BY created_at ASC`,
        [merchantId]
      )).rows;

  const gatewaysByAccount = new Map();
  if (rows.length) {
    const g = await pool.query(
      `SELECT account_id, provider, variant, is_enabled, min_amount, max_amount
         FROM gateways WHERE account_id = ANY($1::uuid[])
        ORDER BY created_at ASC`,
      [rows.map((r) => r.id)]
    );
    for (const gw of g.rows) {
      if (!gatewaysByAccount.has(gw.account_id)) gatewaysByAccount.set(gw.account_id, []);
      gatewaysByAccount.get(gw.account_id).push(gw);
    }
  }

  const evaluated = rows.map((v) =>
    evaluateVendor(v, gatewaysByAccount.get(v.id) || [], { amount, settings })
  );

  // Re-key so the caller gets exactly the vendors it asked for, in order, with
  // `not_onboarded` filled in for keys we've never seen.
  if (!ids.length && !externalIds.length) return evaluated;

  const byId = new Map(evaluated.map((e) => [e.vendor_id, e]));
  const byExt = new Map(evaluated.filter((e) => e.external_id).map((e) => [e.external_id, e]));
  const out = [];
  for (const id of ids) {
    out.push(byId.get(id) || { ...unavailable(null, REASONS.NOT_ONBOARDED), vendor_id: id });
  }
  for (const ext of externalIds) {
    out.push(byExt.get(ext) || { ...unavailable(null, REASONS.NOT_ONBOARDED), external_id: ext });
  }
  return out;
}

/**
 * Single-vendor check used by createSession. `vendorId` must already be known
 * to belong to `merchantId`.
 */
async function availabilityForVendorId(merchantId, vendorId, amount = null) {
  const list = await availabilityFor(merchantId, { ids: [vendorId], amount });
  return list[0];
}

module.exports = { REASONS, displayFor, availabilityFor, availabilityForVendorId, acceptsAmount };
