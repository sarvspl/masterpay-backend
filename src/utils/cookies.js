/**
 * Session-cookie helpers. The real JWT lives in an httpOnly cookie so it can't
 * be read by page JavaScript (XSS token theft is neutralised). No new npm
 * dependency: setting/clearing uses Express's built-in res.cookie()/clearCookie(),
 * and reading uses the tiny hand-written parser below (no cookie-parser).
 *
 * Deployment note: in prod the frontend (masterpay.it.com) and API
 * (checkout.masterpay.it.com) are subdomains of the same registrable domain, so
 * they're same-site — SameSite=Lax cookies are sent on the cross-origin fetches.
 * The cookie is host-only on the API host, which is where every request goes.
 */

// One cookie per role so a browser can hold independent sessions and each
// middleware clears/reads only its own.
const COOKIE_NAMES = {
  merchant: 'pv_merchant',
  vendor:   'pv_vendor',
  admin:    'pv_admin',
};

const isProd = process.env.NODE_ENV === 'production';

// Cookie lifetime mirrors the JWT TTL (JWT_EXPIRES_IN, default 7d) so the cookie
// and the token it carries expire together. The backend re-verifies the JWT on
// every request, so a slight mismatch would be harmless anyway.
function ttlMs() {
  const raw = String(process.env.JWT_EXPIRES_IN || '7d').trim();
  const m = /^(\d+)\s*([smhd])$/.exec(raw);
  if (!m) return 7 * 24 * 60 * 60 * 1000;
  const unit = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2]];
  return Number(m[1]) * unit;
}

// Shared attributes — must match between set and clear or the browser won't
// remove the cookie. `secure` is on only in prod (both sides are HTTPS there);
// on http://localhost it must be off or the cookie is silently dropped.
function baseOpts() {
  return { httpOnly: true, sameSite: 'lax', secure: isProd, path: '/' };
}

function setSessionCookie(res, name, token) {
  res.cookie(name, token, { ...baseOpts(), maxAge: ttlMs() });
}

function clearSessionCookie(res, name) {
  res.clearCookie(name, baseOpts());
}

// Minimal RFC-6265 cookie-header parser: pull one named value out of
// `req.headers.cookie` ("a=1; b=2"). Returns null if absent.
function readCookie(req, name) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

module.exports = { COOKIE_NAMES, setSessionCookie, clearSessionCookie, readCookie };
