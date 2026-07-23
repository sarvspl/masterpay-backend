/**
 * Super-admin view of a single vendor.
 *
 * The marketplace operator deliberately cannot see a vendor's device key,
 * transactions, or wallet (see merchant.routes.js). The admin is the escalation
 * path: when a seller says "my payment never arrived" or "I'm locked out", this
 * is where support looks — and where they can top up a wallet or reset a
 * password on the seller's behalf.
 *
 * Everything here is read-only except:
 *   POST /api/admin/vendors/:id/wallet          — credit / debit the wallet
 *   POST /api/admin/vendors/:id/reset-password  — set or generate a password
 */
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { generateDeviceAuthKey } = require('../utils/keys');
const { suspendVendor, unsuspendVendor, suspensionOf } = require('../services/vendors');
const {
  getPlatformSettings, recordPlatformRevenue,
  computeMerchantCommission, creditMerchantCommission,
} = require('../services/wallet');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Same rule the seller's own /vendor/register enforces. Usernames are unique
// across every marketplace (uniq_accounts_username), not just within one.
const USERNAME_RE = /^[a-z0-9_]{3,40}$/;

function randomPassword() {
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; // no 0/O/1/l
  let s = '';
  for (let i = 0; i < 12; i++) s += alpha[Math.floor(Math.random() * alpha.length)];
  return s;
}

/**
 * Where a vendor is stuck, using the same precedence as services/availability.js
 * so this list never disagrees with what the marketplace's API reports.
 *
 * `wallet_empty` here is approximate: the real check is "balance >= fee for THIS
 * order", and we have no order. A zero balance can never cover any fee, so that
 * is what we flag.
 */
function vendorState(v, settings) {
  const activationFee = Number(settings.vendor_activation_fee || 0);
  const chargingVendors = settings.vendor_verify_charge_enabled && (
    (settings.vendor_verify_charge_type || 'fixed') === 'percent'
      ? Number(settings.vendor_verify_charge_percent) > 0
      : Number(settings.vendor_verify_charge_amount) > 0
  );

  if (!v.username) return 'never_registered';
  if (activationFee > 0 && !v.activated_at) return 'not_activated';
  if (Number(v.gateway_count) === 0) return 'no_payment_number';
  if (Number(v.enabled_gateway_count) === 0) return 'all_paused';
  if (chargingVendors && Number(v.wallet_balance) <= 0) return 'wallet_empty';
  return 'ready';
}

/* ─── GET /api/admin/vendors ───
 * Every vendor under every marketplace. Query: ?state=&q=&merchant_id=
 * This is the page for finding sellers who never made it through onboarding.
 */
async function listVendors(req, res, next) {
  try {
    const settings = await getPlatformSettings().catch(() => ({}));

    const params = [];
    let where = 'a.is_default = FALSE';
    if (req.query.merchant_id && UUID_RE.test(String(req.query.merchant_id))) {
      params.push(req.query.merchant_id);
      where += ` AND a.merchant_id = $${params.length}`;
    }
    if (req.query.q && String(req.query.q).trim()) {
      params.push(`%${String(req.query.q).trim().toLowerCase()}%`);
      where += ` AND (LOWER(a.label) LIKE $${params.length} OR LOWER(a.username) LIKE $${params.length}
                      OR LOWER(a.external_id) LIKE $${params.length} OR LOWER(m.name) LIKE $${params.length})`;
    }

    const r = await pool.query(
      `SELECT a.id, a.label, a.username, a.external_id, a.activated_at, a.wallet_balance, a.created_at,
              a.merchant_id, m.name AS merchant_name, m.is_suspended AS merchant_suspended,
              (SELECT COUNT(*)::int FROM gateways g WHERE g.account_id = a.id)                          AS gateway_count,
              (SELECT COUNT(*)::int FROM gateways g WHERE g.account_id = a.id AND g.is_enabled) AS enabled_gateway_count,
              (SELECT COUNT(*)::int FROM devices d WHERE d.account_id = a.id AND d.unbound_at IS NULL)  AS device_count,
              (SELECT COUNT(*)::int FROM transactions t JOIN gateways g2 ON g2.id = t.gateway_id
                WHERE g2.account_id = a.id AND t.status = 'success')                                    AS txn_count
         FROM accounts a
         JOIN merchants m ON m.id = a.merchant_id
        WHERE ${where}
        ORDER BY a.created_at DESC`,
      params
    );

    let vendors = r.rows.map((v) => ({
      id: v.id,
      label: v.label,
      username: v.username,
      has_login: v.username != null,
      external_id: v.external_id,
      is_activated: v.activated_at != null,
      wallet_balance: Number(v.wallet_balance || 0),
      gateway_count: v.gateway_count,
      enabled_gateway_count: v.enabled_gateway_count,
      device_count: v.device_count,
      txn_count: v.txn_count,
      created_at: v.created_at,
      merchant: { id: v.merchant_id, name: v.merchant_name, is_suspended: v.merchant_suspended },
      state: vendorState(v, settings),
    }));

    // Counts are of the WHOLE (searched) set, so the filter chips don't lie when
    // one state is selected.
    const counts = vendors.reduce((acc, v) => { acc[v.state] = (acc[v.state] || 0) + 1; return acc; }, {});
    if (req.query.state && req.query.state !== 'all') {
      vendors = vendors.filter((v) => v.state === req.query.state);
    }

    res.json({
      vendors,
      counts: { all: r.rowCount, ...counts },
      activation_fee: Number(settings.vendor_activation_fee || 0),
    });
  } catch (e) { next(e); }
}

// A vendor is a non-Primary account. Primary belongs to the merchant itself and
// must never be reachable through these endpoints.
async function loadVendor(id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  const r = await pool.query(
    `SELECT a.id, a.label, a.username, a.external_id, a.device_auth_key,
            a.keys_unlocked, a.activated_at, a.activation_fee, a.wallet_balance,
            a.last_login_at, a.created_at,
            a.suspended_at, a.suspended_by, a.suspended_reason,
            a.merchant_id, m.name AS merchant_name, m.username AS merchant_username,
            m.is_suspended AS merchant_suspended
       FROM accounts a
       JOIN merchants m ON m.id = a.merchant_id
      WHERE a.id = $1 AND a.is_default = FALSE`,
    [id]
  );
  return r.rows[0] || null;
}

/* ─── GET /api/admin/vendors/:id ─── */
async function getVendor(req, res, next) {
  try {
    const v = await loadVendor(req.params.id);
    if (!v) return res.status(404).json({ error: 'Vendor not found' });

    const [gateways, devices, txns, ledger, platformPayments] = await Promise.all([
      pool.query(
        `SELECT id, provider, variant, account_number, label, is_enabled,
                min_amount, max_amount, charge_value, charge_type,
                discount_value, discount_type, created_at
           FROM gateways WHERE account_id = $1 ORDER BY created_at ASC`,
        [v.id]
      ),
      pool.query(
        `SELECT id, device_id, model, manufacturer, binder_name, telegram_handle, whatsapp,
                last_seen_at, created_at, unbound_at
           FROM devices WHERE account_id = $1 ORDER BY created_at DESC`,
        [v.id]
      ),
      // Payments this vendor RECEIVED from customers.
      pool.query(
        `SELECT t.id, t.txnid_submitted, t.amount, t.status, t.result_source,
                t.sender_account, t.failure_reason, t.verified_at, t.created_at,
                g.provider, g.variant, g.account_number,
                s.order_id
           FROM transactions t
           JOIN gateways g ON g.id = t.gateway_id
           LEFT JOIN payment_sessions s ON s.id = t.session_id
          WHERE g.account_id = $1
          ORDER BY t.created_at DESC
          LIMIT 50`,
        [v.id]
      ),
      pool.query(
        `SELECT id, amount, kind, note, created_at
           FROM wallet_ledger WHERE account_id = $1
          ORDER BY created_at DESC LIMIT 50`,
        [v.id]
      ),
      // Payments this vendor MADE to the platform (activation + top-ups).
      pool.query(
        `SELECT id, amount, status, txnid_submitted, created_at, verified_at,
                (activation_account_id IS NOT NULL) AS is_activation
           FROM transactions
          WHERE activation_account_id = $1 OR vendor_topup_account_id = $1
          ORDER BY created_at DESC LIMIT 50`,
        [v.id]
      ),
    ]);

    res.json({
      vendor: {
        id: v.id,
        label: v.label,
        username: v.username,
        has_login: v.username != null,
        external_id: v.external_id,
        device_auth_key: v.device_auth_key,   // admin only — never sent to the merchant
        keys_unlocked: v.keys_unlocked,
        is_activated: v.activated_at != null,
        activated_at: v.activated_at,
        activation_fee: Number(v.activation_fee || 0),
        wallet_balance: Number(v.wallet_balance || 0),
        last_login_at: v.last_login_at,
        created_at: v.created_at,
        ...suspensionOf(v),   // suspended, suspended_by, suspended_reason, suspended_at
        merchant: {
          id: v.merchant_id,
          name: v.merchant_name,
          username: v.merchant_username,
          is_suspended: v.merchant_suspended,
        },
        gateways: gateways.rows,
        devices: devices.rows,
        transactions: txns.rows,
        ledger: ledger.rows,
        platform_payments: platformPayments.rows,
      },
    });
  } catch (e) { next(e); }
}

/* ─── POST /api/admin/vendors/:id/wallet ───
 * body: { amount, note? }  — a CREDIT only. `amount` must be positive.
 *
 * Deliberately one-directional. An admin may add balance (a top-up that never
 * auto-matched, a refund, comping a new seller) but may never take it away: a
 * mis-typed debit would empty a seller's wallet mid-trading and knock them
 * offline at checkout. To claw money back, debit through the normal fee path or
 * suspend the marketplace.
 *
 * No money is collected here and no platform revenue is booked — this creates
 * spendable balance. The ledger row is the only trace, and the vendor sees it.
 */
async function creditVendorWallet(req, res, next) {
  const client = await pool.connect();
  try {
    const amount = Number(req.body && req.body.amount);
    const note = String((req.body && req.body.note) || '').slice(0, 500) || 'Admin top-up';

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number — wallets can only be topped up, not debited' });
    }
    if (amount > 10_000_000) {
      return res.status(400).json({ error: 'amount out of range' });
    }
    if (!UUID_RE.test(String(req.params.id || ''))) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    await client.query('BEGIN');

    const a = await client.query(
      `SELECT id, merchant_id, wallet_balance FROM accounts
        WHERE id = $1 AND is_default = FALSE FOR UPDATE`,
      [req.params.id]
    );
    if (a.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Vendor not found' });
    }

    // account_id is what scopes this row to the vendor's own ledger; merchant_id
    // is still stamped because the column is NOT NULL.
    const ledger = await client.query(
      `INSERT INTO wallet_ledger (merchant_id, account_id, amount, kind, note)
       VALUES ($1, $2, $3, 'adjustment', $4)
       RETURNING id, amount, kind, note, created_at`,
      [a.rows[0].merchant_id, a.rows[0].id, amount, note]
    );
    const upd = await client.query(
      `UPDATE accounts SET wallet_balance = wallet_balance + $1 WHERE id = $2
       RETURNING wallet_balance`,
      [amount, a.rows[0].id]
    );

    await client.query('COMMIT');
    res.json({
      ok: true,
      vendor_id: a.rows[0].id,
      balance: Number(upd.rows[0].wallet_balance),
      ledger: ledger.rows[0],
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    next(e);
  } finally {
    client.release();
  }
}

/* ─── POST /api/admin/vendors/:id/reset-password ───
 * body: { new_password? } — omit to have one generated. Returned ONCE, never stored.
 */
async function resetVendorPassword(req, res, next) {
  try {
    const v = await loadVendor(req.params.id);
    if (!v) return res.status(404).json({ error: 'Vendor not found' });
    if (!v.username) {
      // No panel login exists yet — the seller has never registered, so there's
      // no password to reset. They claim the account with their device key.
      return res.status(400).json({
        error: 'This vendor has not registered a panel login yet. They claim it with their device key at /vendor/register.',
        code: 'no_login',
      });
    }

    let supplied = req.body && req.body.new_password ? String(req.body.new_password) : null;
    const generated = !supplied;

    if (supplied != null && supplied.length < 6) {
      return res.status(400).json({ error: 'new_password must be at least 6 characters' });
    }
    if (!supplied) {
      const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; // no 0/O/1/l
      supplied = '';
      for (let i = 0; i < 12; i++) supplied += alpha[Math.floor(Math.random() * alpha.length)];
    }

    const hash = await bcrypt.hash(supplied, 10);
    const r = await pool.query(
      `UPDATE accounts SET password_hash = $1 WHERE id = $2 AND is_default = FALSE
       RETURNING id, username, label`,
      [hash, v.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Vendor not found' });

    res.json({ ok: true, password: supplied, generated, vendor: r.rows[0] });
  } catch (e) { next(e); }
}

/* ─── POST /api/admin/vendors/:id/regenerate-key ───
 * Support rotates a seller's device key to a fresh long one on their behalf —
 * e.g. the key leaked, or a legacy short key needs upgrading. The vendor can
 * also do this from their own panel, but the admin is the escalation path when
 * they can't. Any phone bound with the OLD key is soft-unbound (their stored key
 * no longer matches, so they'd 401 anyway); the vendor re-enters the NEW key in
 * the app to reconnect. The new key is returned once — it's a secret.
 */
async function regenerateVendorDeviceKey(req, res, next) {
  const client = await pool.connect();
  try {
    if (!UUID_RE.test(String(req.params.id || ''))) {
      return res.status(404).json({ error: 'Vendor not found' });
    }
    await client.query('BEGIN');
    // Lock the vendor's account row. is_default = FALSE keeps this to real vendor
    // accounts — never the merchant's own Primary account.
    const a = await client.query(
      'SELECT id FROM accounts WHERE id = $1 AND is_default = FALSE FOR UPDATE',
      [req.params.id]
    );
    if (a.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Vendor not found' }); }
    const accountId = a.rows[0].id;

    // Mint a unique new key (retry on the astronomically rare UNIQUE collision).
    let newKey;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const candidate = generateDeviceAuthKey();
        await client.query('UPDATE accounts SET device_auth_key = $1 WHERE id = $2', [candidate, accountId]);
        newKey = candidate;
        break;
      } catch (e) {
        if (e.code === '23505' && attempt < 4) continue;
        throw e;
      }
    }

    // Old key no longer matches → phones bound with it would 401. Reflect that.
    const unbound = await client.query(
      `UPDATE devices SET unbound_at = NOW()
        WHERE account_id = $1 AND unbound_at IS NULL
        RETURNING id`,
      [accountId]
    );

    await client.query('COMMIT');
    res.json({ device_auth_key: newKey, disconnected: unbound.rowCount });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    next(e);
  } finally {
    client.release();
  }
}

/* ─── POST /api/admin/vendors/:id/onboard ───
 * Onboard a seller who never managed it themselves. Body:
 *   { username?, password?, activate?, book_revenue?, wallet_amount?, note? }
 *
 *   username      required only if the vendor has no login yet
 *   password      omit to generate one (returned once)
 *   activate      set activated_at, letting them add a payment number
 *   book_revenue  record the activation fee as platform revenue + merchant
 *                 commission. TRUE = "I collected the fee offline". FALSE =
 *                 "I waived it" — the money never appears in your income.
 *   wallet_amount positive credit so they can cover verification fees
 *
 * All-or-nothing: one transaction, so a vendor is never left half-onboarded.
 */
async function onboardVendor(req, res, next) {
  const client = await pool.connect();
  try {
    const v = await loadVendor(req.params.id);
    if (!v) return res.status(404).json({ error: 'Vendor not found' });

    const wantUsername = req.body.username != null ? String(req.body.username).trim().toLowerCase() : null;
    const activate = !!req.body.activate;
    const bookRevenue = !!req.body.book_revenue;
    const walletAmount = req.body.wallet_amount != null && String(req.body.wallet_amount) !== ''
      ? Number(req.body.wallet_amount) : 0;
    const note = String(req.body.note || '').slice(0, 500) || 'Onboarded by admin';

    // ── validate before touching anything (nothing below has run yet, and the
    //     finally block releases the pooled client on every path) ──
    if (!v.username && !wantUsername) {
      return res.status(400).json({ error: 'username is required — this vendor has no login yet' });
    }
    if (v.username && wantUsername && wantUsername !== v.username) {
      return res.status(409).json({
        error: `This vendor already has the login "${v.username}". Use Reset password to change their credentials.`,
        code: 'already_registered',
      });
    }
    if (wantUsername && !USERNAME_RE.test(wantUsername)) {
      return res.status(400).json({ error: 'Username must be 3–40 lowercase letters, numbers, or underscores' });
    }
    let password = req.body.password ? String(req.body.password) : null;
    const generated = !password;
    if (password && password.length < 6) {
      return res.status(400).json({ error: 'password must be at least 6 characters' });
    }
    if (walletAmount < 0 || !Number.isFinite(walletAmount)) {
      return res.status(400).json({ error: 'wallet_amount must be a positive number, or omitted' });
    }
    if (walletAmount > 10_000_000) {
      return res.status(400).json({ error: 'wallet_amount out of range' });
    }
    if (bookRevenue && !activate) {
      return res.status(400).json({ error: 'book_revenue only applies when activating' });
    }
    if (v.activated_at && activate) {
      return res.status(400).json({ error: 'This vendor is already activated.' });
    }

    const settings = await getPlatformSettings().catch(() => ({}));
    const fee = Number(settings.vendor_activation_fee || 0);

    await client.query('BEGIN');

    // Re-read under a row lock. `v` was loaded outside the transaction, so
    // between that read and here another admin may have claimed this vendor.
    // Without this, two concurrent onboards both pass the "no login yet" check,
    // the loser's UPDATE matches zero rows (WHERE username IS NULL no longer
    // holds), no error is raised — and we'd return HTTP 200 with a username and
    // password that were never stored. The seller would be handed dead credentials.
    const locked = await client.query(
      'SELECT username FROM accounts WHERE id = $1 AND is_default = FALSE FOR UPDATE',
      [v.id]
    );
    if (locked.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Vendor not found' });
    }
    const currentUsername = locked.rows[0].username;
    if (!v.username && currentUsername) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `This vendor already has the login "${currentUsername}". Use Reset password to change their credentials.`,
        code: 'already_registered',
      });
    }

    const isNewLogin = !currentUsername;
    if (isNewLogin) {
      if (!password) password = randomPassword();
      const hash = await bcrypt.hash(password, 10);
      let upd;
      try {
        upd = await client.query(
          `UPDATE accounts SET username = $2, password_hash = $3 WHERE id = $1 AND username IS NULL`,
          [v.id, wantUsername, hash]
        );
      } catch (e) {
        await client.query('ROLLBACK');
        if (e.code === '23505') {
          return res.status(409).json({
            error: `The username "${wantUsername}" is already taken. Vendor usernames are unique across every marketplace.`,
            code: 'username_taken',
          });
        }
        throw e;
      }
      // Belt and braces: the row lock above should make this impossible, but a
      // zero-row UPDATE must never be reported as success.
      if (upd.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'This vendor was claimed by someone else while you were onboarding. Reload and try again.',
          code: 'already_registered',
        });
      }
    } else if (password) {
      const hash = await bcrypt.hash(password, 10);
      await client.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [v.id, hash]);
    } else {
      password = null; // existing login, no password change requested
    }

    // Vendors are supposed to be born unlocked (services/vendors.js), but legacy
    // accounts created through the old dashboard path have keys_unlocked = FALSE.
    // gateway.controller → accountCanAddGateways refuses those, so an "activated"
    // vendor would still hit `403 Unlock this account before adding gateways` and
    // could never add a payment number. Onboarding means we intend them to trade.
    await client.query('UPDATE accounts SET keys_unlocked = TRUE WHERE id = $1 AND keys_unlocked = FALSE', [v.id]);

    let revenueBooked = 0;
    let merchantCommission = 0;
    if (activate) {
      await client.query('UPDATE accounts SET activated_at = NOW() WHERE id = $1 AND activated_at IS NULL', [v.id]);

      if (bookRevenue && fee > 0) {
        // Mirrors services/activation.js → settleForTransaction so an
        // admin-onboarded vendor books exactly like a self-paid one: the
        // marketplace earns its join commission, the platform keeps the rest.
        merchantCommission = computeMerchantCommission(settings, 'join', fee);
        if (merchantCommission > 0) {
          // No source transaction exists (the fee was collected offline), so
          // commission_account_id is the ONLY link back to the vendor here.
          await creditMerchantCommission(
            client, v.merchant_id, merchantCommission, null, 'Vendor joining commission (admin onboarding)',
            { type: 'join', accountId: v.id }
          );
        }
        revenueBooked = fee - merchantCommission;
        await recordPlatformRevenue(client, {
          type: 'vendor_activation',
          amount: revenueBooked,
          currency: settings.verify_charge_currency || 'BDT',
          merchantId: v.merchant_id,
          note: 'Vendor activation fee (collected offline, onboarded by admin)',
        });
      }
    }

    let balance = Number(v.wallet_balance);
    if (walletAmount > 0) {
      await client.query(
        `INSERT INTO wallet_ledger (merchant_id, account_id, amount, kind, note)
         VALUES ($1, $2, $3, 'adjustment', $4)`,
        [v.merchant_id, v.id, walletAmount, note]
      );
      const upd = await client.query(
        'UPDATE accounts SET wallet_balance = wallet_balance + $2 WHERE id = $1 RETURNING wallet_balance',
        [v.id, walletAmount]
      );
      balance = Number(upd.rows[0].wallet_balance);
    }

    await client.query('COMMIT');

    res.json({
      ok: true,
      vendor_id: v.id,
      label: v.label,
      username: wantUsername || v.username,
      password,                  // shown once; null when no password was set
      password_generated: isNewLogin && generated,
      activated: activate || v.activated_at != null,
      activation_fee: fee,
      revenue_booked: revenueBooked,
      merchant_commission: merchantCommission,
      wallet_balance: balance,
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    next(e);
  } finally {
    try { client.release(); } catch {}
  }
}

/* ─── POST /api/admin/vendors/:id/suspend   (admin JWT) ───
 * Body: { reason? }. A superadmin suspension outranks the merchant: it is
 * recorded as 'platform', so only a superadmin can later lift it.
 * merchantId = null → no ownership scoping (a superadmin can suspend anyone).
 */
async function suspendVendorAdmin(req, res, next) {
  try {
    const r = await suspendVendor(req.params.id, null, {
      by: 'platform',
      reason: req.body && req.body.reason,
    });
    if (r.notFound) return res.status(404).json({ error: 'Vendor not found' });
    res.json({ ok: true, vendor_id: req.params.id, already_suspended: !!r.alreadySuspended, ...suspensionOf(r.account) });
  } catch (e) { next(e); }
}

/* ─── POST /api/admin/vendors/:id/unsuspend   (admin JWT) ───
 * A superadmin can lift ANY suspension — merchant-applied or platform-applied.
 */
async function unsuspendVendorAdmin(req, res, next) {
  try {
    const r = await unsuspendVendor(req.params.id, null, { by: 'platform' });
    if (r.notFound)     return res.status(404).json({ error: 'Vendor not found' });
    if (r.notSuspended) return res.json({ ok: true, vendor_id: req.params.id, suspended: false, was_suspended: false });
    res.json({ ok: true, vendor_id: req.params.id, suspended: false });
  } catch (e) { next(e); }
}

module.exports = {
  getVendor, listVendors, onboardVendor, creditVendorWallet, resetVendorPassword, regenerateVendorDeviceKey,
  suspendVendorAdmin, unsuspendVendorAdmin,
};
