const pool = require('../db/pool');

/* ─── APK-facing: bind a device using the merchant's device_auth_key ─── */
async function bind(req, res, next) {
  try {
    const auth_key = String(req.body.auth_key || '').trim();
    const device_id = String(req.body.device_id || '').trim();
    if (!auth_key)  return res.status(400).json({ error: 'auth_key is required' });
    if (!device_id) return res.status(400).json({ error: 'device_id is required' });

    const { model, manufacturer, os_version, device_token } = req.body;

    // Resolve merchant from auth key
    const m = await pool.query(
      `SELECT m.id, m.name, m.is_suspended, m.suspended_reason
         FROM merchants m
         JOIN merchant_keys k ON k.merchant_id = m.id
        WHERE k.device_auth_key = $1`,
      [auth_key]
    );
    if (m.rowCount === 0) return res.status(401).json({ error: 'Invalid device auth key' });
    if (m.rows[0].is_suspended) return res.status(403).json({ error: 'Merchant account is suspended', suspended: true });
    const merchant = m.rows[0];

    // Upsert by (merchant_id, device_id)
    const r = await pool.query(
      `INSERT INTO devices (merchant_id, device_id, model, manufacturer, os_version, device_token, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (merchant_id, device_id) DO UPDATE
         SET model        = COALESCE(EXCLUDED.model,        devices.model),
             manufacturer = COALESCE(EXCLUDED.manufacturer, devices.manufacturer),
             os_version   = COALESCE(EXCLUDED.os_version,   devices.os_version),
             device_token = COALESCE(EXCLUDED.device_token, devices.device_token),
             last_seen_at = NOW()
       RETURNING id, device_id, model, manufacturer, last_seen_at, created_at`,
      [merchant.id, device_id, model || null, manufacturer || null, os_version || null, device_token || null]
    );

    res.json({ ok: true, merchant_name: merchant.name, device: r.rows[0] });
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
         FROM merchant_keys k
        WHERE d.merchant_id = k.merchant_id
          AND d.device_id = $1
          AND k.device_auth_key = $2
        RETURNING d.id`,
      [device_id, auth_key]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Device not bound' });
    res.json({ ok: true });
  } catch (e) { next(e); }
}

/* ─── Merchant-facing: list bound devices ─── */
async function listForMerchant(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT id, device_id, model, manufacturer, os_version, is_enabled,
              last_seen_at, created_at,
              (last_seen_at IS NOT NULL AND last_seen_at > NOW() - INTERVAL '5 minutes') AS is_online
         FROM devices
        WHERE merchant_id = $1
        ORDER BY created_at DESC`,
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
      `SELECT m.id AS merchant_id
         FROM merchants m
         JOIN merchant_keys k ON k.merchant_id = m.id
        WHERE k.device_auth_key = $1`,
      [auth_key]
    );
    if (m.rowCount === 0) return res.status(401).json({ error: 'Invalid device auth key' });

    // Touch device last_seen (acts as heartbeat too)
    await pool.query(
      `UPDATE devices SET last_seen_at = NOW()
        WHERE merchant_id = $1 AND device_id = $2`,
      [m.rows[0].merchant_id, device_id]
    );

    const r = await pool.query(
      `SELECT t.id AS verification_id,
              t.txnid_submitted,
              t.amount,
              t.customer_phone,
              t.created_at,
              g.provider,
              g.variant,
              g.account_number
         FROM transactions t
         JOIN gateways g ON g.id = t.gateway_id
        WHERE t.merchant_id = $1
          AND t.status = 'pending'
        ORDER BY t.created_at ASC
        LIMIT 20`,
      [m.rows[0].merchant_id]
    );
    res.json({ verifications: r.rows });
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
      `SELECT m.id AS merchant_id
         FROM merchants m
         JOIN merchant_keys k ON k.merchant_id = m.id
        WHERE k.device_auth_key = $1`,
      [auth_key]
    );
    if (m.rowCount === 0) return res.status(401).json({ error: 'Invalid device auth key' });

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
        RETURNING id, session_id, status`,
      [
        result, device_id,
        result === 'success' ? (req.body.matched_sms || null) : null,
        result === 'failed' ? (req.body.failure_reason || 'No matching SMS') : null,
        verification_id, m.rows[0].merchant_id,
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
    }

    res.json({ ok: true });
  } catch (e) { next(e); }
}

/* ─── Merchant-facing: unbind a device ─── */
async function deleteForMerchant(req, res, next) {
  try {
    const r = await pool.query(
      `DELETE FROM devices WHERE id = $1 AND merchant_id = $2 RETURNING id`,
      [req.params.id, req.merchant.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Device not found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
}

module.exports = { bind, heartbeat, poll, report, listForMerchant, deleteForMerchant };
