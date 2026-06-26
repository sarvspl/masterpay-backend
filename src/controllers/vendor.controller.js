/**
 * Vendor panel — a vendor (an `accounts` row under a merchant) logging into
 * their OWN dashboard. Authenticated by a vendor JWT (role 'vendor', sub =
 * account id), issued here and verified by middleware/auth.js → requireVendor.
 *
 * Onboarding is self-service: the vendor proves ownership with the PV-XXXX
 * device_auth_key the marketplace gave them, then sets a username + password.
 *
 * Everything else a vendor does (transactions, gateways, devices) reuses the
 * existing merchant controllers, scoped to req.vendor.account_id by the routes.
 */
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { sign } = require('../utils/jwt');
const { getPlatformSettings } = require('../services/wallet');
const smsCtrl = require('./sms.controller');
const { settleForTransaction } = require('../services/activation');

/**
 * Try to auto-confirm a vendor's pending platform payment (activation OR wallet
 * top-up) by matching the TxnID they submitted against the platform's recent
 * SMS — the same logic the customer checkout uses (submitTxn Path C). On a
 * match the payment flips to success and is settled (activate / credit wallet).
 * Returns true if it settled. Safe to call repeatedly (idempotent).
 */
async function attemptVendorPaymentMatch(accountId) {
  const tx = await pool.query(
    `SELECT t.id, t.merchant_id, t.gateway_id, t.txnid_submitted, t.amount,
            g.provider, g.variant, g.account_number, g.account_id
       FROM transactions t JOIN gateways g ON g.id = t.gateway_id
      WHERE (t.activation_account_id = $1 OR t.vendor_topup_account_id = $1)
        AND t.status = 'pending'
      ORDER BY t.created_at DESC LIMIT 1`,
    [accountId]
  );
  if (tx.rowCount === 0) return false;
  const t = tx.rows[0];

  // The vendor may have paid ANY of the platform's receiving numbers, so match
  // the SMS against all of them (not just the one the row happens to reference).
  const gws = await pool.query(
    `SELECT id, provider, variant, account_number, account_id
       FROM gateways WHERE merchant_id = $1 AND is_enabled = TRUE`,
    [t.merchant_id]
  );
  const gateways = gws.rows.length ? gws.rows : [{
    id: t.gateway_id, provider: t.provider, variant: t.variant,
    account_number: t.account_number, account_id: t.account_id,
  }];
  const sms = await pool.query(
    `SELECT id, body FROM sms_messages
      WHERE merchant_id = $1
        AND received_at > NOW() - INTERVAL '15 minutes'
        AND LOWER(body) LIKE LOWER('%' || $2 || '%')
      ORDER BY received_at DESC LIMIT 5`,
    [t.merchant_id, t.txnid_submitted]
  );
  for (const s of sms.rows) {
    if (smsCtrl.extractDirection(s.body) === 'debit') continue;
    if (!smsCtrl.findGatewayInSms(s.body, gateways)) continue;
    if (!smsCtrl.smsMatchesTransaction(s.body, { txnid_submitted: t.txnid_submitted, amount: Number(t.amount), customer_phone: null })) continue;
    const upd = await pool.query(
      `UPDATE transactions SET status='success', result_source='sms_late_match',
              matched_sms=$2, verified_at=NOW(), updated_at=NOW()
        WHERE id=$1 AND status='pending' RETURNING id`,
      [t.id, s.body]
    );
    if (upd.rowCount === 0) return false; // lost a race
    await pool.query('UPDATE sms_messages SET matched_tx_id=$1 WHERE id=$2', [t.id, s.id]);
    await settleForTransaction(pool, t.id);
    return true;
  }
  return false;
}

const USERNAME_RE = /^[a-z0-9_]{3,40}$/;

// Same window→SQL mapping the accounts controller uses, kept local so the two
// don't couple.
function windowClause(window, col = 't.created_at') {
  switch (String(window || '').toLowerCase()) {
    case 'today':
    case '1d': return `AND ${col} >= NOW() - INTERVAL '1 day'`;
    case '7d': return `AND ${col} >= NOW() - INTERVAL '7 days'`;
    case '30d': return `AND ${col} >= NOW() - INTERVAL '30 days'`;
    default:   return '';
  }
}

// Is this account allowed to reveal its device key? Either it's unlocked, or the
// platform-wide key-unlock fee is disabled (0). Mirrors the merchant rule.
async function keyVisible(keysUnlocked) {
  if (keysUnlocked) return true;
  const settings = await getPlatformSettings().catch(() => ({ key_unlock_fee: 0 }));
  return Number(settings.key_unlock_fee || 0) <= 0;
}

/* ─── POST /api/vendor/register ───
 * Body: { device_auth_key, username, password }
 * Claims a vendor login for the account that owns `device_auth_key`.
 */
async function register(req, res, next) {
  try {
    const deviceKey = String(req.body.device_auth_key || '').trim();
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!deviceKey) return res.status(400).json({ error: 'Vendor (device) code is required' });
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Username must be 3–40 lowercase letters, numbers, or underscores' });
    }
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const a = await pool.query(
      `SELECT a.id, a.label, a.is_default, a.username, m.is_suspended, m.suspended_reason
         FROM accounts a
         JOIN merchants m ON m.id = a.merchant_id
        WHERE a.device_auth_key = $1`,
      [deviceKey]
    );
    if (a.rowCount === 0) return res.status(404).json({ error: 'No vendor found for that code. Check the code your marketplace gave you.' });
    const acc = a.rows[0];

    if (acc.is_default) {
      return res.status(400).json({ error: 'This code belongs to the marketplace’s primary account. Use the merchant dashboard to sign in.' });
    }
    if (acc.is_suspended) {
      return res.status(403).json({
        error: acc.suspended_reason
          ? `This marketplace account is suspended: ${acc.suspended_reason}`
          : 'This marketplace account is suspended. Contact the marketplace operator.',
        suspended: true,
      });
    }
    if (acc.username) {
      return res.status(409).json({ error: 'This vendor already has a login. Sign in instead.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    let row;
    try {
      const r = await pool.query(
        `UPDATE accounts SET username = $2, password_hash = $3, last_login_at = NOW()
          WHERE id = $1 AND username IS NULL
          RETURNING id, username, label`,
        [acc.id, username, passwordHash]
      );
      if (r.rowCount === 0) return res.status(409).json({ error: 'This vendor already has a login. Sign in instead.' });
      row = r.rows[0];
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Username is already taken', field: 'username' });
      throw e;
    }

    const token = sign({ sub: row.id, username: row.username, role: 'vendor' });
    res.status(201).json({ token, vendor: { id: row.id, username: row.username, label: row.label } });
  } catch (e) { next(e); }
}

/* ─── POST /api/vendor/login ─── Body: { username, password } */
async function login(req, res, next) {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });

    const r = await pool.query(
      `SELECT a.id, a.username, a.password_hash, a.label, m.is_suspended, m.suspended_reason
         FROM accounts a
         JOIN merchants m ON m.id = a.merchant_id
        WHERE a.username = $1`,
      [username]
    );
    if (r.rowCount === 0 || !r.rows[0].password_hash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const ok = await bcrypt.compare(password, r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    if (r.rows[0].is_suspended) {
      return res.status(403).json({
        error: r.rows[0].suspended_reason
          ? `This marketplace account is suspended: ${r.rows[0].suspended_reason}`
          : 'This marketplace account is suspended. Contact the marketplace operator.',
        suspended: true,
      });
    }

    await pool.query('UPDATE accounts SET last_login_at = NOW() WHERE id = $1', [r.rows[0].id]);
    const token = sign({ sub: r.rows[0].id, username: r.rows[0].username, role: 'vendor' });
    res.json({ token });
  } catch (e) { next(e); }
}

/* ─── GET /api/vendor/me ───
 * The vendor's profile + headline stats, scoped to their account.
 */
async function me(req, res, next) {
  try {
    const accountId = req.vendor.account_id;

    // Lazy auto-confirm: while gated, try to match any pending activation
    // payment against the merchant's recent SMS (the panel polls this).
    if (req.vendor.needs_activation) {
      const activated = await attemptVendorPaymentMatch(accountId).catch(() => false);
      if (activated) {
        req.vendor.needs_activation = false;
        req.vendor.activated_at = new Date();
      }
    }

    const a = await pool.query(
      `SELECT a.id, a.label, a.username, a.is_default, a.keys_unlocked, a.device_auth_key,
              a.created_at, a.last_login_at,
              m.name AS merchant_name, m.currency
         FROM accounts a
         JOIN merchants m ON m.id = a.merchant_id
        WHERE a.id = $1`,
      [accountId]
    );
    if (a.rowCount === 0) return res.status(404).json({ error: 'Vendor not found' });
    const acc = a.rows[0];

    const visible = await keyVisible(acc.keys_unlocked);

    // Successful-verification count + sum on this vendor's gateways, for the
    // requested window (mirrors the merchant accounts stats).
    const stats = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE t.status = 'success')::int                       AS txn_count,
              COALESCE(SUM(t.amount) FILTER (WHERE t.status = 'success'), 0)::numeric AS txn_total,
              COUNT(*) FILTER (WHERE t.status = 'pending')::int                       AS pending_count
         FROM transactions t
         JOIN gateways g ON g.id = t.gateway_id
        WHERE g.account_id = $1 ${windowClause(req.query.window)}`,
      [accountId]
    );
    const gw = await pool.query(
      `SELECT COUNT(*)::int AS n FROM gateways WHERE account_id = $1 AND is_enabled = TRUE`,
      [accountId]
    );
    const dev = await pool.query(
      `SELECT COUNT(*)::int AS n FROM devices WHERE account_id = $1 AND unbound_at IS NULL`,
      [accountId]
    );

    // Activation: where to pay (the merchant's Primary number) and any payment
    // already submitted and awaiting confirmation.
    let payTo = [];
    let pendingActivation = null;
    if (req.vendor.needs_activation) {
      // The fee is paid to the PLATFORM (MASTER PAY), so show the platform's
      // receiving numbers.
      const pg = await pool.query(
        `SELECT g.provider, g.variant, g.account_number, g.label
           FROM gateways g JOIN merchants m ON m.id = g.merchant_id
          WHERE m.is_platform = TRUE AND g.is_enabled = TRUE
          ORDER BY g.created_at ASC`
      );
      payTo = pg.rows;
      const pend = await pool.query(
        `SELECT id, txnid_submitted, amount, status, created_at
           FROM transactions
          WHERE activation_account_id = $1 AND status = 'pending'
          ORDER BY created_at DESC LIMIT 1`,
        [accountId]
      );
      pendingActivation = pend.rows[0] || null;
    }

    res.json({
      vendor: {
        id:              acc.id,
        label:           acc.label,
        username:        acc.username,
        merchant_name:   acc.merchant_name,
        currency:        acc.currency || 'BDT',
        keys_unlocked:   visible,
        device_auth_key: visible ? acc.device_auth_key : null,
        created_at:      acc.created_at,
        last_login_at:   acc.last_login_at,
        gateway_count:   gw.rows[0].n,
        device_count:    dev.rows[0].n,
        txn_count:       stats.rows[0].txn_count,
        txn_total:       Number(stats.rows[0].txn_total),
        pending_count:   stats.rows[0].pending_count,
        // Activation paywall
        needs_activation:   req.vendor.needs_activation,
        activation_fee:     req.vendor.activation_fee,
        activated_at:       req.vendor.activated_at,
        pay_to:             payTo,
        pending_activation: pendingActivation,
      },
      window: String(req.query.window || 'all').toLowerCase(),
    });
  } catch (e) { next(e); }
}

/* ─── POST /api/vendor/me/password ─── Body: { current_password, new_password } */
async function changePassword(req, res, next) {
  try {
    const current = String(req.body.current_password || '');
    const next = String(req.body.new_password || '');
    if (!current || !next) return res.status(400).json({ error: 'Both current and new password are required' });
    if (next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
    if (current === next) return res.status(400).json({ error: 'New password must be different from current password' });

    const r = await pool.query('SELECT password_hash FROM accounts WHERE id = $1', [req.vendor.account_id]);
    if (r.rowCount === 0 || !r.rows[0].password_hash) return res.status(404).json({ error: 'Vendor not found' });

    const ok = await bcrypt.compare(current, r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect', field: 'current_password' });

    const newHash = await bcrypt.hash(next, 10);
    await pool.query('UPDATE accounts SET password_hash = $1 WHERE id = $2', [newHash, req.vendor.account_id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
}

/* ─── POST /api/vendor/activation/submit ───
 * The vendor submits the TxnID + sender + screenshot of the activation-fee
 * payment they made to the merchant's Primary number. We create a PENDING
 * transaction tagged as an activation; it confirms via SMS auto-match (the
 * merchant's bound phone) or the merchant's manual Approve, which sets
 * accounts.activated_at and unlocks the panel.
 */
async function submitActivation(req, res, next) {
  try {
    if (!req.vendor.needs_activation) {
      return res.status(400).json({ error: 'Your account is already activated.' });
    }
    const txnid = String(req.body.txnid || '').trim();
    const sender_account = String(req.body.sender_account || '').trim();
    const proof_image = typeof req.body.proof_image === 'string' ? req.body.proof_image : '';
    if (!txnid) return res.status(400).json({ error: 'Transaction ID is required' });
    if (!sender_account) return res.status(400).json({ error: 'Sender number is required' });
    if (!/^[0-9+\-\s]{4,40}$/.test(sender_account)) return res.status(400).json({ error: 'Enter a valid sender mobile/account number' });
    if (!proof_image) return res.status(400).json({ error: 'Payment screenshot is required' });

    // The fee is paid to the PLATFORM (MASTER PAY) — pick its first enabled gateway.
    const pg = await pool.query(
      `SELECT g.id, m.id AS platform_merchant_id
         FROM gateways g JOIN merchants m ON m.id = g.merchant_id
        WHERE m.is_platform = TRUE AND g.is_enabled = TRUE
        ORDER BY g.created_at ASC LIMIT 1`
    );
    if (pg.rowCount === 0) {
      return res.status(409).json({
        error: 'Activation is temporarily unavailable — no payment number is configured. Please try again later or contact support.',
        code: 'no_platform_gateway',
      });
    }
    const gatewayId = pg.rows[0].id;
    const platformMerchantId = pg.rows[0].platform_merchant_id;

    // Anti-replay: a TxnID is unique per (platform) merchant.
    const dup = await pool.query(
      `SELECT id, status FROM transactions
        WHERE merchant_id = $1 AND LOWER(txnid_submitted) = LOWER($2)
        ORDER BY created_at DESC LIMIT 1`,
      [platformMerchantId, txnid]
    );
    if (dup.rowCount > 0) {
      const e = dup.rows[0];
      // Re-submitting the same pending activation txn → treat as idempotent.
      if (e.status === 'pending') return res.status(200).json({ ok: true, status: 'pending', duplicate: true });
      return res.status(409).json({ error: 'This Transaction ID has already been used.' , existing_status: e.status });
    }

    let proof_image_url = null;
    try {
      proof_image_url = require('../services/proof').saveProofImage(proof_image);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }

    const r = await pool.query(
      `INSERT INTO transactions
         (merchant_id, gateway_id, txnid_submitted, amount, sender_account, proof_image_url, activation_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, status, created_at`,
      [platformMerchantId, gatewayId, txnid, req.vendor.activation_fee, sender_account, proof_image_url, req.vendor.account_id]
    );

    // Immediate auto-confirm if the platform's SMS for this TxnID already arrived.
    const matched = await attemptVendorPaymentMatch(req.vendor.account_id).catch(() => false);
    if (matched) {
      return res.status(200).json({ ok: true, status: 'success', activated: true });
    }

    // Otherwise ping the platform's bound phone(s) so the admin can approve.
    try {
      const { notifyVerifyRequest } = require('../utils/push');
      notifyVerifyRequest(platformMerchantId, {
        verification_id: r.rows[0].id,
        txnid,
        amount: Number(req.vendor.activation_fee).toFixed(2),
        note: `Vendor activation: ${req.vendor.username}`,
        created_at: r.rows[0].created_at,
      }).catch(() => {});
    } catch {}

    res.status(202).json({ ok: true, status: 'pending', transaction_id: r.rows[0].id });
  } catch (e) {
    if (e && e.code === '23505') return res.status(409).json({ error: 'This Transaction ID has already been used.' });
    next(e);
  }
}

/* ─── GET /api/vendor/wallet ───
 * The vendor's wallet: balance, recent ledger, low-balance flag, and where to
 * top up (the platform's numbers).
 */
async function getWallet(req, res, next) {
  try {
    const accountId = req.vendor.account_id;
    const a = await pool.query(
      `SELECT a.wallet_balance, m.currency FROM accounts a JOIN merchants m ON m.id = a.merchant_id WHERE a.id = $1`,
      [accountId]
    );
    if (a.rowCount === 0) return res.status(404).json({ error: 'Vendor not found' });
    const balance = Number(a.rows[0].wallet_balance);

    const settings = await getPlatformSettings().catch(() => ({}));
    const chargingEnabled = !!settings.vendor_verify_charge_enabled && (
      (settings.vendor_verify_charge_type || 'fixed') === 'percent'
        ? Number(settings.vendor_verify_charge_percent) > 0
        : Number(settings.vendor_verify_charge_amount) > 0
    );
    const threshold = Number(settings.low_balance_threshold || 0);

    const ledger = await pool.query(
      `SELECT amount, kind, note, created_at FROM wallet_ledger
        WHERE account_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [accountId]
    );
    const payTo = await pool.query(
      `SELECT g.provider, g.variant, g.account_number, g.label
         FROM gateways g JOIN merchants m ON m.id = g.merchant_id
        WHERE m.is_platform = TRUE AND g.is_enabled = TRUE ORDER BY g.created_at ASC`
    );

    res.json({
      wallet: {
        balance,
        currency: a.rows[0].currency || 'BDT',
        charging_enabled: chargingEnabled,
        charge_type: settings.vendor_verify_charge_type || 'percent',
        charge_amount: Number(settings.vendor_verify_charge_amount || 0),
        charge_percent: Number(settings.vendor_verify_charge_percent || 0),
        low_balance_threshold: threshold,
        low_balance: chargingEnabled && balance < threshold,
        pay_to: payTo.rows,
        ledger: ledger.rows,
      },
    });
  } catch (e) { next(e); }
}

/* ─── POST /api/vendor/wallet/topup ───
 * Body: { amount, txnid, sender_account, proof_image }
 * The vendor paid `amount` to the platform; we book a pending top-up payment.
 * On confirmation (SMS auto-match or admin Approve) the wallet is credited.
 */
async function submitTopup(req, res, next) {
  try {
    const amount = Number(req.body.amount);
    const txnid = String(req.body.txnid || '').trim();
    const sender_account = String(req.body.sender_account || '').trim();
    const proof_image = typeof req.body.proof_image === 'string' ? req.body.proof_image : '';
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Enter a valid top-up amount' });
    if (!txnid) return res.status(400).json({ error: 'Transaction ID is required' });
    if (!sender_account) return res.status(400).json({ error: 'Sender number is required' });
    if (!/^[0-9+\-\s]{4,40}$/.test(sender_account)) return res.status(400).json({ error: 'Enter a valid sender mobile/account number' });
    if (!proof_image) return res.status(400).json({ error: 'Payment screenshot is required' });

    const pg = await pool.query(
      `SELECT g.id, m.id AS platform_merchant_id
         FROM gateways g JOIN merchants m ON m.id = g.merchant_id
        WHERE m.is_platform = TRUE AND g.is_enabled = TRUE
        ORDER BY g.created_at ASC LIMIT 1`
    );
    if (pg.rowCount === 0) {
      return res.status(409).json({ error: 'Top-up is temporarily unavailable — no payment number is configured.', code: 'no_platform_gateway' });
    }
    const gatewayId = pg.rows[0].id;
    const platformMerchantId = pg.rows[0].platform_merchant_id;

    const dup = await pool.query(
      `SELECT id, status FROM transactions WHERE merchant_id = $1 AND LOWER(txnid_submitted) = LOWER($2) ORDER BY created_at DESC LIMIT 1`,
      [platformMerchantId, txnid]
    );
    if (dup.rowCount > 0) {
      if (dup.rows[0].status === 'pending') return res.status(200).json({ ok: true, status: 'pending', duplicate: true });
      return res.status(409).json({ error: 'This Transaction ID has already been used.', existing_status: dup.rows[0].status });
    }

    let proof_image_url = null;
    try { proof_image_url = require('../services/proof').saveProofImage(proof_image); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

    const r = await pool.query(
      `INSERT INTO transactions
         (merchant_id, gateway_id, txnid_submitted, amount, sender_account, proof_image_url, vendor_topup_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [platformMerchantId, gatewayId, txnid, Math.round(amount * 100) / 100, sender_account, proof_image_url, req.vendor.account_id]
    );

    const matched = await attemptVendorPaymentMatch(req.vendor.account_id).catch(() => false);
    if (matched) return res.status(200).json({ ok: true, status: 'success', credited: true });

    try {
      const { notifyVerifyRequest } = require('../utils/push');
      notifyVerifyRequest(platformMerchantId, {
        verification_id: r.rows[0].id, txnid, amount: amount.toFixed(2),
        note: `Vendor wallet top-up: ${req.vendor.username}`, created_at: r.rows[0].created_at,
      }).catch(() => {});
    } catch {}

    res.status(202).json({ ok: true, status: 'pending', transaction_id: r.rows[0].id });
  } catch (e) {
    if (e && e.code === '23505') return res.status(409).json({ error: 'This Transaction ID has already been used.' });
    next(e);
  }
}

module.exports = { register, login, me, changePassword, submitActivation, getWallet, submitTopup };
