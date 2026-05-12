const crypto = require('crypto');

// 22-char URL-safe id. ~131 bits of entropy. Collision-resistant for our scale.
function generateSessionId() {
  return crypto.randomBytes(16).toString('base64url');
}

module.exports = { generateSessionId };
