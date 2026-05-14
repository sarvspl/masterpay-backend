/**
 * Push notifications to merchant devices (APK) via FCM.
 *
 * The APK supplies its `device_token` (FCM registration token) when it binds.
 * Whenever a pending verification needs the merchant's attention (no auto-match
 * possible), we ping every active device for that merchant.
 *
 * Configuration:
 *   FCM_SERVER_KEY  — Firebase Cloud Messaging legacy server key.
 *                     If unset, this module is a no-op (poll-only mode).
 *
 * Payload (FCM data message — keys MUST all be strings on the wire):
 *   type             = "verify_request"
 *   verification_id  = transactions.id
 *   txnid            = txnid_submitted
 *   amount           = "1.00"
 *   currency         = "BDT"
 *   provider         = "nagad"
 *   account_number   = "9220..."
 *   customer_phone   = "+91..." or ""
 *   customer_name    = "Arnab"   or ""
 *   order_id         = "ORD-..." or ""
 *   created_at       = ISO string
 *
 * The APK is expected to render a high-priority notification with
 *   Approve  → POST /api/device/report  { verification_id, result: "success" }
 *   Reject   → POST /api/device/report  { verification_id, result: "failed", failure_reason: "..." }
 *
 * Once any surface (web or another device) resolves the row, the report
 * endpoint will return 404 "already resolved" — safe & idempotent.
 */
const pool = require('../db/pool');

const FCM_KEY = process.env.FCM_SERVER_KEY || null;
const FCM_URL = 'https://fcm.googleapis.com/fcm/send';

function stringify(v) {
  if (v == null) return '';
  return String(v);
}

async function sendOne(token, data) {
  try {
    const r = await fetch(FCM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `key=${FCM_KEY}`,
      },
      body: JSON.stringify({
        to: token,
        priority: 'high',
        data,
        // Also send a notification block so the OS shows it even if app is killed.
        notification: {
          title: 'PayVerify',
          body: `Verify TxnID ${data.txnid} — ${data.currency} ${data.amount}`,
          sound: 'default',
        },
        android: { priority: 'high' },
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.warn('[push] FCM non-OK', r.status, body.slice(0, 200));
    }
  } catch (e) {
    console.warn('[push] FCM send failed:', e.message);
  }
}

/**
 * Notify every active, bound device of `merchantId` about a new pending
 * verification.  No-op if FCM is not configured.
 */
async function notifyVerifyRequest(merchantId, payload) {
  if (!FCM_KEY) return;     // Push not configured — polling still works.

  const { rows } = await pool.query(
    `SELECT device_token FROM devices
      WHERE merchant_id = $1
        AND unbound_at IS NULL
        AND device_token IS NOT NULL
        AND device_token <> ''`,
    [merchantId]
  );
  if (rows.length === 0) return;

  const data = {
    type: 'verify_request',
    verification_id: stringify(payload.verification_id),
    txnid:           stringify(payload.txnid),
    amount:          stringify(payload.amount),
    currency:        stringify(payload.currency || ''),
    provider:        stringify(payload.provider || ''),
    account_number:  stringify(payload.account_number || ''),
    customer_phone:  stringify(payload.customer_phone || ''),
    customer_name:   stringify(payload.customer_name || ''),
    order_id:        stringify(payload.order_id || ''),
    created_at:      stringify(payload.created_at || new Date().toISOString()),
  };

  // Fan-out in parallel. We don't await individual failures.
  await Promise.all(rows.map((r) => sendOne(r.device_token, data)));
}

module.exports = { notifyVerifyRequest };
