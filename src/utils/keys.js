const crypto = require('crypto');

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function randomAlphaNumUpper(len) {
  const chars = 'ABCDEFGHIJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const buf = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += chars[buf[i] % chars.length];
  return out;
}

function generateApiKey() {
  return `pk_live_${randomHex(16)}`;
}

function generateSecretKey() {
  return `sk_live_${randomHex(24)}`;
}

// Length of the random part of a device auth key. Kept at 24 so the key carries
// ~10^36 combinations (32^24) — guessing is physically infeasible. Old 6-char
// keys still work (lookups are exact-match); merchants/vendors upgrade by
// regenerating. Only this generator changed; the app and UI look identical bar
// the extra length, and the DB has a UNIQUE constraint so callers retry on the
// astronomically rare collision.
const DEVICE_KEY_RANDOM_LEN = 24;

function generateDeviceAuthKey() {
  return `PV-${randomAlphaNumUpper(DEVICE_KEY_RANDOM_LEN)}`;
}

function maskKey(key, visible = 4) {
  if (!key) return '';
  if (key.length <= visible) return '•'.repeat(key.length);
  return '•'.repeat(key.length - visible) + key.slice(-visible);
}

module.exports = {
  generateApiKey,
  generateSecretKey,
  generateDeviceAuthKey,
  maskKey,
};
