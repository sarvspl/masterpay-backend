/**
 * Wallet ledger + credit/debit operations.
 *
 * The credit hook is called from every place that flips a transaction.status
 * to 'success'. When the originating session is tagged with
 * metadata.type === 'wallet_topup', we credit the recharge_for_merchant_id's
 * wallet_balance and write a ledger row. Idempotent via a unique index on
 * (source_session_id) WHERE kind = 'topup'.
 */
const pool = require('../db/pool');

/**
 * If `sessionId` belongs to a wallet topup session, credit the originating
 * merchant's wallet. Safe to call from any success path — duplicate calls
 * are no-ops thanks to the partial unique index.
 *
 * Pass an optional `client` if you want this to run inside an existing
 * transaction; otherwise we acquire our own connection.
 *
 * Returns the ledger row that was inserted, or null if nothing to do.
 */
async function creditWalletIfTopup(sessionId, client = null) {
  const runner = client || pool;
  // Load the session + its metadata.
  const s = await runner.query(
    `SELECT id, amount, currency, metadata FROM payment_sessions WHERE id = $1`,
    [sessionId]
  );
  if (s.rowCount === 0) return null;

  const meta = s.rows[0].metadata || {};
  if (meta.type !== 'wallet_topup') return null;

  // merchant_id is a UUID string in this schema. Trim/validate shape.
  const rechargeFor = String(meta.recharge_for_merchant_id || '').trim();
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(rechargeFor)) return null;

  // session.amount is the GROSS the merchant paid (credit + top-up fee). We
  // credit the NET — what they asked to receive. Older sessions (created
  // before the top-up fee existed) carry no topup_credit_amount, so the gross
  // and net are the same and we fall back to session.amount.
  const gross  = Number(s.rows[0].amount);
  const amount = meta.topup_credit_amount != null ? Number(meta.topup_credit_amount) : gross;
  const fee    = meta.topup_fee != null ? Number(meta.topup_fee) : 0;
  const currency = s.rows[0].currency || 'BDT';
  if (!Number.isFinite(amount) || amount <= 0) return null;

  // Need an actual client for the multi-statement transaction. If the caller
  // didn't give us one, acquire ours and manage BEGIN/COMMIT ourselves.
  const ownsClient = !client;
  const c = client || await pool.connect();
  try {
    if (ownsClient) await c.query('BEGIN');

    // Insert the ledger row first. If a topup ledger for this session already
    // exists, the unique index throws 23505 — we swallow it (idempotent).
    let ledgerRow = null;
    try {
      const note = fee > 0
        ? `Wallet recharge — ${currency} ${fee.toFixed(2)} fee on ${currency} ${gross.toFixed(2)} paid`
        : 'Wallet recharge';
      const ins = await c.query(
        `INSERT INTO wallet_ledger (merchant_id, amount, kind, source_session_id, note)
         VALUES ($1, $2, 'topup', $3, $4)
         RETURNING id, amount, kind, source_session_id, created_at`,
        [rechargeFor, amount, sessionId, note]
      );
      ledgerRow = ins.rows[0];
    } catch (e) {
      if (e.code === '23505') {
        if (ownsClient) await c.query('ROLLBACK');
        return null; // already credited — nothing more to do
      }
      throw e;
    }

    // Increment the running total on the merchant.
    await c.query(
      `UPDATE merchants SET wallet_balance = wallet_balance + $1, updated_at = NOW()
        WHERE id = $2`,
      [amount, rechargeFor]
    );

    // Book the top-up fee as platform income (idempotent per session).
    if (fee > 0) {
      await recordPlatformRevenue(c, {
        type: 'topup_fee',
        amount: fee,
        currency,
        merchantId: rechargeFor,
        sourceSessionId: sessionId,
        note: `Top-up fee on ${currency} ${gross.toFixed(2)} recharge`,
      });
    }

    if (ownsClient) await c.query('COMMIT');
    return ledgerRow;
  } catch (e) {
    if (ownsClient) {
      try { await c.query('ROLLBACK'); } catch {}
    }
    throw e;
  } finally {
    if (ownsClient) c.release();
  }
}

/* ─── Per-verification fee (platform → merchant) ─── */

/**
 * Reads the platform settings. Cached for 10s to avoid hammering the DB
 * on every verification.
 */
let _settingsCache = null;
let _settingsCacheAt = 0;

async function getPlatformSettings() {
  const now = Date.now();
  if (_settingsCache && now - _settingsCacheAt < 10_000) return _settingsCache;
  const r = await pool.query(
    `SELECT verify_charge_amount, verify_charge_currency,
            verify_charge_enabled, low_balance_threshold,
            verify_charge_type, verify_charge_percent,
            topup_fee_enabled, topup_fee_percent, key_unlock_fee,
            vendor_activation_fee,
            vendor_verify_charge_enabled, vendor_verify_charge_type,
            vendor_verify_charge_amount, vendor_verify_charge_percent,
            merchant_commission_join_enabled, merchant_commission_join_percent,
            merchant_commission_verify_enabled, merchant_commission_verify_percent,
            vendor_topup_fee_enabled, vendor_topup_fee_percent
       FROM platform_settings WHERE id = 1`
  );
  _settingsCache = r.rows[0] || {
    verify_charge_amount: 0, verify_charge_currency: 'BDT',
    verify_charge_enabled: false, low_balance_threshold: 0,
    verify_charge_type: 'fixed', verify_charge_percent: 0,
    topup_fee_enabled: false, topup_fee_percent: 0, key_unlock_fee: 0,
    vendor_activation_fee: 0,
    vendor_verify_charge_enabled: false, vendor_verify_charge_type: 'percent',
    vendor_verify_charge_amount: 0, vendor_verify_charge_percent: 0,
    merchant_commission_join_enabled: false, merchant_commission_join_percent: 0,
    merchant_commission_verify_enabled: false, merchant_commission_verify_percent: 0,
    vendor_topup_fee_enabled: false, vendor_topup_fee_percent: 0,
  };
  _settingsCacheAt = now;
  return _settingsCache;
}

/**
 * Compute the fee to debit for one verified payment, given the platform
 * settings and the payment's amount.
 *
 *   - fixed   → the flat verify_charge_amount, regardless of payment size
 *   - percent → verify_charge_percent % of paymentAmount, rounded to 2dp
 *
 * Returns 0 when charging is disabled, the configured rate is 0, or (for
 * percent) the payment amount is missing/non-positive. Callers treat a 0 fee
 * as "nothing to charge".
 */
function computeVerifyFee(settings, paymentAmount) {
  if (!settings || !settings.verify_charge_enabled) return 0;
  const type = settings.verify_charge_type || 'fixed';

  if (type === 'percent') {
    const pct = Number(settings.verify_charge_percent);
    const amt = Number(paymentAmount);
    if (!Number.isFinite(pct) || pct <= 0) return 0;
    if (!Number.isFinite(amt) || amt <= 0) return 0;
    // amt * pct / 100, rounded to 2 decimals (× 100 then ÷ 100 → × pct ÷ 100).
    return Math.round(amt * pct) / 100;
  }

  const fixed = Number(settings.verify_charge_amount);
  return Number.isFinite(fixed) && fixed > 0 ? fixed : 0;
}

/**
 * Compute the wallet top-up fee for a given credit amount. The fee is ADDED
 * ON TOP — the merchant pays (creditAmount + fee) and we credit creditAmount.
 *
 * Returns 0 when the fee is disabled, the rate is 0, or the credit amount is
 * missing/non-positive. Rounded to 2 decimals.
 */
function computeTopupFee(settings, creditAmount) {
  if (!settings || !settings.topup_fee_enabled) return 0;
  const pct = Number(settings.topup_fee_percent);
  const amt = Number(creditAmount);
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  if (!Number.isFinite(amt) || amt <= 0) return 0;
  return Math.round(amt * pct) / 100; // amt * pct / 100, rounded to 2dp
}

/**
 * Append a row to the platform revenue ledger (super-admin income view).
 * Always positive `amount`. Idempotent via the partial unique indexes on
 * source_transaction_id (verify_fee) / source_session_id (topup_fee) — a
 * duplicate (23505) is swallowed. Runs on the caller's transaction `client`
 * so it commits/rolls back atomically with the wallet change that earned it.
 */
async function recordPlatformRevenue(client, { type, amount, currency, merchantId, sourceTransactionId, sourceSessionId, note }) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return null;
  try {
    const r = await client.query(
      `INSERT INTO platform_revenue
         (type, amount, currency, merchant_id, source_transaction_id, source_session_id, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [type, amt, currency || 'BDT', merchantId || null, sourceTransactionId || null, sourceSessionId || null, note || null]
    );
    return r.rows[0];
  } catch (e) {
    if (e.code === '23505') return null; // already recorded — idempotent
    throw e;
  }
}

/**
 * Manually invalidate the settings cache. Called from updateSettings so the
 * next read after a Save sees the new values immediately.
 */
function invalidatePlatformSettingsCache() {
  _settingsCache = null;
  _settingsCacheAt = 0;
}

/**
 * Check that a merchant's wallet has at least the configured per-verification
 * fee available. Used by walletGuard middleware before letting an operation
 * proceed.
 *
 * Returns { ok, balance, fee, threshold, enabled, reason? }.
 *   - ok=true  → operation may proceed
 *   - ok=false → return 402 to caller with reason
 *
 * The platform merchant itself is always considered sufficient (we don't
 * charge ourselves).
 */
async function checkWalletSufficient(merchantId, paymentAmount = null) {
  const settings = await getPlatformSettings();
  const type = settings.verify_charge_type || 'fixed';
  // If the platform isn't charging, every merchant has effectively infinite credit.
  const charging = settings.verify_charge_enabled && (
    type === 'percent'
      ? Number(settings.verify_charge_percent) > 0
      : Number(settings.verify_charge_amount) > 0
  );
  if (!charging) {
    return { ok: true, balance: null, fee: 0, threshold: 0, enabled: false };
  }

  const m = await pool.query(
    `SELECT wallet_balance, is_platform FROM merchants WHERE id = $1`,
    [merchantId]
  );
  if (m.rowCount === 0) return { ok: false, reason: 'merchant_not_found' };
  if (m.rows[0].is_platform) {
    return { ok: true, balance: null, fee: 0, threshold: 0, enabled: false };
  }

  const balance   = Number(m.rows[0].wallet_balance);
  const threshold = Number(settings.low_balance_threshold);

  // Fixed: the required balance is the flat fee. Percentage: the fee scales
  // with the payment amount, so when the amount is known we require the exact
  // computed fee; when it isn't (a generic guard with no session in hand) we
  // only require a positive balance and let debitVerifyFee enforce the exact
  // figure later — it refuses to push the wallet negative.
  const fee = type === 'percent'
    ? (paymentAmount != null ? computeVerifyFee(settings, paymentAmount) : 0)
    : Number(settings.verify_charge_amount);
  const required = (type === 'percent' && paymentAmount == null) ? 0.01 : fee;

  if (balance < required) {
    return { ok: false, balance, fee, threshold, enabled: true, reason: 'insufficient_balance' };
  }
  return { ok: true, balance, fee, threshold, enabled: true };
}

/**
 * Debit the per-verification fee from a merchant's wallet for one verified
 * transaction. Idempotent via unique partial index on
 * wallet_ledger(source_transaction_id) WHERE kind='debit_verify'.
 *
 * Skipped when:
 *   - charge is disabled or amount is 0
 *   - the merchant is the platform itself
 *   - the originating session is a wallet topup (recharging is free)
 *   - DEFENSIVE: the debit would push wallet_balance below 0 (any upstream
 *     guard that lets a chargeable success slip through finds this safety net
 *     and silently returns null instead of going into debt).
 */
async function debitVerifyFee(merchantId, transactionId, sessionId, client = null) {
  const settings = await getPlatformSettings();

  // If this transaction is on a VENDOR account, the vendor pays the fee from
  // their OWN wallet (at the vendor rate) and the merchant is not charged.
  const va = await pool.query(
    `SELECT a.id AS account_id, a.is_default, a.external_id, a.username
       FROM transactions t JOIN gateways g ON g.id = t.gateway_id JOIN accounts a ON a.id = g.account_id
      WHERE t.id = $1`,
    [transactionId]
  );
  if (va.rowCount > 0) {
    const a = va.rows[0];
    if (!a.is_default && (a.external_id != null || a.username != null)) {
      return debitVendorVerifyFee(a.account_id, transactionId, settings, client);
    }
  }

  if (!settings.verify_charge_enabled) return null;
  // For percentage charging the exact fee depends on the payment amount, which
  // we read from the transaction row inside the locked query below. For fixed
  // charging we can bail early when the rate is 0.
  const chargeType = settings.verify_charge_type || 'fixed';
  if (chargeType !== 'percent' && Number(settings.verify_charge_amount) <= 0) return null;

  // CONCURRENCY: Two near-simultaneous successful verifications for the same
  // merchant must not both pass the balance check when balance == fee × 2 − ε.
  // We solve this by doing the read + write inside a single transaction with
  // SELECT ... FOR UPDATE on the merchant row. The lock is released on
  // COMMIT/ROLLBACK; the second concurrent debit blocks until the first
  // commits, then reads the decremented balance and correctly rejects if
  // insufficient.
  const ownsClient = !client;
  const c = client || await pool.connect();
  try {
    if (ownsClient) await c.query('BEGIN');

    // Lock the merchant row + read what we need atomically. The sub-select
    // for sess_kind is read-only and doesn't need locking.
    const guard = await c.query(
      `SELECT m.is_platform, m.wallet_balance,
              (SELECT (metadata->>'type') FROM payment_sessions WHERE id = $2) AS sess_kind,
              (SELECT amount FROM transactions WHERE id = $3) AS tx_amount
         FROM merchants m
        WHERE m.id = $1
        FOR UPDATE`,
      [merchantId, sessionId || null, transactionId]
    );
    if (guard.rowCount === 0) {
      if (ownsClient) await c.query('ROLLBACK');
      return null;
    }
    if (guard.rows[0].is_platform) {
      if (ownsClient) await c.query('ROLLBACK');
      return null;
    }
    if (guard.rows[0].sess_kind === 'wallet_topup') {
      if (ownsClient) await c.query('ROLLBACK');
      return null;
    }

    // Now that we have the transaction amount, compute the actual fee. For
    // percentage charging this scales with the payment; for fixed it's flat.
    const fee = computeVerifyFee(settings, guard.rows[0].tx_amount);
    if (fee <= 0) {
      if (ownsClient) await c.query('ROLLBACK');
      return null;
    }

    const currentBalance = Number(guard.rows[0].wallet_balance);
    if (currentBalance < fee) {
      // Either we got here through a race with another debit, or an upstream
      // guard let a chargeable success slip through. Refuse to go negative.
      console.warn(
        `[wallet] debit refused — merchant ${merchantId} balance ${currentBalance} < fee ${fee} (tx ${transactionId})`
      );
      if (ownsClient) await c.query('ROLLBACK');
      return null;
    }

    // Negative amount = debit; positive = credit. Ledger is the source of truth.
    const note = chargeType === 'percent'
      ? `Verification fee (${Number(settings.verify_charge_percent)}%)`
      : 'Verification fee';
    let ledger = null;
    try {
      const ins = await c.query(
        `INSERT INTO wallet_ledger (merchant_id, amount, kind, source_transaction_id, note)
         VALUES ($1, $2, 'debit_verify', $3, $4)
         RETURNING id, amount, kind, source_transaction_id, created_at`,
        [merchantId, -fee, transactionId, note]
      );
      ledger = ins.rows[0];
    } catch (e) {
      if (e.code === '23505') {
        if (ownsClient) await c.query('ROLLBACK');
        return null; // already debited for this tx — idempotent
      }
      throw e;
    }

    await c.query(
      `UPDATE merchants SET wallet_balance = wallet_balance - $1, updated_at = NOW()
        WHERE id = $2`,
      [fee, merchantId]
    );

    // Book the verification fee as platform income (idempotent per transaction).
    await recordPlatformRevenue(c, {
      type: 'verify_fee',
      amount: fee,
      currency: settings.verify_charge_currency,
      merchantId,
      sourceTransactionId: transactionId,
      note,
    });

    if (ownsClient) await c.query('COMMIT');
    return ledger;
  } catch (e) {
    if (ownsClient) {
      try { await c.query('ROLLBACK'); } catch {}
    }
    throw e;
  } finally {
    if (ownsClient) c.release();
  }
}

/**
 * Get the merchant's current wallet snapshot for inclusion in successful
 * device-endpoint responses. Lets the APK keep its balance pill live without
 * a separate API call.
 *
 * Returns { balance, fee, threshold } — fee/threshold from platform_settings,
 * balance from the merchant row. Returns null for the platform merchant
 * itself (no balance to show).
 */
async function getWalletStatusForMerchant(merchantId) {
  const m = await pool.query(
    `SELECT wallet_balance, is_platform FROM merchants WHERE id = $1`,
    [merchantId]
  );
  if (m.rowCount === 0 || m.rows[0].is_platform) return null;
  const settings = await getPlatformSettings();
  return {
    balance:        Number(m.rows[0].wallet_balance),
    fee:            Number(settings.verify_charge_amount || 0),
    threshold:      Number(settings.low_balance_threshold || 0),
    charge_type:    settings.verify_charge_type || 'fixed',
    charge_percent: Number(settings.verify_charge_percent || 0),
  };
}

/**
 * Is this account a vendor (a seller), as opposed to a merchant's own Primary?
 * Mirrors services/vendors.js → isVendorAccount, but takes a row we already have.
 */
function isVendorRow(a) {
  return !!a && !a.is_default && (a.external_id != null || a.username != null);
}

/**
 * Wallet snapshot for the APK's balance pill, keyed on the ACCOUNT the phone is
 * bound to — not the merchant.
 *
 * A vendor's phone must see the vendor's balance and the vendor's fee rate,
 * because that is the wallet a verification actually debits. It used to call
 * getWalletStatusForMerchant, so a seller's phone displayed the marketplace's
 * balance — a number the seller neither controls nor is charged against.
 *
 * Falls back to the merchant's snapshot for a non-vendor (Primary) account.
 */
async function getWalletStatusForAccount(accountId) {
  if (!accountId) return null;
  const a = await pool.query(
    `SELECT id, merchant_id, is_default, external_id, username, wallet_balance
       FROM accounts WHERE id = $1`,
    [accountId]
  );
  if (a.rowCount === 0) return null;
  const row = a.rows[0];
  if (!isVendorRow(row)) return getWalletStatusForMerchant(row.merchant_id);

  const settings = await getPlatformSettings();
  return {
    balance:        Number(row.wallet_balance),
    fee:            Number(settings.vendor_verify_charge_amount || 0),
    threshold:      Number(settings.low_balance_threshold || 0),
    charge_type:    settings.vendor_verify_charge_type || 'fixed',
    charge_percent: Number(settings.vendor_verify_charge_percent || 0),
  };
}

/* ─────────────────────────── VENDOR WALLET ─────────────────────────────────
 * Vendors are billed like merchants but from their own per-account wallet, at
 * an admin-set vendor-specific rate. */

function computeVendorVerifyFee(settings, paymentAmount) {
  if (!settings || !settings.vendor_verify_charge_enabled) return 0;
  const type = settings.vendor_verify_charge_type || 'fixed';
  if (type === 'percent') {
    const pct = Number(settings.vendor_verify_charge_percent);
    const amt = Number(paymentAmount);
    if (!Number.isFinite(pct) || pct <= 0) return 0;
    if (!Number.isFinite(amt) || amt <= 0) return 0;
    return Math.round(amt * pct) / 100;
  }
  const fixed = Number(settings.vendor_verify_charge_amount);
  return Number.isFinite(fixed) && fixed > 0 ? fixed : 0;
}

// Is this vendor's wallet able to cover a verification? Returns
// { ok, balance, fee, enabled, reason? }. When charging is off, always ok.
async function checkVendorWalletSufficient(accountId, paymentAmount = null) {
  const settings = await getPlatformSettings();
  const type = settings.vendor_verify_charge_type || 'fixed';
  const charging = settings.vendor_verify_charge_enabled && (
    type === 'percent'
      ? Number(settings.vendor_verify_charge_percent) > 0
      : Number(settings.vendor_verify_charge_amount) > 0
  );
  if (!charging) return { ok: true, balance: null, fee: 0, enabled: false };

  const a = await pool.query('SELECT wallet_balance FROM accounts WHERE id = $1', [accountId]);
  if (a.rowCount === 0) return { ok: false, reason: 'account_not_found' };
  const balance = Number(a.rows[0].wallet_balance);
  const fee = type === 'percent'
    ? (paymentAmount != null ? computeVendorVerifyFee(settings, paymentAmount) : 0)
    : Number(settings.vendor_verify_charge_amount);
  const required = (type === 'percent' && paymentAmount == null) ? 0.01 : fee;
  if (balance < required) {
    return { ok: false, balance, fee, enabled: true, reason: 'insufficient_balance' };
  }
  return { ok: true, balance, fee, enabled: true };
}

// Debit the per-verification fee from a VENDOR's wallet. Mirrors
// debitVerifyFee: atomic, idempotent (uniq_debit_verify_per_transaction),
// refuses to go negative. Records platform revenue.
async function debitVendorVerifyFee(accountId, transactionId, settings, client = null) {
  if (!settings.vendor_verify_charge_enabled) return null;
  const chargeType = settings.vendor_verify_charge_type || 'fixed';
  if (chargeType !== 'percent' && Number(settings.vendor_verify_charge_amount) <= 0) return null;

  const ownsClient = !client;
  const c = client || await pool.connect();
  try {
    if (ownsClient) await c.query('BEGIN');
    const guard = await c.query(
      `SELECT a.wallet_balance, a.merchant_id,
              (SELECT amount FROM transactions WHERE id = $2) AS tx_amount
         FROM accounts a WHERE a.id = $1 FOR UPDATE`,
      [accountId, transactionId]
    );
    if (guard.rowCount === 0) { if (ownsClient) await c.query('ROLLBACK'); return null; }

    const fee = computeVendorVerifyFee(settings, guard.rows[0].tx_amount);
    if (fee <= 0) { if (ownsClient) await c.query('ROLLBACK'); return null; }

    const balance = Number(guard.rows[0].wallet_balance);
    if (balance < fee) {
      console.warn(`[wallet] vendor debit refused — account ${accountId} balance ${balance} < fee ${fee} (tx ${transactionId})`);
      if (ownsClient) await c.query('ROLLBACK');
      return null;
    }

    const note = chargeType === 'percent'
      ? `Verification fee (${Number(settings.vendor_verify_charge_percent)}%)`
      : 'Verification fee';
    let ledger = null;
    try {
      const ins = await c.query(
        `INSERT INTO wallet_ledger (merchant_id, account_id, amount, kind, source_transaction_id, note)
         VALUES ($1, $2, $3, 'debit_verify', $4, $5)
         RETURNING id, amount, kind, created_at`,
        [guard.rows[0].merchant_id, accountId, -fee, transactionId, note]
      );
      ledger = ins.rows[0];
    } catch (e) {
      if (e.code === '23505') { if (ownsClient) await c.query('ROLLBACK'); return null; }
      throw e;
    }

    await c.query('UPDATE accounts SET wallet_balance = wallet_balance - $1 WHERE id = $2', [fee, accountId]);

    // Commission split: the merchant earns a % of this fee; the platform keeps
    // the rest as revenue.
    const commission = computeMerchantCommission(settings, 'verify', fee);
    if (commission > 0) {
      await creditMerchantCommission(
        c, guard.rows[0].merchant_id, commission, transactionId, 'Vendor verification commission',
        { type: 'verify', accountId }
      );
    }
    await recordPlatformRevenue(c, {
      type: 'verify_fee', amount: fee - commission, currency: settings.verify_charge_currency,
      merchantId: guard.rows[0].merchant_id, sourceTransactionId: transactionId, note: 'Vendor ' + note,
    });
    if (ownsClient) await c.query('COMMIT');
    return ledger;
  } catch (e) {
    if (ownsClient) { try { await c.query('ROLLBACK'); } catch {} }
    throw e;
  } finally {
    if (ownsClient) c.release();
  }
}

// Top-up fee added on top of a vendor recharge (vendor pays credit + fee).
function computeVendorTopupFee(settings, creditAmount) {
  if (!settings || !settings.vendor_topup_fee_enabled) return 0;
  const pct = Number(settings.vendor_topup_fee_percent);
  const amt = Number(creditAmount);
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  if (!Number.isFinite(amt) || amt <= 0) return 0;
  return Math.round(amt * pct) / 100;
}

// Credit a vendor's wallet for a confirmed top-up payment. The vendor paid the
// GROSS (transactions.amount); we credit the NET (vendor_topup_credit_amount,
// falling back to gross for older rows) and book the difference as the top-up
// fee (platform revenue). Idempotent via uniq_vendor_topup_per_transaction.
async function creditVendorTopup(db, transactionId) {
  const t = await db.query(
    `SELECT t.amount, t.vendor_topup_credit_amount, t.vendor_topup_account_id AS account_id, a.merchant_id
       FROM transactions t JOIN accounts a ON a.id = t.vendor_topup_account_id
      WHERE t.id = $1 AND t.vendor_topup_account_id IS NOT NULL`,
    [transactionId]
  );
  if (t.rowCount === 0) return false;
  const gross = Number(t.rows[0].amount);
  const net = t.rows[0].vendor_topup_credit_amount != null ? Number(t.rows[0].vendor_topup_credit_amount) : gross;
  if (!(net > 0)) return false;
  const fee = Math.max(0, Math.round((gross - net) * 100) / 100);
  try {
    await db.query(
      `INSERT INTO wallet_ledger (merchant_id, account_id, amount, kind, source_transaction_id, note)
       VALUES ($1, $2, $3, 'vendor_topup', $4, 'Wallet top-up')`,
      [t.rows[0].merchant_id, t.rows[0].account_id, net, transactionId]
    );
  } catch (e) {
    if (e.code === '23505') return false; // already credited
    throw e;
  }
  await db.query('UPDATE accounts SET wallet_balance = wallet_balance + $1 WHERE id = $2', [net, t.rows[0].account_id]);
  if (fee > 0) {
    const settings = await getPlatformSettings().catch(() => ({ verify_charge_currency: 'BDT' }));
    await recordPlatformRevenue(db, {
      type: 'topup_fee', amount: fee, currency: settings.verify_charge_currency || 'BDT',
      merchantId: t.rows[0].merchant_id, sourceTransactionId: transactionId, note: 'Vendor wallet top-up fee',
    });
  }
  return true;
}

/* ───────────────────── MERCHANT COMMISSION (revenue share) ─────────────────
 * Of a fee the platform collects from a merchant's vendor (activation or
 * per-verification), a configurable % is the MERCHANT's share — credited to
 * their wallet; the platform keeps the remainder. */

// kind: 'join' | 'verify'. Returns the merchant's share of `feeAmount` (2dp).
function computeMerchantCommission(settings, kind, feeAmount) {
  const enabled = kind === 'join' ? settings.merchant_commission_join_enabled : settings.merchant_commission_verify_enabled;
  const pct = kind === 'join' ? Number(settings.merchant_commission_join_percent) : Number(settings.merchant_commission_verify_percent);
  if (!enabled || !Number.isFinite(pct) || pct <= 0) return 0;
  const amt = Number(feeAmount);
  if (!Number.isFinite(amt) || amt <= 0) return 0;
  const share = Math.round(amt * pct) / 100; // pct% of fee, 2dp
  return share > amt ? amt : share;          // never exceed the fee
}

/**
 * Credit a merchant's wallet with a commission. Idempotent per source fee
 * (uniq_commission_per_transaction). Returns true if it credited.
 *
 * `meta` records WHAT the commission was for and WHICH vendor produced it:
 *   { type: 'join' | 'verify', accountId }
 * Both are stored on the ledger row so the merchant's Earnings page never has to
 * guess by string-matching `note`.
 *
 * `commission_account_id` is NOT `account_id`. Setting `account_id` would file
 * this credit in the VENDOR's wallet history; the money belongs to the merchant.
 */
async function creditMerchantCommission(db, merchantId, amount, sourceTransactionId, note, meta = {}) {
  const amt = Number(amount);
  if (!merchantId || !(amt > 0)) return false;
  const type = meta.type === 'verify' ? 'verify' : meta.type === 'join' ? 'join' : null;
  try {
    await db.query(
      `INSERT INTO wallet_ledger
         (merchant_id, amount, kind, source_transaction_id, note, commission_type, commission_account_id)
       VALUES ($1, $2, 'commission', $3, $4, $5, $6)`,
      [merchantId, amt, sourceTransactionId, note || 'Commission', type, meta.accountId || null]
    );
  } catch (e) {
    if (e.code === '23505') return false; // already credited
    throw e;
  }
  await db.query('UPDATE merchants SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2', [amt, merchantId]);
  return true;
}

module.exports = {
  creditWalletIfTopup,
  debitVerifyFee,
  checkWalletSufficient,
  computeMerchantCommission,
  creditMerchantCommission,
  computeVendorTopupFee,
  getWalletStatusForMerchant,
  getWalletStatusForAccount,
  isVendorRow,
  getPlatformSettings,
  computeVerifyFee,
  computeTopupFee,
  recordPlatformRevenue,
  invalidatePlatformSettingsCache,
  computeVendorVerifyFee,
  checkVendorWalletSufficient,
  debitVendorVerifyFee,
  creditVendorTopup,
};
