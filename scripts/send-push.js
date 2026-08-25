/**
 * Broadcast a push notification to bound APK devices via FCM — from the terminal.
 *
 *   node scripts/send-push.js "Title" "Body message"
 *   node scripts/send-push.js "Update available" "MASTER PAY 0.3.3 is out — open to update."
 *
 * Scope (default = every bound device on the platform):
 *   --merchant <merchant_id>    only that merchant's devices
 *   --vendor   <account_id>     only that vendor's devices
 *   --dry                       list who WOULD receive it; send nothing
 *
 * Needs FCM_SERVER_KEY in the environment (same key the backend uses for
 * verify-request pushes). Run it where that env is set — i.e. on the server.
 *
 * Uses the same FCM legacy endpoint as src/utils/push.js. A `notification`
 * block is included so the phone shows it from the system tray even when the
 * app is backgrounded or killed; `data.type = "announcement"` lets the app
 * tell it apart from a verify_request if it wants to.
 */
require('dotenv').config();
const pool = require('../src/db/pool');

const FCM_KEY = process.env.FCM_SERVER_KEY || null;
const FCM_URL = 'https://fcm.googleapis.com/fcm/send';

function parseArgs(argv) {
  const out = { positional: [], merchant: null, vendor: null, dry: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--merchant')      out.merchant = argv[++i];
    else if (argv[i] === '--vendor')   out.vendor = argv[++i];
    else if (argv[i] === '--dry')      out.dry = true;
    else out.positional.push(argv[i]);
  }
  return out;
}

async function sendOne(token, title, body) {
  const r = await fetch(FCM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `key=${FCM_KEY}` },
    body: JSON.stringify({
      to: token,
      priority: 'high',
      notification: { title, body, sound: 'default' },
      data: { type: 'announcement', title, body },
      android: { priority: 'high' },
    }),
  });
  const text = r.ok ? '' : await r.text().catch(() => '');
  return { ok: r.ok, status: r.status, text };
}

(async () => {
  const { positional, merchant, vendor, dry } = parseArgs(process.argv.slice(2));
  const [title, body] = positional;

  if (!title || !body) {
    console.error('Usage: node scripts/send-push.js "Title" "Body" [--merchant <id>] [--vendor <account_id>] [--dry]');
    process.exit(1);
  }
  if (!dry && !FCM_KEY) {
    console.error('FCM_SERVER_KEY is not set in this environment — cannot send. Run on the server, or pass --dry to preview.');
    process.exit(1);
  }

  let where = "unbound_at IS NULL AND device_token IS NOT NULL AND device_token <> ''";
  const params = [];
  if (vendor)        { params.push(vendor);   where += ` AND account_id = $${params.length}`; }
  else if (merchant) { params.push(merchant); where += ` AND merchant_id = $${params.length}`; }

  const { rows } = await pool.query(
    `SELECT id, device_id, device_token, merchant_id, account_id FROM devices WHERE ${where}`,
    params
  );

  const scope = vendor ? `vendor ${vendor}` : merchant ? `merchant ${merchant}` : 'ALL bound devices';
  console.log(`Target: ${scope} → ${rows.length} pushable device(s)`);
  console.log(`Title:  ${title}`);
  console.log(`Body:   ${body}`);

  if (dry) {
    rows.forEach((r) => console.log(`  · device ${r.device_id} (merchant ${String(r.merchant_id).slice(0, 8)})`));
    console.log('\n[dry run] nothing sent.');
    await pool.end();
    return;
  }
  if (rows.length === 0) { console.log('No devices to notify.'); await pool.end(); return; }

  let ok = 0, fail = 0;
  for (const r of rows) {
    const res = await sendOne(r.device_token, title, body);
    if (res.ok) { ok++; }
    else { fail++; console.warn(`  ✗ device ${r.device_id}: FCM ${res.status} ${res.text.slice(0, 160)}`); }
  }
  console.log(`\nDone: ${ok} sent, ${fail} failed.`);
  if (fail > 0) {
    console.log('If every send returned 404/401, the FCM *legacy* API is likely disabled for this key — the app would need migrating to FCM HTTP v1.');
  }
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
