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

// Length of the random part of a device auth key. Set to 350 so every key is at
// least 350 characters (plus the "PV-" prefix → 353 total). That's an enormous
// keyspace (33^350) — guessing is physically impossible. The columns that store
// the key are TEXT (see migration 035), and old shorter keys still work because
// lookups are exact-match; merchants/vendors upgrade by regenerating. The DB
// UNIQUE constraint means callers retry on the (astronomically rare) collision.
const DEVICE_KEY_RANDOM_LEN = 350;

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
