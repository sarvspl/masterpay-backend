const pool = require('../db/pool');
const { verifyTxnIdForMerchant } = require('./sms.controller');
const { isUpiProvider, senderHintsForBank } = require('../utils/upi');

/* Internal: resolve merchant + account from a device auth_key. Each account
 * has its own key now, so this also yields the account_id the phone belongs to.
 * Returns { merchant_id, account_id, is_suspended } or null. */
async function resolveMerchantFromAuthKey(auth_key) {
  const m = await pool.query(
    `SELECT m.id AS merchant_id, a.id AS account_id, m.is_suspended
       FROM accounts a
       JOIN merchants m ON m.id = a.merchant_id
      WHERE a.device_auth_key = $1`,
    [auth_key]
  );
  if (m.rowCount === 0) return null;
  return m.rows[0];
}

/* ─── APK-facing: bind a device using the merchant's device_auth_key ─── */
async function bind(req, res, next) {
  try {
    const auth_key = String(req.body.auth_key || '').trim();
    const device_id = String(req.body.device_id || '').trim();
    if (!auth_key)  return res.status(400).json({ error: 'auth_key is required' });
    if (!device_id) return res.status(400).json({ error: 'device_id is required' });

    // Binder identity — required. Telegram handle is normalized (drop @ and any
    // t.me/ prefix) and validated against Telegram's username rules so the
    // dashboard can safely link to https://t.me/<handle>.
    const binder_name = String(req.body.binder_name || req.body.name || '').trim();
    let telegram = String(req.body.telegram || req.body.telegram_handle || '').trim();
    telegram = telegram.replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '').replace(/^@/, '').trim();
    if (binder_name.length < 2) {
      return res.status(400).json({ error: 'binder_name is required (min 2 characters)' });
    }
    if (!/^[a-zA-Z0-9_]{4,32}$/.test(telegram)) {
      return res.status(400).json({ error: 'A valid Telegram username is required (4–32 letters, digits or underscore, e.g. rahim_pay)' });
    }

    // WhatsApp number — optional. Normalize to digits (keep a leading +), so the
    // dashboard can link to https://wa.me/<number>. Reject obviously bad input.
    let whatsapp = String(req.body.whatsapp || '').trim();
    whatsapp = whatsapp.replace(/^https?:\/\/(wa\.me|api\.whatsapp\.com)\//i, '').replace(/[\s\-()]/g, '');
    if (whatsapp) {
      const normalized = whatsapp.replace(/^\+/, '');
      if (!/^\d{7,15}$/.test(normalized)) {
        return res.status(400).json({ error: 'WhatsApp number looks invalid — use 7–15 digits (optionally with country code).' });
      }
      whatsapp = normalized;
    } else {
      whatsapp = null;
    }

    const { model, manufacturer, os_version, device_token } = req.body;

    // Resolve merchant + account from the auth key (each account has its own key).
    const m = await pool.query(
      `SELECT m.id, m.name, m.is_suspended, m.suspended_reason, a.id AS account_id
         FROM accounts a
         JOIN merchants m ON m.id = a.merchant_id
        WHERE a.device_auth_key = $1`,
      [auth_key]
    );
    if (m.rowCount === 0) return res.status(401).json({ error: 'Invalid device auth key' });
    if (m.rows[0].is_suspended) return res.status(403).json({ error: 'Merchant account is suspended', suspended: true });
    const merchant = m.rows[0];
    const accountId = merchant.account_id;

    // First: if an UNBOUND row exists for the same merchant+device_id, resurrect it
    // (clear unbound_at, refresh metadata, re-point to the binding account). This
    // keeps history clean — re-installing or restarting the APK doesn't pile up
    // past-device rows.
    const resurrect = await pool.query(
      `UPDATE devices
          SET unbound_at      = NULL,
              unbound_reason  = NULL,
              account_id      = $9,
              model           = COALESCE($3, model),
              manufacturer    = COALESCE($4, manufacturer),
              os_version      = COALESCE($5, os_version),
              device_token    = COALESCE($6, device_token),
              binder_name     = $7,
              telegram_handle = $8,
              whatsapp        = $10,
              last_seen_at    = NOW()
        WHERE merchant_id = $1 AND device_id = $2 AND unbound_at IS NOT NULL
        RETURNING id, device_id, model, manufacturer, last_seen_at, created_at`,
      [merchant.id, device_id, model || null, manufacturer || null, os_version || null, device_token || null, binder_name, telegram, accountId, whatsapp]
    );
    if (resurrect.rowCount > 0) {
      return res.json({ ok: true, merchant_name: merchant.name, device: resurrect.rows[0], resurrected: true });
    }

    // Otherwise upsert against the active-row partial unique index.
    const r = await pool.query(
      `INSERT INTO devices (merchant_id, account_id, device_id, model, manufacturer, os_version, device_token, binder_name, telegram_handle, whatsapp, last_seen_at)
       VALUES ($1, $9, $2, $3, $4, $5, $6, $7, $8, $10, NOW())
       ON CONFLICT (merchant_id, device_id) WHERE unbound_at IS NULL DO UPDATE
         SET account_id      = EXCLUDED.account_id,
             model           = COALESCE(EXCLUDED.model,        devices.model),
             manufacturer    = COALESCE(EXCLUDED.manufacturer, devices.manufacturer),
             os_version      = COALESCE(EXCLUDED.os_version,   devices.os_version),
             device_token    = COALESCE(EXCLUDED.device_token, devices.device_token),
             binder_name     = EXCLUDED.binder_name,
             telegram_handle = EXCLUDED.telegram_handle,
             whatsapp        = EXCLUDED.whatsapp,
             last_seen_at    = NOW()
       RETURNING id, device_id, model, manufacturer, last_seen_at, created_at`,
      [merchant.id, device_id, model || null, manufacturer || null, os_version || null, device_token || null, binder_name, telegram, accountId, whatsapp]
    );

    res.json({ ok: true, merchant_name: merchant.name, device: r.rows[0] });
  } catch (e) { next(e); }
}

/* ─── APK-facing: unbind / disconnect this device ───
 *   POST /api/device/unbind  body { auth_key, device_id }
 *   Called when the user taps "Disconnect" in the app, or before uninstalling.
 *   Idempotent — calling on an already-unbound device returns 200 with not_found:true.
 */
async function unbind(req, res, next) {
  try {
    const auth_key = String(req.body.auth_key || '').trim();
    const device_id = String(req.body.device_id || '').trim();
    if (!auth_key)  return res.status(400).json({ error: 'auth_key is required' });
    if (!device_id) return res.status(400).json({ error: 'device_id is required' });

    // Resolve account from auth key. Suspended merchants can still unbind
    // (lets a phone clean up locally even if account is suspended).
    const m = await pool.query(
      `SELECT id AS account_id, merchant_id FROM accounts WHERE device_auth_key = $1`,
      [auth_key]
    );
    if (m.rowCount === 0) return res.status(401).json({ error: 'Invalid device auth key' });

    // Soft-delete: preserve history. Only target the active row for THIS account.
    const r = await pool.query(
      `UPDATE devices
          SET unbound_at = NOW(),
              unbound_reason = 'apk_unbind'
        WHERE account_id = $1 AND device_id = $2 AND unbound_at IS NULL
        RETURNING id`,
      [m.rows[0].account_id, device_id]
    );

    res.json({
      ok: true,
      unbound: r.rowCount > 0,
      not_found: r.rowCount === 0,
    });
  } catch (e) { next(e); }
}

/* ─── APK-facing: heartbeat keeps the device marked online ─── */
async function heartbeat(req, res, next) {
  try {
    const auth_key = String(req.body.auth_key || '').trim();
    const device_id = String(req.body.device_id || '').trim();
    if (!auth_key || !device_id) {
      return res.status(400).json({ error: 'auth_key and device_id required' });
    }
    const r = await pool.query(
      `UPDATE devices d
          SET last_seen_at = NOW()
         FROM accounts a
        WHERE d.account_id = a.id
          AND d.device_id = $1
          AND a.device_auth_key = $2
          AND d.unbound_at IS NULL
        RETURNING d.id, d.merchant_id, d.account_id, a.suspended_at`,
      [device_id, auth_key]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Device not bound' });

    // A suspended vendor's phone must stop verifying — no pending work is
    // returned while the account is suspended, whoever suspended it.
    if (r.rows[0].suspended_at) {
      return res.status(403).json({
        error: 'This seller account is suspended. Payments cannot be verified until it is reinstated.',
        code: 'vendor_suspended',
        suspended: true,
      });
    }

    // Attach the wallet snapshot of the ACCOUNT this phone is bound to, so the
    // APK's balance pill shows the holder's own balance. A vendor's phone used
    // to display the marketplace's balance — a number they neither control nor
    // are charged against.
    const { getWalletStatusForAccount } = require('../services/wallet');
    const wallet = await getWalletStatusForAccount(r.rows[0].account_id).catch(() => null);

    res.json({ ok: true, ...(wallet || {}) });
  } catch (e) { next(e); }
}

/* ─── Merchant-facing: list bound (active) devices + past-device count ─── */
async function listForMerchant(req, res, next) {
  try {
    // Optional ?account_id= filter. The vendor panel forces this so a vendor
    // only ever sees the phones bound to their own account.
    const accountId = req.query.account_id ? String(req.query.account_id) : null;

    const listParams = [req.merchant.id];
    let accountClause = '';
    if (accountId) { listParams.push(accountId); accountClause = ` AND d.account_id = $${listParams.length}`; }

    const { rows } = await pool.query(
      `SELECT d.id, d.device_id, d.model, d.manufacturer, d.os_version, d.is_enabled,
              d.last_seen_at, d.created_at, d.binder_name, d.telegram_handle, d.whatsapp,
              d.account_id, a.label AS account_label, a.is_default AS account_is_default,
              (d.last_seen_at IS NOT NULL AND d.last_seen_at > NOW() - INTERVAL '10 minutes') AS is_online
         FROM devices d
         LEFT JOIN accounts a ON a.id = d.account_id
        WHERE d.merchant_id = $1 AND d.unbound_at IS NULL${accountClause}
        ORDER BY d.created_at DESC`,
      listParams
    );
    const pastParams = [req.merchant.id];
    let pastClause = '';
    if (accountId) { pastParams.push(accountId); pastClause = ` AND account_id = $${pastParams.length}`; }
    const past = await pool.query(
      `SELECT COUNT(*)::int AS n FROM devices WHERE merchant_id = $1 AND unbound_at IS NOT NULL${pastClause}`,
      pastParams
    );

    // Per-device stats — successful verifications THIS phone resolved
    // (matched on transactions.result_device_id), scoped to the chosen window.
    const w = String(req.query.window || '').toLowerCase();
    const winSql = w === 'today' || w === '1d' ? `AND t.created_at >= NOW() - INTERVAL '1 day'`
                 : w === '7d'                  ? `AND t.created_at >= NOW() - INTERVAL '7 days'`
                 : w === '30d'                 ? `AND t.created_at >= NOW() - INTERVAL '30 days'`
                 : '';
    const stats = await pool.query(
      `SELECT t.result_device_id,
              COUNT(*)::int                       AS txn_count,
              COALESCE(SUM(t.amount), 0)::numeric AS txn_total
         FROM transactions t
        WHERE t.merchant_id = $1
          AND t.status = 'success'
          AND t.result_device_id IS NOT NULL
          ${winSql}
        GROUP BY t.result_device_id`,
      [req.merchant.id]
    );
    const statsByDevice = {};
    for (const row of stats.rows) {
      statsByDevice[row.result_device_id] = { txn_count: row.txn_count, txn_total: Number(row.txn_total) };
    }
    const devices = rows.map((d) => {
      const s = statsByDevice[d.device_id] || { txn_count: 0, txn_total: 0 };
      return { ...d, txn_count: s.txn_count, txn_total: s.txn_total };
    });

    res.json({ devices, past_count: past.rows[0].n, window: w || 'all' });
  } catch (e) { next(e); }
}

/* ─── Merchant-facing: list past (unbound) devices, newest unbound first ─── */
async function listHistoryForMerchant(req, res, next) {
  try {
    // verified_count tells the operator what deleting this row would detach.
    // transactions.result_device_id stores the device_id STRING (not this row's
    // uuid) and carries no foreign key, so a delete never errors — it just
    // leaves those payments naming a phone that no longer exists. Showing the
    // number is the difference between an informed cleanup and a silent one.
    const { rows } = await pool.query(
      `SELECT d.id, d.device_id, d.model, d.manufacturer, d.os_version,
              d.last_seen_at, d.created_at, d.unbound_at, d.unbound_reason,
              d.binder_name, d.telegram_handle,
              (SELECT COUNT(*)::int FROM transactions t
                WHERE t.merchant_id = d.merchant_id
                  AND t.result_device_id = d.device_id) AS verified_count
         FROM devices d
        WHERE d.merchant_id = $1 AND d.unbound_at IS NOT NULL
        ORDER BY d.unbound_at DESC
        LIMIT 100`,
      [req.merchant.id]
    );
    res.json({ devices: rows });
  } catch (e) { next(e); }
}

/**
 * Permanently remove an unbound device row.
 *
 * DELETE /api/admin/platform/devices/:id/purge
 *
 * Only unbound rows can be purged. An active phone must be unbound first —
 * otherwise "delete" would look like it revoked access when the row could be
 * recreated by the next bind, and the two operations mean different things.
 *
 * Nothing references devices by foreign key, so this cannot fail on a
 * constraint. What it does cost: transactions record which phone verified them
 * via result_device_id, and once the row is gone that value resolves to nothing
 * — the payment still shows it was device-verified, but not by which handset,
 * nor who bound it. Purging a phone that verified nothing loses nothing at all,
 * which is the common case for a mis-bind or a test device.
 */
async function purgeForMerchant(req, res, next) {
  try {
    const d = await pool.query(
      `SELECT id, device_id, unbound_at FROM devices WHERE id = $1 AND merchant_id = $2`,
      [req.params.id, req.merchant.id]
    );
    if (d.rowCount === 0) return res.status(404).json({ error: 'Device not found' });
    if (d.rows[0].unbound_at === null) {
      return res.status(409).json({
        error: 'This phone is still bound. Unbind it first, then delete it.',
        code: 'device_still_bound',
      });
    }

    const used = await pool.query(
      `SELECT COUNT(*)::int n FROM transactions
        WHERE merchant_id = $1 AND result_device_id = $2`,
      [req.merchant.id, d.rows[0].device_id]
    );

    await pool.query(`DELETE FROM devices WHERE id = $1 AND merchant_id = $2`,
      [req.params.id, req.merchant.id]);

    res.json({ ok: true, deleted: d.rows[0].device_id, detached_transactions: used.rows[0].n });
  } catch (e) { next(e); }
}

/* ─── APK-facing: poll for pending verifications ───
 *   POST /api/device/poll  body { auth_key, device_id }
 *   Returns up to 20 pending verifications addressed to this merchant.
 *   APK should read SMS, then call /report for each.
 */
async function poll(req, res, next) {
  try {
    const auth_key = String(req.body.auth_key || '').trim();
    const device_id = String(req.body.device_id || '').trim();
    if (!auth_key || !device_id) {
      return res.status(400).json({ error: 'auth_key and device_id required' });
    }

    const m = await pool.query(
      `SELECT m.id AS merchant_id, a.id AS account_id, a.suspended_at
         FROM accounts a
         JOIN merchants m ON m.id = a.merchant_id
        WHERE a.device_auth_key = $1`,
      [auth_key]
    );
    if (m.rowCount === 0) return res.status(401).json({ error: 'Invalid device auth key' });
    const { merchant_id, account_id } = m.rows[0];

    // A suspended vendor's phone must stop verifying, whoever suspended it.
    if (m.rows[0].suspended_at) {
      return res.status(403).json({
        error: 'This seller account is suspended. Payments cannot be verified until it is reinstated.',
        code: 'vendor_suspended',
        suspended: true,
      });
    }

    // The phone must still be BOUND, not merely holding a valid auth key.
    //
    // This used to be only the last_seen UPDATE below, which silently matches
    // zero rows for an unbound device and then carries on — so unbinding a
    // phone did not actually stop it polling or verifying payments. "Unbind"
    // in the console was cosmetic, and a removed phone kept confirming money.
    //
    // Returning 401 here also gives the APK something it can act on: the key is
    // fine, the binding is gone, so prompt to re-bind rather than showing a
    // generic auth failure.
    const bound = await pool.query(
      `UPDATE devices SET last_seen_at = NOW()
        WHERE account_id = $1 AND device_id = $2 AND unbound_at IS NULL
        RETURNING id`,
      [account_id, device_id]
    );
    if (bound.rowCount === 0) {
      return res.status(401).json({
        error: 'This phone is no longer bound. Open the app and enter the device key again.',
        code: 'device_unbound',
      });
    }

    // Account-scoped: a phone only receives verifications for ITS account's
    // gateways (that account's bKash number's SMS lands only on this phone).
    const r = await pool.query(
      `SELECT t.id AS verification_id,
              t.txnid_submitted,
              t.amount,
              t.customer_phone,
              t.created_at,
              g.provider,
              g.variant,
              g.account_number,
              g.bank_code,
              s.order_id,
              s.customer_name,
              -- What the payer was actually CHARGED in, which is not always what
              -- the session was priced in: a wallet top-up may be settled
              -- through a rail that receives another currency. The session
              -- records the invoice, charged_currency records the payment, and
              -- the matcher needs the latter.
              COALESCE(t.charged_currency, s.currency) AS currency
         FROM transactions t
         JOIN gateways g ON g.id = t.gateway_id
         LEFT JOIN payment_sessions s ON s.id = t.session_id
        WHERE t.merchant_id = $1
          AND g.account_id = $2
          AND t.status = 'pending'
        ORDER BY t.created_at ASC
        LIMIT 20`,
      [merchant_id, account_id]
    );

    // Include the wallet snapshot so the APK balance pill updates from a poll
    // response (no extra round-trip needed). Scoped to the phone's own account:
    // a vendor sees their wallet, not the marketplace's.
    const { getWalletStatusForAccount } = require('../services/wallet');
    const wallet = await getWalletStatusForAccount(account_id).catch(() => null);

    // Resolve the bank's SMS sender-ID allowlist server-side and ship it with
    // the verification, so the device matcher carries no per-bank knowledge.
    // Adding support for another bank is then a backend deploy, not an APK
    // release. Empty array = "no bank-specific allowlist" — the matcher must
    // treat that as fall-back-to-generic, never as allow-anything.
    //
    // currency is NULL for inbound transactions with no session (LEFT JOIN
    // above); default it so the matcher's currency gate can't be bypassed by a
    // missing value.
    const verifications = r.rows.map((v) => ({
      ...v,
      currency: v.currency || (isUpiProvider(v.provider) ? 'INR' : 'BDT'),
      sender_hints: senderHintsForBank(v.bank_code),
    }));

    res.json({ verifications, ...(wallet || {}) });
  } catch (e) { next(e); }
}

/* ─── APK-facing: report a verification result ───
 *   POST /api/device/report
 *   body { auth_key, device_id, verification_id, result: 'success'|'failed', matched_sms?, failure_reason? }
 */
async function report(req, res, next) {
  try {
    const auth_key = String(req.body.auth_key || '').trim();
    const device_id = String(req.body.device_id || '').trim();
    const verification_id = String(req.body.verification_id || '').trim();
    const result = String(req.body.result || '').toLowerCase();
    if (!auth_key || !device_id || !verification_id) {
      return res.status(400).json({ error: 'auth_key, device_id, verification_id required' });
    }
    if (!['success', 'failed'].includes(result)) {
      return res.status(400).json({ error: 'result must be "success" or "failed"' });
    }

    const m = await pool.query(
      `SELECT m.id AS merchant_id, a.id AS account_id, a.suspended_at
         FROM accounts a
         JOIN merchants m ON m.id = a.merchant_id
        WHERE a.device_auth_key = $1`,
      [auth_key]
    );
    if (m.rowCount === 0) return res.status(401).json({ error: 'Invalid device auth key' });

    // A suspended vendor cannot settle a payment — same rule as poll().
    if (m.rows[0].suspended_at) {
      return res.status(403).json({
        error: 'This seller account is suspended. Payments cannot be verified until it is reinstated.',
        code: 'vendor_suspended',
        suspended: true,
      });
    }

    // Same binding check as poll(): an unbound phone must not be able to settle
    // a payment. Without this, an operator who unbinds a phone in the console
    // has not actually revoked anything — it can still mark payments as paid.
    const stillBound = await pool.query(
      `SELECT 1 FROM devices
        WHERE account_id = $1 AND device_id = $2 AND unbound_at IS NULL`,
      [m.rows[0].account_id, device_id]
    );
    if (stillBound.rowCount === 0) {
      return res.status(401).json({
        error: 'This phone is no longer bound. Open the app and enter the device key again.',
        code: 'device_unbound',
      });
    }

    // `failure_reason` is overloaded as a free-form note column across the rest
    // of the codebase (see payment.controller.js manualResolve), so an approve
    // flow with a manual note must write here too. Cap to fit VARCHAR(255).
    const note = req.body.failure_reason
      ? String(req.body.failure_reason).slice(0, 240)
      : null;

    try {
      // Identifies the SMS/notification that settled this payment. The partial
      // unique index uniq_tx_merchant_fingerprint_success (043) then makes the
      // database refuse to let that same payment settle a second order — which
      // is what replaces the TxnID uniqueness for UPI, where there is no TxnID.
      // Enforced in the index rather than by a SELECT-then-INSERT so it holds
      // under a race between two phones or two cycles.
      const fingerprint = result === 'success'
        ? (String(req.body.match_fingerprint || '').trim().slice(0, 64) || null)
        : null;

      const upd = await pool.query(
        `UPDATE transactions
            SET status = $1,
                result_source = 'apk',
                result_device_id = $2,
                matched_sms = $3,
                failure_reason = $4,
                match_fingerprint = COALESCE($8, match_fingerprint),
                verified_at = NOW(),
                updated_at = NOW()
          WHERE id = $5 AND merchant_id = $6 AND status = 'pending'
            AND gateway_id IN (SELECT id FROM gateways WHERE account_id = $7)
          RETURNING id, session_id, status`,
        [
          result, device_id,
          result === 'success' ? (req.body.matched_sms || null) : null,
          result === 'success'
            ? note                                   // optional manual note on approve
            : (note || 'No matching SMS'),           // note (or fallback) on reject
          verification_id, m.rows[0].merchant_id, m.rows[0].account_id,
          fingerprint,
        ]
      );
      if (upd.rowCount === 0) {
        return res.status(404).json({ error: 'Verification not found or already resolved' });
      }

      if (result === 'success') {
        await pool.query(
          `UPDATE payment_sessions SET status='success', updated_at=NOW() WHERE id=$1 AND status='pending'`,
          [upd.rows[0].session_id]
        );
        const { creditWalletIfTopup, debitVerifyFee } = require('../services/wallet');
        await creditWalletIfTopup(upd.rows[0].session_id)
          .catch((e) => console.error('[wallet] credit failed (apk report):', e.message));
        await require('../services/activation').settleForTransaction(pool, upd.rows[0].id)
          .catch((e) => console.error('[settle] failed (apk report):', e.message));
        await debitVerifyFee(m.rows[0].merchant_id, upd.rows[0].id, upd.rows[0].session_id)
          .catch((e) => console.error('[wallet] debit failed (apk report):', e.message));
      }

      // Return the canonical post-update state so clients can validate without
      // a follow-up call (avoids races + makes the response self-describing).
      res.json({
        ok: true,
        verification_id: upd.rows[0].id,
        status: upd.rows[0].status,        // 'success' or 'failed' — never 'pending'
        session_id: upd.rows[0].session_id,
        transaction: {
          id: upd.rows[0].id,
          status: upd.rows[0].status,
          result_source: 'apk',
        },
      });
    } catch (e) {
      // A unique index refused the settlement. Either the same TxnID, or the
      // same SMS/notification, is already marked paid on another order for this
      // merchant.
      //
      // The fingerprint case is the one that matters for UPI: two orders from
      // customers with the same name and amount both matched one payment. The
      // database picks a winner and this one stays PENDING, so a human decides.
      // That is deliberate — auto-failing it would reject a customer who may
      // well have paid, and auto-approving would give away goods.
      if (e && e.code === '23505') {
        const onFingerprint = /uniq_tx_merchant_fingerprint_success/.test(e.constraint || '');
        return res.status(409).json({
          error: onFingerprint
            ? 'That payment has already been matched to another order. This one needs manual review.'
            : 'This Transaction ID is already marked Paid on another order.',
          code: onFingerprint ? 'duplicate_payment_evidence' : 'duplicate_txnid',
          needs_manual_review: onFingerprint,
        });
      }
      throw e;
    }
  } catch (e) { next(e); }
}

/* ─── APK-facing: list transactions (pending + history) ───
 *   POST /api/device/transactions
 *   body { auth_key, device_id, status?, q?, limit? }
 *
 *   status — 'pending' | 'success' | 'failed' | undefined (all)
 *   q      — search TxnID or order_id (LIKE %q%, case-insensitive)
 *   limit  — default 50, max 200
 */
async function listTransactionsForDevice(req, res, next) {
  try {
    const auth_key = String(req.body.auth_key || '').trim();
    const device_id = String(req.body.device_id || '').trim();
    if (!auth_key || !device_id) {
      return res.status(400).json({ error: 'auth_key and device_id required' });
    }

    const merchant = await resolveMerchantFromAuthKey(auth_key);
    if (!merchant) return res.status(401).json({ error: 'Invalid device auth key' });
    if (merchant.is_suspended) return res.status(403).json({ error: 'Merchant account is suspended', suspended: true });

    await pool.query(
      `UPDATE devices SET last_seen_at = NOW()
        WHERE merchant_id = $1 AND device_id = $2 AND unbound_at IS NULL`,
      [merchant.merchant_id, device_id]
    );

    const status = ['pending', 'success', 'failed'].includes(req.body.status) ? req.body.status : null;
    const q = req.body.q ? String(req.body.q).trim() : null;
    const limit = Math.min(200, Number(req.body.limit) || 50);
    // Page is opt-in: old app builds omit it and get page 1 + the same rows as
    // before. total/pages are always returned (additive) so a paginating app can
    // load-more without guessing when to stop.
    const page = Math.max(1, parseInt(req.body.page, 10) || 1);
    const offset = (page - 1) * limit;

    // Filter conditions shared by the row query and its COUNT.
    const params = [merchant.merchant_id];
    let filter = '';
    if (status) { params.push(status); filter += ` AND t.status = $${params.length}`; }
    if (q)      { params.push(`%${q.toLowerCase()}%`); filter += ` AND (LOWER(t.txnid_submitted) LIKE $${params.length} OR LOWER(s.order_id) LIKE $${params.length})`; }

    const rowsSql = `SELECT t.id, t.session_id, t.txnid_submitted, t.amount, t.status, t.customer_phone,
                      t.result_source, t.verified_at, t.failure_reason, t.created_at,
                      t.payer_name, t.payer_phone,
                      g.provider, g.variant, g.account_number, g.label AS gateway_label,
                      s.order_id, s.currency AS session_currency, s.customer_name
                 FROM transactions t
                 JOIN gateways g ON g.id = t.gateway_id
                 LEFT JOIN payment_sessions s ON s.id = t.session_id
                WHERE t.merchant_id = $1` + filter + ` ORDER BY t.created_at DESC LIMIT ${limit} OFFSET ${offset}`;

    const countSql = `SELECT COUNT(*)::int AS n
                        FROM transactions t
                        JOIN gateways g ON g.id = t.gateway_id
                        LEFT JOIN payment_sessions s ON s.id = t.session_id
                       WHERE t.merchant_id = $1` + filter;

    const [r, c] = await Promise.all([pool.query(rowsSql, params), pool.query(countSql, params)]);
    const total = c.rows[0].n;
    res.json({ transactions: r.rows, total, page, pages: Math.max(1, Math.ceil(total / limit)), limit });
  } catch (e) { next(e); }
}

/* ─── APK-facing: paste a TxnID, the server searches received SMS and resolves it ───
 *   POST /api/device/verify
 *   body { auth_key, device_id, txnid }
 *
 *   Mirror of /api/merchant/verify but authed by auth_key instead of JWT.
 *   Same response shapes — { matched, transaction?, sms?, reason?, message? }.
 */
async function verifyTxnIdFromDevice(req, res, next) {
  try {
    const auth_key = String(req.body.auth_key || '').trim();
    const device_id = String(req.body.device_id || '').trim();
    if (!auth_key || !device_id) {
      return res.status(400).json({ error: 'auth_key and device_id required' });
    }

    const merchant = await resolveMerchantFromAuthKey(auth_key);
    if (!merchant) return res.status(401).json({ error: 'Invalid device auth key' });
    if (merchant.is_suspended) return res.status(403).json({ error: 'Merchant account is suspended', suspended: true });

    await pool.query(
      `UPDATE devices SET last_seen_at = NOW()
        WHERE merchant_id = $1 AND device_id = $2 AND unbound_at IS NULL`,
      [merchant.merchant_id, device_id]
    );

    const out = await verifyTxnIdForMerchant(merchant.merchant_id, req.body.txnid);
    if (out.error) return res.status(400).json(out);
    res.json(out);
  } catch (e) { next(e); }
}

/* ─── Merchant-facing: edit a bound device's contact info ───
 *   PATCH /api/merchant/devices/:id
 *   body { binder_name?, telegram_handle? (or telegram), whatsapp? }
 *   Only supplied fields change. Scoped to the merchant's own active devices.
 */
async function updateForMerchant(req, res, next) {
  try {
    const fields = {};

    if (req.body.binder_name !== undefined) {
      const bn = String(req.body.binder_name).trim();
      if (bn && bn.length < 2) return res.status(400).json({ error: 'Binder name must be at least 2 characters' });
      fields.binder_name = bn || null;
    }
    if (req.body.telegram_handle !== undefined || req.body.telegram !== undefined) {
      let tg = String(req.body.telegram_handle ?? req.body.telegram ?? '').trim();
      tg = tg.replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '').replace(/^@/, '').trim();
      if (tg && !/^[a-zA-Z0-9_]{4,32}$/.test(tg)) {
        return res.status(400).json({ error: 'Invalid Telegram username (4–32 letters, digits or underscore)' });
      }
      fields.telegram_handle = tg || null;
    }
    if (req.body.whatsapp !== undefined) {
      let wa = String(req.body.whatsapp || '').trim()
        .replace(/^https?:\/\/(wa\.me|api\.whatsapp\.com)\//i, '')
        .replace(/[\s\-()]/g, '')
        .replace(/^\+/, '');
      if (wa && !/^\d{7,15}$/.test(wa)) {
        return res.status(400).json({ error: 'Invalid WhatsApp number (7–15 digits, optionally with country code)' });
      }
      fields.whatsapp = wa || null;
    }

    const cols = Object.keys(fields); // whitelisted keys only — safe to interpolate
    if (cols.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    const sets = cols.map((c, i) => `${c} = $${i + 3}`).join(', ');
    const vals = cols.map((c) => fields[c]);
    const r = await pool.query(
      `UPDATE devices SET ${sets}
        WHERE id = $1 AND merchant_id = $2 AND unbound_at IS NULL
        RETURNING id, binder_name, telegram_handle, whatsapp`,
      [req.params.id, req.merchant.id, ...vals]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Device not found' });
    res.json({ device: r.rows[0] });
  } catch (e) { next(e); }
}

/* ─── Merchant-facing: unbind a device (soft-delete, preserves history) ─── */
async function deleteForMerchant(req, res, next) {
  try {
    const r = await pool.query(
      `UPDATE devices
          SET unbound_at = NOW(),
              unbound_reason = 'merchant_delete'
        WHERE id = $1 AND merchant_id = $2 AND unbound_at IS NULL
        RETURNING id`,
      [req.params.id, req.merchant.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Device not found or already unbound' });
    res.json({ ok: true });
  } catch (e) { next(e); }
}

module.exports = {
  bind, unbind, heartbeat, poll, report,
  listTransactionsForDevice, verifyTxnIdFromDevice,
  listForMerchant, listHistoryForMerchant, updateForMerchant, deleteForMerchant, purgeForMerchant,
};
