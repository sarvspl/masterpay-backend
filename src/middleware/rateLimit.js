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

/**
 * Failure-only limiter. Unlike createLimiter (which counts every request on the
 * way in), this counts a key ONLY when the response is a "failed auth" status.
 * That makes it ideal for throttling credential guessing without touching
 * legitimate traffic: a real device sends one valid key and always succeeds, so
 * it never accrues a count no matter how often it polls; an attacker guessing
 * keys gets a failure status on almost every try and is blocked fast.
 *
 * Key it by IP (keys.ip) so one guessing script is throttled even though every
 * request carries a different key.
 */
function createFailureLimiter({
  windowMs,
  max,
  keyGenerator,
  failStatuses = [401],
  message,
  statusCode = 429,
}) {
  if (!windowMs || !max || !keyGenerator) {
    throw new Error('rateLimit: windowMs, max, and keyGenerator are required');
  }
  const failSet = new Set(failStatuses);
  const hits = new Map(); // key -> { count, resetAt }

  const gc = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, Math.max(30_000, windowMs)).unref();

  return function failureLimit(req, res, next) {
    let key;
    try { key = keyGenerator(req); } catch { key = null; }
    if (!key) return next(); // can't identify the caller — fail open

    const now = Date.now();
    let entry = hits.get(key);
    if (entry && entry.resetAt <= now) { hits.delete(key); entry = undefined; }

    // Already over the limit for this window → block before running the handler.
    if (entry && entry.count >= max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(statusCode).json({
        error: message || 'Too many failed attempts. Please slow down and try again shortly.',
        retry_after_seconds: retryAfter,
      });
    }

    // Count this attempt only if it ends in a failure status.
    res.on('finish', () => {
      if (!failSet.has(res.statusCode)) return;
      const t = Date.now();
      let e = hits.get(key);
      if (!e || e.resetAt <= t) { e = { count: 0, resetAt: t + windowMs }; hits.set(key, e); }
      e.count += 1;
    });

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

  // Device auth-key brute-force guard. Counts ONLY failed (401 = bad key)
  // attempts per IP, so legit phones are never affected regardless of how often
  // they poll — only key-guessing accrues a count. This is what protects the
  // older short 6-char keys until each merchant/vendor regenerates a long one.
  deviceBruteforce: createFailureLimiter({
    windowMs: 60_000,
    max: 20,
    keyGenerator: keys.ip,
    failStatuses: [401],
    message: 'Too many invalid device-key attempts. Please try again in a minute.',
  }),
};

module.exports = { createLimiter, createFailureLimiter, keys, limiters };
