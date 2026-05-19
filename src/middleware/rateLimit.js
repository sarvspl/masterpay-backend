/**
 * Lightweight in-process rate limiter.
 *
 * Fixed-window per key. Good enough for a single-instance Node app (PM2 cluster
 * mode shares no state across workers, so each worker counts independently —
 * be aware if you scale horizontally; swap this for a Redis-backed limiter
 * before then).
 */

function createLimiter({
  windowMs,
  max,
  keyGenerator,
  message,
  statusCode = 429,
}) {
  if (!windowMs || !max || !keyGenerator) {
    throw new Error('rateLimit: windowMs, max, and keyGenerator are required');
  }

  // key -> { count, resetAt }
  const hits = new Map();

  // Periodic GC. unref() so it doesn't keep the process alive on its own.
  const gc = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) {
      if (v.resetAt <= now) hits.delete(k);
    }
  }, Math.max(30_000, windowMs)).unref();

  return function rateLimit(req, res, next) {
    let key;
    try { key = keyGenerator(req); } catch { key = null; }
    if (!key) return next(); // can't identify the caller — fail open

    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    const remaining = Math.max(0, max - entry.count);
    res.setHeader('X-RateLimit-Limit',     String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset',     String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(statusCode).json({
        error: message || 'Too many requests. Please slow down and try again shortly.',
        retry_after_seconds: retryAfter,
      });
    }
    next();
  };
}

/* ─────────────── Common key generators ─────────────── */

function ipOf(req) {
  // Trust X-Forwarded-For only if Express trust proxy is set; otherwise this
  // is req.ip from the direct socket. We accept either since the limiter is
  // best-effort.
  return req.ip || req.headers['x-forwarded-for']?.split(',')[0].trim() || 'unknown';
}

const keys = {
  ip:           (req) => `ip:${ipOf(req)}`,
  ipAndPath:    (req) => `ip:${ipOf(req)}:path:${req.baseUrl || ''}${req.path || ''}`,
  ipAndSession: (req) => `ip:${ipOf(req)}:sess:${req.params.id || ''}`,
  apiKey:       (req) => {
    const k = req.headers['x-api-key'] || req.headers['authorization'] || '';
    return k ? `apikey:${String(k).slice(0, 64)}` : `ip:${ipOf(req)}`;
  },
  authKey:      (req) => {
    const k = (req.body && req.body.auth_key) || '';
    return k ? `authkey:${String(k)}` : `ip:${ipOf(req)}`;
  },
};

/* ─────────────── Named limiters used by routes ─────────────── */

const limiters = {
  // Public checkout submission — anti-bruteforce / anti-mining of valid TxnIDs.
  checkoutSubmit: createLimiter({
    windowMs: 60_000,
    max: 6,
    keyGenerator: keys.ipAndSession,
    message: 'Too many attempts on this checkout. Please wait a minute and try again.',
  }),

  // Server-to-server session creation — generous, but prevents API key abuse.
  paymentSessionCreate: createLimiter({
    windowMs: 60_000,
    max: 60,
    keyGenerator: keys.apiKey,
    message: 'API rate limit exceeded. Slow down session creation.',
  }),

  // Login endpoints — tight cap to block password guessing.
  login: createLimiter({
    windowMs: 15 * 60_000,
    max: 8,
    keyGenerator: keys.ip,
    message: 'Too many login attempts. Try again in a few minutes.',
  }),

  // Merchant manual verify — guards against TxnID mining from the dashboard.
  merchantVerify: createLimiter({
    windowMs: 60_000,
    max: 20,
    keyGenerator: keys.ip,
    message: 'Too many verify attempts. Please wait a minute.',
  }),

  // APK SMS upload — high cap (a busy phone can legitimately forward many SMS).
  deviceSms: createLimiter({
    windowMs: 60_000,
    max: 120,
    keyGenerator: keys.authKey,
    message: 'SMS upload rate limit exceeded.',
  }),
};

module.exports = { createLimiter, keys, limiters };
