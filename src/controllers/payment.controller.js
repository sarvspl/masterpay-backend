const pool = require('../db/pool');
const { generateSessionId } = require('../utils/session');
const { notifyVerifyRequest } = require('../utils/push');
const smsCtrl = require('./sms.controller');
const { creditWalletIfTopup, debitVerifyFee } = require('../services/wallet');
const { availabilityForVendorId, acceptsAmount } = require('../services/availability');

/**
 * Total amount the customer pays = bill + gateway charge − gateway discount.
 * Charges/discounts can be flat or percent of the bill. Result is clamped
 * to ≥ 0 (a discount can't make it negative) and rounded to 2 decimals.
 */
function computeGatewayTotal(billAmount, gateway) {
  const bill = Number(billAmount) || 0;
  const charge = computeFee(bill, gateway && gateway.charge_value, gateway && gateway.charge_type);
  const discount = computeFee(bill, gateway && gateway.discount_value, gateway && gateway.discount_type);
  const total = Math.max(0, bill + charge - discount);
  return Math.round(total * 100) / 100;
}
function computeFee(base, value, type) {
  const v = Number(value || 0);
  if (!v) return 0;
  if (String(type).toLowerCase() === 'percent') return base * (v / 100);
  return v; // 'flat' or anything else
}

const SESSION_TTL_MIN = 24 * 60; // 24 hours — keeps a pending session live so
                                 // the integrator can keep polling/updating status.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ───────────────────────────── MERCHANT-FACING (X-API-Key) */

/**
 * POST /api/payment/sessions
 * Body: { amount, order_id, redirect_url, currency?, customer_phone?, customer_name?, metadata? }
 * Returns: { session_id, checkout_url, expires_at, status }
 */
async function createSession(req, res, next) {
  try {
    const amount        = Number(req.body.amount);
    const order_id      = String(req.body.order_id || '').trim();
    const redirect_url  = String(req.body.redirect_url || '').trim();

    // Currency: explicit > merchant default > USD
    let currency = req.body.currency ? String(req.body.currency).toUpperCase() : null;
    if (!currency) {
      const m = await pool.query('SELECT currency FROM merchants WHERE id = $1', [req.brand.merchant_id]);
      currency = (m.rows[0] && m.rows[0].currency) || 'USD';
    }

    const customer_phone = req.body.customer_phone ? String(req.body.customer_phone).trim() : null;
    const customer_name  = req.body.customer_name ? String(req.body.customer_name).trim() : null;
    const metadata       = req.body.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : null;

    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
    if (!order_id)                                return res.status(400).json({ error: 'order_id is required' });
    if (order_id.length > 120)                    return res.status(400).json({ error: 'order_id must be at most 120 characters' });
    if (!redirect_url)                            return res.status(400).json({ error: 'redirect_url is required' });
    try { new URL(redirect_url); } catch { return res.status(400).json({ error: 'redirect_url must be a valid URL' }); }

    // Vendor scoping is MANDATORY. A merchant is a marketplace: it owns no
    // payment numbers of its own, so every session must name the vendor being
    // paid. The checkout then shows only that vendor's gateways and only that
    // vendor's phone(s) are notified.
    const vendorId = String(req.body.vendor_id || '').trim();
    if (!vendorId)               return res.status(400).json({ error: 'vendor_id is required' });
    if (!UUID_RE.test(vendorId)) return res.status(400).json({ error: 'vendor_id is not a valid id' });
    const v = await pool.query(
      'SELECT id FROM accounts WHERE id = $1 AND merchant_id = $2 AND is_default = FALSE',
      [vendorId, req.brand.merchant_id]
    );
    if (v.rowCount === 0) return res.status(400).json({ error: 'Invalid vendor_id for this merchant' });
    const account_id = v.rows[0].id;

    // Fail fast. Most marketplaces call GET /api/vendors/availability before
    // rendering a Pay button, but one that doesn't must still get a clean,
    // machine-readable answer here rather than a session whose checkout page
    // has nothing to show. Same `reason` + `display` shape as availability.
    const avail = await availabilityForVendorId(req.brand.merchant_id, account_id, amount);
    if (!avail.payable) {
      return res.status(422).json({
        error:     'vendor_unavailable',
        reason:    avail.reason,
        vendor_id: account_id,
        payable:   false,
        display:   avail.display,
      });
    }

    const baseUrl = process.env.PUBLIC_CHECKOUT_BASE_URL || 'http://localhost:3000';

    /* ─── Dedup by (merchant_id, order_id): Option B ─── */
    //
    //   - If any prior session for this order is success → 409 (anti-double-pay).
    //   - If a prior session is still pending and not expired → return THAT
    //     session's checkout_url instead of minting a new one. Idempotent for
    //     legitimate retries ("customer clicked Buy twice", network blip).
    //   - All other states (expired, failed, cancelled) → fine to create a new session.
    const prior = await pool.query(
      `SELECT id, status, expires_at, amount, currency
         FROM payment_sessions
        WHERE merchant_id = $1 AND order_id = $2
        ORDER BY created_at DESC
        LIMIT 5`,
      [req.brand.merchant_id, order_id]
    );

    const paid = prior.rows.find((r) => r.status === 'success');
    if (paid) {
      return res.status(409).json({
        error: 'This order has already been paid.',
        existing_session_id: paid.id,
      });
    }

    const livePending = prior.rows.find(
      (r) => r.status === 'pending' && new Date(r.expires_at) > new Date()
    );
    if (livePending) {
      // Idempotent: same order_id, same merchant, prior session still alive →
      // return the original checkout so the customer continues on the same
      // session instead of creating a parallel one.
      return res.status(200).json({
        session_id:   livePending.id,
        checkout_url: `${baseUrl}/pay/${livePending.id}`,
        expires_at:   new Date(livePending.expires_at).toISOString(),
        status:       'pending',
        existed:      true,
      });
    }

    const id = generateSessionId();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MIN * 60 * 1000);

    await pool.query(
      `INSERT INTO payment_sessions
         (id, merchant_id, brand_id, account_id, order_id, amount, currency, customer_phone, customer_name, redirect_url, metadata, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, req.brand.merchant_id, req.brand.brand_id, account_id, order_id, amount, currency, customer_phone, customer_name, redirect_url, metadata, expiresAt]
    );

    res.status(201).json({
      session_id: id,
      checkout_url: `${baseUrl}/pay/${id}`,
      expires_at: expiresAt.toISOString(),
      status: 'pending',
    });
  } catch (e) {
    // Defensive: lose a race against the partial unique index uniq_paid_session_per_order
    if (e && e.code === '23505' && /uniq_paid_session_per_order/.test(e.constraint || '')) {
      return res.status(409).json({ error: 'This order has already been paid.' });
    }
    next(e);
  }
}

/**
 * GET /api/payment/sessions/:id  (merchant queries final status)
 */
async function getSessionForMerchant(req, res, next) {
  try {
    const r = await pool.query(
      `SELECT s.*,
              (SELECT row_to_json(t) FROM (
                 SELECT id, txnid_submitted, status, verified_at, result_source
                 FROM transactions
                 WHERE session_id = s.id AND status = 'success'
                 ORDER BY verified_at DESC NULLS LAST LIMIT 1
              ) t) AS successful_transaction,
              -- Latest transaction of ANY status, with the details a merchant
              -- server needs to verify a payment: UTR, payment method, and the
              -- customer's sender account.
              (SELECT row_to_json(lt) FROM (
                 SELECT t.id,
                        t.txnid_submitted,
                        g.provider AS method,
                        g.variant,
                        g.account_number,
                        t.sender_account,
                        t.amount,
                        t.status,
                        t.result_source,
                        t.failure_reason,
                        t.verified_at,
                        t.created_at
                   FROM transactions t
                   LEFT JOIN gateways g ON g.id = t.gateway_id
                  WHERE t.session_id = s.id
                  ORDER BY t.created_at DESC
                  LIMIT 1
              ) lt) AS latest_transaction
         FROM payment_sessions s
        WHERE s.id = $1 AND s.merchant_id = $2`,
      [req.params.id, req.brand.merchant_id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Session not found' });
    res.json({ session: r.rows[0] });
  } catch (e) { next(e); }
}

/* ───────────────────────────── PUBLIC CHECKOUT (no auth, by session id) */

/**
 * Backs every public checkout endpoint. The session id is the only secret, so
 * whatever this selects is readable by anyone holding a checkout URL.
 *
 * It deliberately does NOT join the vendor's label. Checkout is
 * marketplace-branded — the customer sees the marketplace, never the seller's
 * name — so exposing `accounts.label` here would leak seller identity.
 */
async function loadSession(sessionId) {
  const r = await pool.query(
    `SELECT s.id, s.amount, s.currency, s.order_id, s.customer_phone, s.customer_name,
            s.redirect_url, s.status, s.expires_at, s.created_at,
            s.merchant_id, s.brand_id, s.account_id, s.metadata,
            m.name AS merchant_name,
            b.name AS brand_name, b.domain AS brand_domain
       FROM payment_sessions s
       JOIN merchants m ON m.id = s.merchant_id
       JOIN brands    b ON b.id = s.brand_id
      WHERE s.id = $1`,
    [sessionId]
  );
  return r.rows[0] || null;
}

async function autoExpire(session) {
  if (session.status === 'pending' && new Date(session.expires_at) < new Date()) {
    await pool.query(
      `UPDATE payment_sessions SET status='expired', updated_at=NOW() WHERE id=$1 AND status='pending'`,
      [session.id]
    );
    session.status = 'expired';
  }
}

async function getCheckoutSession(req, res, next) {
  try {
    const s = await loadSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'Session not found' });
    await autoExpire(s);
    res.json({ session: s });
  } catch (e) { next(e); }
}

async function listCheckoutGateways(req, res, next) {
  try {
    const s = await loadSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'Session not found' });

    // Round-robin: a merchant may hold the same provider+variant number on
    // several accounts (one per account). Show ONE number per provider+variant,
    // picking the least-recently-shown (last_shown_at ASC), then stamp NOW() so
    // the next checkout rotates to the other(s). Pick + stamp in one statement
    // so they stay atomic.
    //
    // Customer sessions are always vendor-scoped (account_id set) — restrict to
    // THAT vendor's gateways so the customer only ever sees the vendor they're
    // buying from.
    //
    // The merchant_id fallback is NOT legacy dead code: the platform's own
    // checkouts (merchant wallet top-up, vendor activation, vendor top-up)
    // insert sessions directly with account_id = NULL and rely on this branch to
    // surface the platform merchant's receiving numbers. Removing it breaks
    // every top-up and activation payment.
    const scopeCol = s.account_id ? 'account_id' : 'merchant_id';
    const scopeVal = s.account_id || s.merchant_id;

    // A gateway whose min/max excludes this order's amount can't legitimately
    // take it, so never offer it — the customer would otherwise pick it and get
    // stuck. A NULL bound means "no limit".
    const r = await pool.query(
      `WITH picked AS (
         SELECT DISTINCT ON (provider, variant) id
           FROM gateways
          WHERE ${scopeCol} = $1 AND is_enabled = TRUE
            AND (min_amount IS NULL OR $2 >= min_amount)
            AND (max_amount IS NULL OR $2 <= max_amount)
          ORDER BY provider, variant, last_shown_at ASC NULLS FIRST, id
       ),
       bumped AS (
         UPDATE gateways g
            SET last_shown_at = NOW()
           FROM picked p
          WHERE g.id = p.id
        RETURNING g.id, g.provider, g.variant, g.account_number, g.label,
                  g.min_amount, g.max_amount, g.charge_value, g.charge_type,
                  g.discount_value, g.discount_type
       )
       SELECT * FROM bumped ORDER BY provider ASC, variant ASC`,
      [scopeVal, Number(s.amount)]
    );
    res.json({ gateways: r.rows });
  } catch (e) { next(e); }
}

/**
 * POST /api/checkout/:sessionId/submit
 * Body: { gateway_id, txnid }
 *
 * Resolution order:
 *   1. If an SMS already received for this merchant contains this TxnID and
 *      the amount/gateway matches → create a success transaction immediately.
 *   2. If an "inbound" success transaction already exists for this TxnID
 *      (i.e. SMS arrived first and created its own row with no session_id) →
 *      claim it for this session.
 *   3. If this TxnID was already used on a DIFFERENT session → reject (anti-replay).
 *   4. Otherwise insert a pending transaction and ping the merchant's APK(s)
 *      via FCM so they can approve/reject from the phone.
 */
async function submitTxn(req, res, next) {
  try {
    const s = await loadSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'Session not found' });
    await autoExpire(s);

    if (s.status !== 'pending') {
      return res.status(409).json({ error: `Session is ${s.status}` });
    }

    // Wallet gate: even though the session was created when the merchant had
    // balance, if they've since gone to zero we shouldn't accept new verify
    // submissions. New pending transactions can't be auto-cleared anyway —
    // APK + lazy re-match are blocked by their own walletGuards — so creating
    // them just clutters the dashboard.
    //
    // Response shape mirrors walletGuard.rejectCustomerSafe so the customer
    // sees a neutral message even if the merchant's integration renders the
    // raw JSON.
    // Wallet gate. For a vendor-scoped session the VENDOR pays the fee, so gate
    // on the vendor's wallet (at the exact fee for this amount); otherwise the
    // merchant's.
    const { checkWalletSufficient, checkVendorWalletSufficient } = require('../services/wallet');
    const wallet = s.account_id
      ? await checkVendorWalletSufficient(s.account_id, Number(s.amount))
      : await checkWalletSufficient(s.merchant_id);
    if (!wallet.ok) {
      return res.status(402).json({
        error: 'Services currently unavailable.',
        merchant_message: s.account_id
          ? 'The vendor’s wallet has insufficient balance to cover the per-verification fee.'
          : 'Merchant wallet has insufficient balance to cover the per-verification fee. Top up at the dashboard.',
        insufficient_balance: true,
        code: s.account_id ? 'vendor_wallet_empty' : 'merchant_wallet_empty',
      });
    }

    const gateway_id = String(req.body.gateway_id || '').trim();
    const txnid      = String(req.body.txnid || '').trim();
    if (!gateway_id) return res.status(400).json({ error: 'gateway_id is required' });
    if (!txnid)      return res.status(400).json({ error: 'Transaction ID is required' });

    // Required payment proof: the sender's number + a screenshot of the
    // confirmation. Presence is validated here (fail fast); the screenshot file
    // is only written once we know we'll create/link a transaction (below).
    const sender_account = String(req.body.sender_account || '').trim();
    const proof_image    = typeof req.body.proof_image === 'string' ? req.body.proof_image : '';
    if (!sender_account) return res.status(400).json({ error: 'Sender number is required' });
    if (!/^[0-9+\-\s]{4,40}$/.test(sender_account)) return res.status(400).json({ error: 'Enter a valid sender mobile/account number' });
    if (!proof_image)    return res.status(400).json({ error: 'Payment screenshot is required' });

    // Validate gateway belongs to this merchant
    const g = await pool.query(
      `SELECT id, provider, variant, account_number, label, account_id, min_amount, max_amount
         FROM gateways WHERE id = $1 AND merchant_id = $2 AND is_enabled = TRUE`,
      [gateway_id, s.merchant_id]
    );
    if (g.rowCount === 0) return res.status(400).json({ error: 'Invalid gateway for this merchant' });
    const gateway = g.rows[0];

    // listCheckoutGateways already hides gateways whose min/max excludes this
    // order. Re-check here so a hand-crafted gateway_id can't slip past it.
    if (!acceptsAmount(gateway, Number(s.amount))) {
      return res.status(400).json({ error: 'This payment method does not accept this amount.' });
    }

    // Vendor-scoped session: the chosen gateway must belong to the session's
    // vendor. Guards against a tampered gateway_id routing a payment to (and
    // notifying) the wrong vendor's phone.
    if (s.account_id && gateway.account_id !== s.account_id) {
      return res.status(400).json({ error: 'Invalid gateway for this vendor' });
    }

    // Vendor activation / wallet top-up paid through the hosted checkout: the
    // session metadata tags which vendor to settle. We stamp the transaction so
    // the existing settle hook (settleForTransaction) activates / credits on
    // success, and the admin's Vendor-payments queue picks it up.
    const _sm = s.metadata || {};
    const vActivationAcct = _sm.type === 'vendor_activation' ? (_sm.account_id || null) : null;
    const vTopupAcct      = _sm.type === 'vendor_topup'      ? (_sm.account_id || null) : null;
    const vTopupCredit    = _sm.type === 'vendor_topup'      ? (_sm.credit_amount ?? null) : null;

    /* ─── Session-lock: one Verify per session ─── */
    //
    //   Once a TxnID has been submitted for this session, the method is locked
    //   in. A subsequent submit (different gateway, different TxnID, etc.) is
    //   rejected so the customer can't fork the session across multiple
    //   pending rows. Idempotent retry of the same TxnID is handled below.
    const sessionTx = await pool.query(
      `SELECT id, txnid_submitted, status FROM transactions
        WHERE session_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [s.id]
    );
    if (sessionTx.rowCount > 0) {
      const t = sessionTx.rows[0];
      const sameTxn = t.txnid_submitted && t.txnid_submitted.toLowerCase() === txnid.toLowerCase();
      if (!sameTxn) {
        return res.status(409).json({
          error: 'This checkout already has a submitted Transaction ID. You can\'t change the payment method.',
          existing_status: t.status,
        });
      }
    }

    /* ─── (0) Idempotency: this merchant already has a transaction for this TxnID ─── */
    //
    //   A TxnID is supposed to be globally unique (it's a wallet transaction id),
    //   so seeing one twice is either a retry / accidental double-submit, or an
    //   attempt to reuse one payment for two orders. Either way we never want a
    //   second row — return whatever state the first one is in.
    const existing = await pool.query(
      `SELECT id, session_id, status, amount, created_at, failure_reason
         FROM transactions
        WHERE merchant_id = $1 AND LOWER(txnid_submitted) = LOWER($2)
        ORDER BY created_at DESC LIMIT 1`,
      [s.merchant_id, txnid]
    );
    if (existing.rowCount > 0) {
      const e = existing.rows[0];

      // Same session → idempotent retry.
      if (e.session_id === s.id) {
        return res.status(200).json({ transaction: e, duplicate_submit: true });
      }

      // Inbound success (no session yet) with matching amount → fall through to Path A claim logic.
      // Compare against the TOTAL customer pays (bill + gateway charge − discount),
      // since inbound rows were created from the SMS's credited amount.
      const claimTotal = computeGatewayTotal(s.amount, gateway);
      const isClaimableInbound =
        e.status === 'success' && e.session_id === null && Number(e.amount) === claimTotal;
      if (!isClaimableInbound) {
        // Anything else: this TxnID is already accounted for on another order.
        // Return the existing transaction's state instead of creating a duplicate.
        return res.status(409).json({
          error:
            e.status === 'success' ? 'This Transaction ID has already been used for another payment.' :
            e.status === 'failed'  ? 'This Transaction ID was already rejected. Please use a fresh transaction.' :
            /* pending */            'This Transaction ID is already being verified for another order.',
          existing_status: e.status,
          transaction: e,
        });
      }
    }

    // All early-exit checks passed — we will create or link a transaction now,
    // so persist the screenshot to disk. Doing it here (not earlier) avoids
    // orphan files when the request bailed out above.
    let proof_image_url = null;
    try {
      proof_image_url = require('../services/proof').saveProofImage(proof_image);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }

    /* ─── (A) Claim an inbound success that arrived from SMS already ─── */
    //
    //   tryCreateInbound() may have already created a success row with
    //   matched_sms set and session_id NULL. If its TxnID matches what the
    //   customer just typed, link it to this session.
    const inbound = await pool.query(
      `SELECT id, amount FROM transactions
        WHERE merchant_id = $1
          AND LOWER(txnid_submitted) = LOWER($2)
          AND status = 'success'
          AND session_id IS NULL
        LIMIT 1`,
      [s.merchant_id, txnid]
    );
    if (inbound.rowCount > 0) {
      // Sanity: amount must match the total customer pays (bill + gateway charge − discount).
      if (Number(inbound.rows[0].amount) === computeGatewayTotal(s.amount, gateway)) {
        const upd = await pool.query(
          `UPDATE transactions
              SET session_id = $1, brand_id = $2, customer_phone = COALESCE(customer_phone, $3),
                  sender_account = $5, proof_image_url = $6, updated_at = NOW(),
                  activation_account_id = COALESCE(activation_account_id, $7),
                  vendor_topup_account_id = COALESCE(vendor_topup_account_id, $8),
                  vendor_topup_credit_amount = COALESCE(vendor_topup_credit_amount, $9)
            WHERE id = $4
            RETURNING id, status, created_at`,
          [s.id, s.brand_id, s.customer_phone, inbound.rows[0].id, sender_account, proof_image_url, vActivationAcct, vTopupAcct, vTopupCredit]
        );
        await pool.query(
          `UPDATE payment_sessions SET status='success', updated_at=NOW() WHERE id=$1 AND status='pending'`,
          [s.id]
        );
        await creditWalletIfTopup(s.id).catch((e) => console.error('[wallet] credit failed (inbound claim):', e.message));
        await require('../services/activation').settleForTransaction(pool, upd.rows[0].id).catch((e) => console.error('[settle] failed (inbound claim):', e.message));
        await debitVerifyFee(s.merchant_id, upd.rows[0].id, s.id).catch((e) => console.error('[wallet] debit failed (inbound claim):', e.message));
        return res.status(200).json({ transaction: upd.rows[0], auto_matched: 'inbound' });
      }
    }

    /* ─── (B) Anti-replay: handled by Path (0). ─── */

    /* ─── (C) Late match: search received SMS for this TxnID ─── */
    //
    //   The SMS might be in sms_messages but unmatched (e.g. amount parser
    //   missed it). Walk the last 15 minutes and try a strict match.
    const smsRows = await pool.query(
      `SELECT id, body FROM sms_messages
        WHERE merchant_id = $1
          AND received_at > NOW() - INTERVAL '15 minutes'
          AND LOWER(body) LIKE LOWER('%' || $2 || '%')
        ORDER BY received_at DESC
        LIMIT 5`,
      [s.merchant_id, txnid]
    );
    for (const sms of smsRows.rows) {
      // Reject debit SMS
      if (smsCtrl.extractDirection(sms.body) === 'debit') continue;
      // Must reference THIS gateway's account
      const matchedGw = smsCtrl.findGatewayInSms(sms.body, [gateway]);
      if (!matchedGw) continue;
      // Strict txnid + amount check — match against the TOTAL the customer
      // pays (bill + gateway charge − discount), not just the bill.
      const total = computeGatewayTotal(s.amount, gateway);
      const ok = smsCtrl.smsMatchesTransaction(sms.body, {
        txnid_submitted: txnid,
        amount: total,
        customer_phone: null,         // session phone is optional / often missing in SMS
      });
      if (!ok) continue;

      const payer = smsCtrl.extractPayer(sms.body);
      const ins = await pool.query(
        `INSERT INTO transactions
           (session_id, merchant_id, brand_id, gateway_id, txnid_submitted, amount, customer_phone,
            status, result_source, matched_sms, verified_at, payer_name, payer_phone,
            sender_account, proof_image_url, activation_account_id, vendor_topup_account_id, vendor_topup_credit_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'success','sms_late_match',$8,NOW(),$9,$10,$11,$12,$13,$14,$15)
         RETURNING id, status, created_at`,
        [s.id, s.merchant_id, s.brand_id, gateway.id, txnid, total, s.customer_phone,
         sms.body, payer.name, payer.phone, sender_account, proof_image_url, vActivationAcct, vTopupAcct, vTopupCredit]
      );
      await pool.query(`UPDATE sms_messages SET matched_tx_id = $1 WHERE id = $2`, [ins.rows[0].id, sms.id]);
      await pool.query(
        `UPDATE payment_sessions SET status='success', updated_at=NOW() WHERE id=$1 AND status='pending'`,
        [s.id]
      );
      await creditWalletIfTopup(s.id).catch((e) => console.error('[wallet] credit failed (late sms):', e.message));
      await require('../services/activation').settleForTransaction(pool, ins.rows[0].id).catch((e) => console.error('[settle] failed (late sms):', e.message));
      await debitVerifyFee(s.merchant_id, ins.rows[0].id, s.id).catch((e) => console.error('[wallet] debit failed (late sms):', e.message));
      return res.status(200).json({ transaction: ins.rows[0], auto_matched: 'sms' });
    }

    /* ─── (D) No auto-match — create pending and ping the APK(s) ─── */
    //   Transaction amount is the TOTAL the customer paid (bill + gateway
    //   charge − discount), so when the SMS arrives the matcher sees the
    //   same number.
    const totalD = computeGatewayTotal(s.amount, gateway);
    const r = await pool.query(
      `INSERT INTO transactions
         (session_id, merchant_id, brand_id, gateway_id, txnid_submitted, amount, customer_phone,
          sender_account, proof_image_url, activation_account_id, vendor_topup_account_id, vendor_topup_credit_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, status, created_at`,
      [s.id, s.merchant_id, s.brand_id, gateway.id, txnid, totalD, s.customer_phone,
       sender_account, proof_image_url, vActivationAcct, vTopupAcct, vTopupCredit]
    );

    // Fire-and-forget — never block the customer's response on push delivery.
    // Scope by the gateway's account: only the phone(s) bound to THIS vendor's
    // account are notified (every gateway has an account_id, so this also keeps
    // single-account merchants correctly scoped to their one account).
    notifyVerifyRequest(s.merchant_id, {
      verification_id: r.rows[0].id,
      txnid,
      amount:          Number(totalD).toFixed(2),
      currency:        s.currency,
      provider:        gateway.provider,
      account_number:  gateway.account_number,
      customer_phone:  s.customer_phone,
      customer_name:   s.customer_name,
      order_id:        s.order_id,
      created_at:      r.rows[0].created_at,
    }, gateway.account_id).catch((e) => console.warn('[push] notifyVerifyRequest failed:', e.message));

    res.status(202).json({ transaction: r.rows[0] });
  } catch (e) { next(e); }
}

/**
 * GET /api/checkout/:sessionId/status
 * Returns: { status, transaction?, redirect_url }
 */
async function checkoutStatus(req, res, next) {
  try {
    const s = await loadSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'Session not found' });
    await autoExpire(s);

    let lastTx = await loadLatestTxForSession(s.id);

    // Lazy re-match — if the latest tx is still pending, search received
    // SMS for a match. Since SMS upload no longer auto-flips transactions,
    // this is the path that catches "SMS arrived AFTER customer hit Verify".
    //
    // BUT: only fire when the merchant still has wallet balance for the
    // verification fee. If they've gone to zero, the pending tx stays
    // pending until they top up (their dashboard banner tells them).
    if (lastTx && lastTx.status === 'pending') {
      const { checkWalletSufficient } = require('../services/wallet');
      const wallet = await checkWalletSufficient(s.merchant_id);
      if (wallet.ok) {
        const flipped = await tryLateMatchForSession(s, lastTx);
        if (flipped) lastTx = await loadLatestTxForSession(s.id);
      }
    }

    let sessionStatus = s.status;
    if (lastTx && lastTx.status === 'success' && s.status === 'pending') {
      await pool.query(`UPDATE payment_sessions SET status='success', updated_at=NOW() WHERE id=$1`, [s.id]);
      sessionStatus = 'success';
      await creditWalletIfTopup(s.id).catch((e) => console.error('[wallet] credit failed (status promo):', e.message));
      await require('../services/activation').settleForTransaction(pool, lastTx.id).catch((e) => console.error('[settle] failed (status promo):', e.message));
      await debitVerifyFee(s.merchant_id, lastTx.id, s.id).catch((e) => console.error('[wallet] debit failed (status promo):', e.message));
    }

    res.json({
      status:       sessionStatus,
      transaction:  lastTx,
      redirect_url: s.redirect_url,
    });
  } catch (e) { next(e); }
}

async function loadLatestTxForSession(sessionId) {
  const tx = await pool.query(
    `SELECT id, txnid_submitted, amount, status, failure_reason, verified_at, result_source, gateway_id
       FROM transactions
      WHERE session_id = $1
      ORDER BY created_at DESC LIMIT 1`,
    [sessionId]
  );
  return tx.rows[0] || null;
}

/**
 * Tries to flip a single pending transaction to success by searching received
 * SMS for a matching TxnID + amount + gateway. Called on every status poll
 * by the customer's checkout page — at most one DB hit per poll, cheap.
 *
 * Returns true if it flipped.
 */
async function tryLateMatchForSession(s, lastTx) {
  if (!lastTx || lastTx.status !== 'pending') return false;
  const txnid = lastTx.txnid_submitted;
  if (!txnid) return false;

  // Resolve the gateway used at submit time so we can validate the SMS arrived to
  // the right account.
  const g = await pool.query(
    `SELECT id, provider, variant, account_number, label
       FROM gateways WHERE id = $1`,
    [lastTx.gateway_id]
  );
  if (g.rowCount === 0) return false;
  const gateway = g.rows[0];

  const smsRows = await pool.query(
    `SELECT id, body FROM sms_messages
      WHERE merchant_id = $1
        AND received_at > NOW() - INTERVAL '15 minutes'
        AND LOWER(body) LIKE LOWER('%' || $2 || '%')
      ORDER BY received_at DESC
      LIMIT 5`,
    [s.merchant_id, txnid]
  );
  for (const sms of smsRows.rows) {
    if (smsCtrl.extractDirection(sms.body) === 'debit') continue;
    if (!smsCtrl.findGatewayInSms(sms.body, [gateway])) continue;
    const ok = smsCtrl.smsMatchesTransaction(sms.body, {
      txnid_submitted: txnid,
      amount: Number(lastTx.amount),
      customer_phone: null,
    });
    if (!ok) continue;

    const payer = smsCtrl.extractPayer(sms.body);
    await pool.query(
      `UPDATE transactions
          SET status='success',
              result_source='sms_late_match',
              matched_sms=$2,
              verified_at=NOW(),
              updated_at=NOW(),
              payer_name=COALESCE(payer_name, $3),
              payer_phone=COALESCE(payer_phone, $4)
        WHERE id=$1 AND status='pending'`,
      [lastTx.id, sms.body, payer.name, payer.phone]
    );
    await pool.query(`UPDATE sms_messages SET matched_tx_id=$1 WHERE id=$2`, [lastTx.id, sms.id]);
    return true;
  }
  return false;
}

async function cancelCheckout(req, res, next) {
  try {
    const s = await loadSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'Session not found' });
    if (s.status !== 'pending') return res.json({ ok: true, status: s.status });
    await pool.query(`UPDATE payment_sessions SET status='cancelled', updated_at=NOW() WHERE id=$1`, [s.id]);
    res.json({ ok: true, status: 'cancelled' });
  } catch (e) { next(e); }
}

/* ───────────────────────────── MERCHANT DASHBOARD: list + manual resolve */

async function listTransactions(req, res, next) {
  try {
    const status = req.query.status && ['pending', 'success', 'failed'].includes(req.query.status)
      ? req.query.status : null;
    const q = req.query.q ? String(req.query.q).trim() : null;
    const limit = Math.min(200, Number(req.query.limit) || 50);

    const accountId = req.query.account_id ? String(req.query.account_id) : null;
    const deviceId  = req.query.device_id  ? String(req.query.device_id)  : null;

    const params = [req.merchant.id];
    let sql = `SELECT t.id, t.session_id, t.txnid_submitted, t.amount, t.status, t.customer_phone,
                      t.result_source, t.result_device_id, t.verified_at, t.failure_reason, t.created_at,
                      t.payer_name, t.payer_phone, t.sender_account, t.proof_image_url, t.matched_sms,
                      g.provider, g.variant, g.account_number, g.label AS gateway_label,
                      g.account_id, a.label AS account_label, a.is_default AS account_is_default,
                      d.id AS device_uuid, d.model AS device_model, d.manufacturer AS device_manufacturer,
                      s.order_id, s.currency AS session_currency, s.redirect_url,
                      b.name AS brand_name, b.domain AS brand_domain,
                      t.activation_account_id, t.vendor_topup_account_id,
                      va.label AS activation_vendor_label, va.username AS activation_vendor_username,
                      vt.label AS topup_vendor_label, vt.username AS topup_vendor_username
                 FROM transactions t
                 JOIN gateways g ON g.id = t.gateway_id
                 LEFT JOIN accounts a ON a.id = g.account_id
                 LEFT JOIN accounts va ON va.id = t.activation_account_id
                 LEFT JOIN accounts vt ON vt.id = t.vendor_topup_account_id
                 LEFT JOIN devices  d ON d.merchant_id = t.merchant_id AND d.device_id = t.result_device_id
                 LEFT JOIN payment_sessions s ON s.id = t.session_id
                 LEFT JOIN brands b ON b.id = COALESCE(t.brand_id, s.brand_id)
                WHERE t.merchant_id = $1`;
    // A marketplace operator must not see its sellers' payments — those are the
    // vendor's business (customer numbers, transaction ids, proof screenshots).
    // Set by the merchant-dashboard route only; the vendor panel and the admin
    // console reach this same controller and must keep seeing their own rows.
    if (req.hideVendorTxns) {
      sql += ` AND NOT (a.is_default = FALSE AND (a.external_id IS NOT NULL OR a.username IS NOT NULL))`;
    }
    if (status)    { params.push(status); sql += ` AND t.status = $${params.length}`; }
    if (q)         { params.push(`%${q.toLowerCase()}%`); sql += ` AND (LOWER(t.txnid_submitted) LIKE $${params.length} OR LOWER(s.order_id) LIKE $${params.length})`; }
    if (accountId) { params.push(accountId); sql += ` AND g.account_id = $${params.length}`; }
    if (deviceId)  { params.push(deviceId);  sql += ` AND t.result_device_id = $${params.length}`; }
    sql += ` ORDER BY t.created_at DESC LIMIT ${limit}`;

    const r = await pool.query(sql, params);
    res.json({ transactions: r.rows });
  } catch (e) { next(e); }
}

async function manualResolve(req, res, next) {
  try {
    const result = String(req.body.result || '').toLowerCase();
    if (!['success', 'failed'].includes(result)) {
      return res.status(400).json({ error: 'result must be "success" or "failed"' });
    }
    const reason = req.body.reason ? String(req.body.reason).slice(0, 240) : null;

    // Wallet gate — only for `success` resolution (debit fires). Marking
    // failed is free and stays allowed at any balance. For a transaction on a
    // VENDOR account the vendor pays the fee, so gate on the vendor's wallet;
    // otherwise the merchant's. This blocks a manual approve when the payer
    // can't cover the per-verification fee (no free verifications).
    if (result === 'success') {
      const { checkWalletSufficient, checkVendorWalletSufficient } = require('../services/wallet');
      const acc = await pool.query(
        `SELECT a.id AS account_id, a.is_default, a.external_id, a.username, t.amount
           FROM transactions t JOIN gateways g ON g.id = t.gateway_id JOIN accounts a ON a.id = g.account_id
          WHERE t.id = $1 AND t.merchant_id = $2`,
        [req.params.id, req.merchant.id]
      );
      const isVendorTx = acc.rowCount > 0 && !acc.rows[0].is_default && (acc.rows[0].external_id != null || acc.rows[0].username != null);
      const wallet = isVendorTx
        ? await checkVendorWalletSufficient(acc.rows[0].account_id, Number(acc.rows[0].amount))
        : await checkWalletSufficient(req.merchant.id);
      if (!wallet.ok) {
        return res.status(402).json({
          error: isVendorTx
            ? 'This vendor’s wallet is too low to confirm this payment. Ask them to top up first.'
            : 'Top up your wallet to resolve pending verifications.',
          merchant_message:
            'Confirming a verification debits the per-verification fee, but the payer’s wallet balance is below the fee. Top up first, then retry.',
          insufficient_balance: true,
          code: isVendorTx ? 'vendor_wallet_empty' : 'merchant_wallet_empty',
        });
      }
    }

    // Lookup the target row first so we can detect the dupe-success case
    // (another row with the same TxnID is already success) BEFORE the UPDATE
    // would fail at the partial unique index `uniq_tx_merchant_txnid_success`.
    const target = await pool.query(
      `SELECT id, session_id, status, txnid_submitted
         FROM transactions WHERE id = $1 AND merchant_id = $2`,
      [req.params.id, req.merchant.id]
    );
    if (target.rowCount === 0) return res.status(404).json({ error: 'Transaction not found' });
    if (target.rows[0].status !== 'pending') {
      return res.status(409).json({
        error: `Transaction already ${target.rows[0].status}.`,
        existing_status: target.rows[0].status,
      });
    }

    // If marking success, check for an existing success row with the same TxnID.
    // Surface it as a graceful response instead of leaking the unique-violation.
    if (result === 'success') {
      const dup = await pool.query(
        `SELECT id, session_id FROM transactions
          WHERE merchant_id = $1
            AND LOWER(txnid_submitted) = LOWER($2)
            AND status = 'success'
          LIMIT 1`,
        [req.merchant.id, target.rows[0].txnid_submitted]
      );
      if (dup.rowCount > 0) {
        return res.status(409).json({
          error: 'This Transaction ID is already marked Paid on another order.',
          existing_success_id: dup.rows[0].id,
          existing_session_id: dup.rows[0].session_id,
        });
      }
    }

    // Store the optional reason on both outcomes — the column is named
    // `failure_reason` for historical reasons but it's used as a free-form
    // "manual note" for any result. Defaults to a placeholder for failed
    // when the merchant didn't enter one (so the customer's result page has
    // something to show); success without a reason stays null.
    const storedReason = reason || (result === 'failed' ? 'Manually marked failed' : null);
    const r = await pool.query(
      `UPDATE transactions
          SET status = $1,
              result_source = 'manual',
              failure_reason = $2,
              verified_at = NOW(),
              updated_at = NOW()
        WHERE id = $3 AND merchant_id = $4 AND status = 'pending'
        RETURNING id, session_id, status`,
      [result, storedReason, req.params.id, req.merchant.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Pending transaction not found' });

    if (result === 'success') {
      await pool.query(
        `UPDATE payment_sessions SET status='success', updated_at=NOW() WHERE id=$1 AND status='pending'`,
        [r.rows[0].session_id]
      );
      // If this was a vendor-activation payment, unlock that vendor's panel.
      await require('../services/activation').activateForTransaction(pool, r.rows[0].id)
        .catch((e) => console.error('[activation] failed (manual resolve):', e.message));
      await creditWalletIfTopup(r.rows[0].session_id).catch((e) => console.error('[wallet] credit failed (manual resolve):', e.message));
      // Manual resolution still incurs the per-verification fee — the merchant
      // had to be reachable to click Mark Paid, so they should pay for it.
      await debitVerifyFee(req.merchant.id, r.rows[0].id, r.rows[0].session_id)
        .catch((e) => console.error('[wallet] debit failed (manual resolve):', e.message));
    }
    res.json({ ok: true });
  } catch (e) {
    // Defensive: in case of a race we lost between the duplicate check and the UPDATE.
    if (e && e.code === '23505') {
      return res.status(409).json({ error: 'This Transaction ID is already marked Paid on another order.' });
    }
    next(e);
  }
}

module.exports = {
  createSession, getSessionForMerchant,
  getCheckoutSession, listCheckoutGateways, submitTxn, checkoutStatus, cancelCheckout,
  listTransactions, manualResolve,
};
