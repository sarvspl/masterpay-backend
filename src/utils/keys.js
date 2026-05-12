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

function generateDeviceAuthKey() {
  return `PV-${randomAlphaNumUpper(6)}`;
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
