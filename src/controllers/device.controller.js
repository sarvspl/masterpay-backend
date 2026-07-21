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
        RETURNING d.id, d.merchant_id, d.account_id`,
      [device_id, auth_key]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Device not bound' });

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
    const { rows } = await pool.query(
      `SELECT id, device_id, model, manufacturer, os_version,
              last_seen_at, created_at, unbound_at, unbound_reason
         FROM devices
        WHERE merchant_id = $1 AND unbound_at IS NOT NULL
        ORDER BY unbound_at DESC
        LIMIT 100`,
      [req.merchant.id]
    );
    res.json({ devices: rows });
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
      `SELECT m.id AS merchant_id, a.id AS account_id
         FROM accounts a
         JOIN merchants m ON m.id = a.merchant_id
        WHERE a.device_auth_key = $1`,
      [auth_key]
    );
    if (m.rowCount === 0) return res.status(401).json({ error: 'Invalid device auth key' });
    const { merchant_id, account_id } = m.rows[0];

    // Touch device last_seen (acts as heartbeat too) — only the active row
    await pool.query(
      `UPDATE devices SET last_seen_at = NOW()
        WHERE account_id = $1 AND device_id = $2 AND unbound_at IS NULL`,
      [account_id, device_id]
    );

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
      `SELECT m.id AS merchant_id, a.id AS account_id
         FROM accounts a
         JOIN merchants m ON m.id = a.merchant_id
        WHERE a.device_auth_key = $1`,
      [auth_key]
    );
    if (m.rowCount === 0) return res.status(401).json({ error: 'Invalid device auth key' });

    // `failure_reason` is overloaded as a free-form note column across the rest
    // of the codebase (see payment.controller.js manualResolve), so an approve
    // flow with a manual note must write here too. Cap to fit VARCHAR(255).
    const note = req.body.failure_reason
      ? String(req.body.failure_reason).slice(0, 240)
      : null;

    try {
      const upd = await pool.query(
        `UPDATE transactions
            SET status = $1,
                result_source = 'apk',
                result_device_id = $2,
                matched_sms = $3,
                failure_reason = $4,
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
      // Another row with the same TxnID is already success for this merchant.
      // Treat as already-resolved (idempotent) rather than 500ing.
      if (e && e.code === '23505') {
        return res.status(409).json({ error: 'This Transaction ID is already marked Paid on another order.' });
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

    const params = [merchant.merchant_id];
    let sql = `SELECT t.id, t.session_id, t.txnid_submitted, t.amount, t.status, t.customer_phone,
                      t.result_source, t.verified_at, t.failure_reason, t.created_at,
                      t.payer_name, t.payer_phone,
                      g.provider, g.variant, g.account_number, g.label AS gateway_label,
                      s.order_id, s.currency AS session_currency, s.customer_name
                 FROM transactions t
                 JOIN gateways g ON g.id = t.gateway_id
                 LEFT JOIN payment_sessions s ON s.id = t.session_id
                WHERE t.merchant_id = $1`;
    if (status) { params.push(status); sql += ` AND t.status = $${params.length}`; }
    if (q)      { params.push(`%${q.toLowerCase()}%`); sql += ` AND (LOWER(t.txnid_submitted) LIKE $${params.length} OR LOWER(s.order_id) LIKE $${params.length})`; }
    sql += ` ORDER BY t.created_at DESC LIMIT ${limit}`;

    const r = await pool.query(sql, params);
    res.json({ transactions: r.rows });
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
  listForMerchant, listHistoryForMerchant, updateForMerchant, deleteForMerchant,
};
