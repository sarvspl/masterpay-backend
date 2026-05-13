const pool = require('../db/pool');

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ─── SMS parsing helpers ─── */

// Extract a TxnID / TrxID / Ref / UTR / UPI ref from the SMS body.
function extractTxnId(body) {
  const patterns = [
    /(?:txn\s*id|trx\s*id|trxid|trans(?:action)?\s*id)[:\s.]+([A-Z0-9]{4,32})/i,
    /(?:ref(?:erence)?\s*(?:no\.?|id|num)?)[:\s.]+([A-Z0-9]{4,32})/i,
    /\butr[:\s.]+([A-Z0-9]{4,32})/i,
    // UPI reference: "UPI/P2A/123019535144/..." or "upi ref 123019535144"
    /upi\s*(?:ref(?:erence)?[:\s.]+|[\/\-][a-z0-9]+[\/\-])(\d{6,32})/i,
  ];
  for (const re of patterns) {
    const m = body.match(re);
    if (m && m[1]) return m[1].toUpperCase();
  }
  return null;
}

// Extract an amount from the SMS body. Returns number or null.
function extractAmount(body) {
  const patterns = [
    /(?:inr|rs\.?|₹|tk\.?|৳|usd|\$|eur|€|gbp|£)\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i,
    /([0-9][0-9,]*(?:\.\d{1,2})?)\s*(?:credited|received|debited|deposit(?:ed)?)/i,
    /(?:credited|received|debited)\s+(?:with\s+)?(?:inr|rs\.?|₹|tk\.?|৳)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i,
  ];
  for (const re of patterns) {
    const m = body.match(re);
    if (m && m[1]) {
      const n = parseFloat(m[1].replace(/,/g, ''));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

// Find a gateway whose account_number (or its last 4-8 digits) appears in the SMS body.
function findGatewayInSms(body, gateways) {
  const bodyDigits = body.replace(/\D/g, '');
  for (const g of gateways) {
    const acctDigits = String(g.account_number).replace(/\D/g, '');
    if (acctDigits.length < 4) continue;
    if (bodyDigits.includes(acctDigits)) return g;                 // full match
    const last4 = acctDigits.slice(-4);
    if (last4 && bodyDigits.includes(last4)) return g;             // last-4 fallback
  }
  return null;
}

/**
 * Match logic for a single SMS against a single pending transaction.
 * Returns true only if ALL applicable fields match.
 */
function smsMatchesTransaction(smsBody, tx) {
  const body = String(smsBody || '').toLowerCase();
  if (!body) return false;

  // 1. TxnID must appear as a standalone token (case-insensitive),
  //    not as a substring of another word. e.g. "BKX92H1" should not match "BKX92H1A".
  const txnid = String(tx.txnid_submitted || '').toLowerCase();
  if (!txnid) return false;
  const txnRe = new RegExp(`(?<![a-z0-9])${escapeRegex(txnid)}(?![a-z0-9])`, 'i');
  if (!txnRe.test(body)) return false;

  // 2. Amount must appear as a standalone number — not embedded in another number
  //    or word. e.g. amount 300 should NOT match "TXN300" or "30000".
  //    Acceptable forms for 500 → "500", "500.00", "500.0".
  //    For 500.50 → "500.50", "500.5".
  const amount = Number(tx.amount);
  const isWhole = amount === Math.trunc(amount);
  const intStr  = String(Math.trunc(amount));
  const decStr  = amount.toFixed(2);
  const candidates = isWhole
    ? [intStr + '.00', intStr + '.0', intStr]
    : [decStr, decStr.replace(/0$/, '')];

  const amountMatched = candidates.some((c) => {
    // Reject both letters AND digits before/after, so:
    //   "Tk 300"   → matches (space before, end-of-word after)
    //   "TXN300"   → does NOT match (letter N before)
    //   "30000"    → does NOT match (digit after)
    //   "300.000"  → does NOT match the bare "300" (digit after the .00)
    const re = new RegExp(`(?<![a-z0-9])${escapeRegex(c)}(?![a-z0-9])`, 'i');
    return re.test(body);
  });
  if (!amountMatched) return false;

  // 3. If customer_phone is set, the last 8 digits must appear in the SMS digit stream.
  if (tx.customer_phone) {
    const last8 = String(tx.customer_phone).replace(/\D/g, '').slice(-8);
    const bodyDigits = body.replace(/\D/g, '');
    if (last8 && !bodyDigits.includes(last8)) return false;
  }

  return true;
}

/**
 * Try to create a new "inbound" transaction from an SMS that didn't match
 * any pending session. Useful when payments come in without a checkout flow.
 *
 * Returns the new transaction id, or null if we couldn't extract enough data.
 */
async function tryCreateInbound(client, merchantId, smsId, sender, smsBody) {
  // Load this merchant's enabled gateways
  const gws = await client.query(
    `SELECT id, provider, variant, account_number FROM gateways
      WHERE merchant_id = $1 AND is_enabled = TRUE`,
    [merchantId]
  );
  if (gws.rows.length === 0) return null;

  const gateway = findGatewayInSms(smsBody, gws.rows);
  if (!gateway) return null;

  const txnid = extractTxnId(smsBody);
  const amount = extractAmount(smsBody);
  if (!txnid || amount == null) return null;

  // Don't double-record if this TxnID already exists for this merchant
  const dup = await client.query(
    `SELECT 1 FROM transactions WHERE merchant_id = $1 AND txnid_submitted = $2`,
    [merchantId, txnid]
  );
  if (dup.rowCount > 0) return null;

  try {
    const r = await client.query(
      `INSERT INTO transactions
         (merchant_id, gateway_id, txnid_submitted, amount, status,
          result_source, matched_sms, verified_at)
       VALUES ($1, $2, $3, $4, 'success', 'sms_inbound', $5, NOW())
       RETURNING id`,
      [merchantId, gateway.id, txnid, amount, smsBody]
    );
    const txId = r.rows[0].id;
    await client.query(`UPDATE sms_messages SET matched_tx_id = $1 WHERE id = $2`, [txId, smsId]);
    return txId;
  } catch (e) {
    // 23505 = unique violation; race with another upload — treat as already recorded
    if (e.code === '23505') return null;
    throw e;
  }
}

/**
 * Try to match an SMS row against this merchant's pending transactions.
 * If matched, flips the transaction (and its session) to success.
 *
 * Returns the matched transaction id, or null.
 */
async function tryAutoMatch(client, merchantId, smsId, smsBody) {
  const pending = await client.query(
    `SELECT id, txnid_submitted, amount, customer_phone, session_id
       FROM transactions
      WHERE merchant_id = $1
        AND status = 'pending'
        AND created_at > NOW() - INTERVAL '15 minutes'
      ORDER BY created_at ASC`,
    [merchantId]
  );

  for (const tx of pending.rows) {
    if (smsMatchesTransaction(smsBody, tx)) {
      await client.query(
        `UPDATE transactions
            SET status = 'success',
                result_source = 'apk',
                matched_sms = $2,
                verified_at = NOW(),
                updated_at = NOW()
          WHERE id = $1 AND status = 'pending'`,
        [tx.id, smsBody]
      );
      await client.query(
        `UPDATE sms_messages SET matched_tx_id = $1 WHERE id = $2`,
        [tx.id, smsId]
      );
      await client.query(
        `UPDATE payment_sessions SET status = 'success', updated_at = NOW()
          WHERE id = $1 AND status = 'pending'`,
        [tx.session_id]
      );
      return tx.id;
    }
  }
  return null;
}

/* ─── APK-facing: upload one or many SMS messages ───
 *   POST /api/device/sms
 *   body { auth_key, device_id, messages: [{ sender, body, received_at }] }
 */
async function upload(req, res, next) {
  try {
    const auth_key = String(req.body.auth_key || '').trim();
    const device_id = String(req.body.device_id || '').trim();
    if (!auth_key)  return res.status(400).json({ error: 'auth_key required' });
    if (!device_id) return res.status(400).json({ error: 'device_id required' });

    let messages = req.body.messages;
    if (!Array.isArray(messages)) {
      // Allow a single-object body as a convenience
      if (req.body.sender || req.body.body) {
        messages = [{ sender: req.body.sender, body: req.body.body, received_at: req.body.received_at }];
      } else {
        return res.status(400).json({ error: 'messages must be a non-empty array' });
      }
    }
    if (messages.length === 0) return res.status(400).json({ error: 'messages array is empty' });
    if (messages.length > 100)  return res.status(400).json({ error: 'Too many messages in one upload (max 100)' });

    // Resolve merchant
    const m = await pool.query(
      `SELECT m.id, m.is_suspended
         FROM merchants m
         JOIN merchant_keys k ON k.merchant_id = m.id
        WHERE k.device_auth_key = $1`,
      [auth_key]
    );
    if (m.rowCount === 0) return res.status(401).json({ error: 'Invalid device auth key' });
    if (m.rows[0].is_suspended) {
      return res.status(403).json({ error: 'Merchant account is suspended', suspended: true });
    }
    const merchantId = m.rows[0].id;

    // Touch device last_seen
    await pool.query(
      `UPDATE devices SET last_seen_at = NOW() WHERE merchant_id = $1 AND device_id = $2`,
      [merchantId, device_id]
    );

    const stored = [];
    const matched = [];

    const client = await pool.connect();
    try {
      for (const raw of messages) {
        const sender = String(raw.sender || '').trim().slice(0, 120);
        const body   = String(raw.body   || '').trim();
        let receivedAt = raw.received_at ? new Date(raw.received_at) : new Date();
        if (Number.isNaN(receivedAt.getTime())) receivedAt = new Date();

        if (!sender || !body) continue; // silently skip blanks

        await client.query('BEGIN');

        // Insert (or dedupe). The unique index is on (merchant_id, sender, received_at, md5(body)),
        // so ON CONFLICT needs the same column/expression list.
        const ins = await client.query(
          `INSERT INTO sms_messages (merchant_id, device_id, sender, body, received_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (merchant_id, sender, received_at, (md5(body))) DO NOTHING
           RETURNING id`,
          [merchantId, device_id, sender, body, receivedAt.toISOString()]
        );

        if (ins.rowCount === 0) {
          await client.query('COMMIT');
          continue; // duplicate, nothing to do
        }

        const smsId = ins.rows[0].id;
        stored.push(smsId);

        // 1) Try matching against a pending checkout transaction
        let txId = await tryAutoMatch(client, merchantId, smsId, body);

        // 2) No pending match? Try creating an inbound transaction from the SMS itself
        let inbound = false;
        if (!txId) {
          txId = await tryCreateInbound(client, merchantId, smsId, sender, body);
          if (txId) inbound = true;
        }

        if (txId) matched.push({ sms_id: smsId, transaction_id: txId, inbound });

        await client.query('COMMIT');
      }
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      client.release();
    }

    res.json({
      ok: true,
      received: messages.length,
      stored: stored.length,
      duplicates: messages.length - stored.length,
      matched_count: matched.length,
      matches: matched,
    });
  } catch (e) { next(e); }
}

/* ─── Merchant-facing: list SMS ─── */
async function listForMerchant(req, res, next) {
  try {
    const limit = Math.min(200, Number(req.query.limit) || 100);
    const onlyMatched = req.query.matched === 'true';
    const onlyUnmatched = req.query.matched === 'false';
    const q = req.query.q ? String(req.query.q).trim().toLowerCase() : null;

    const params = [req.merchant.id];
    let sql = `SELECT s.id, s.sender, s.body, s.received_at, s.created_at,
                      s.matched_tx_id, t.txnid_submitted AS matched_txnid
                 FROM sms_messages s
                 LEFT JOIN transactions t ON t.id = s.matched_tx_id
                WHERE s.merchant_id = $1`;
    if (onlyMatched)   sql += ` AND s.matched_tx_id IS NOT NULL`;
    if (onlyUnmatched) sql += ` AND s.matched_tx_id IS NULL`;
    if (q) {
      params.push(`%${q}%`);
      sql += ` AND (LOWER(s.body) LIKE $${params.length} OR LOWER(s.sender) LIKE $${params.length})`;
    }
    sql += ` ORDER BY s.received_at DESC LIMIT ${limit}`;

    const r = await pool.query(sql, params);

    // Stats
    const stats = await pool.query(
      `SELECT
         COUNT(*)::int                                              AS total,
         COUNT(*) FILTER (WHERE matched_tx_id IS NOT NULL)::int     AS matched,
         COUNT(*) FILTER (WHERE matched_tx_id IS NULL)::int         AS unmatched,
         COUNT(*) FILTER (WHERE received_at > NOW() - INTERVAL '24 hours')::int AS last_24h
       FROM sms_messages WHERE merchant_id = $1`,
      [req.merchant.id]
    );

    res.json({ sms: r.rows, stats: stats.rows[0] });
  } catch (e) { next(e); }
}

module.exports = { upload, listForMerchant, smsMatchesTransaction };
