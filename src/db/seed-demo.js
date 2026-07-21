/**
 * Seeds one Bangladesh merchant and one vendor under it, for manual testing.
 *
 *   npm run seed:demo
 *
 * IDEMPOTENT AND NON-DESTRUCTIVE. Everything is keyed on the fixed usernames
 * below and upserted, so re-running refreshes those two accounts and touches
 * nothing else. It never truncates, and it never deletes a row it did not
 * create — this is expected to be run against a database that already has real
 * data in it.
 *
 * Refuses to run when NODE_ENV=production. Seeded logins have known passwords;
 * creating them on a live system hands anyone who reads this file an account.
 *
 * What it creates:
 *   merchant  demo_bd_merchant / Demo@1234   (Bangladesh, BDT)
 *     ├─ merchant_keys + default brand (api_key for server integration)
 *     ├─ Primary account, keys unlocked
 *     └─ vendor "Demo BD Vendor"  demo_bd_vendor / Demo@1234
 *          ├─ activated, so it can take payments immediately
 *          └─ one bKash Personal gateway
 *
 * It also makes sure the PLATFORM merchant has a bKash gateway, because
 * "Add balance" sends the merchant to a checkout that pays INTO the platform —
 * without one, wallet top-up returns 503 and the flow can't be tested at all.
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./pool');
const { generateApiKey, generateSecretKey, generateDeviceAuthKey } = require('../utils/keys');

const PASSWORD = process.env.SEED_DEMO_PASSWORD || 'Demo@1234';

const MERCHANT = {
  username: 'demo_bd_merchant',
  name:     'Demo BD Marketplace',
  email:    'demo.bd.merchant@example.com',
  mobile:   '01711000001',
  domain:   'demo-bd.example.com',
  industry: 'Retail',
  country:  'Bangladesh',
  state:    'Dhaka',
  currency: 'BDT',
};

const VENDOR = {
  username: 'demo_bd_vendor',
  label:    'Demo BD Vendor',
  external: 'demo-bd-vendor-1',
  // The number the vendor receives payments on. Must be what appears in the
  // wallet's confirmation SMS, or nothing will ever match against it.
  bkash:    '01711000002',
};

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to seed demo accounts with NODE_ENV=production.');
    console.error('These logins have a known password. Unset NODE_ENV or use a non-production database.');
    process.exit(1);
  }

  const hash = await bcrypt.hash(PASSWORD, 10);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    /* ── merchant ────────────────────────────────────────────────────────── */
    // ON CONFLICT on username so a re-run refreshes rather than 23505s. The
    // password is reset each time, which is the point: it's a test login.
    const m = await client.query(
      `INSERT INTO merchants (name, username, password_hash, mobile, email, domain, industry, country, state, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (username) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             country       = EXCLUDED.country,
             currency      = EXCLUDED.currency
       RETURNING id, name, username, country, currency, wallet_balance`,
      [MERCHANT.name, MERCHANT.username, hash, MERCHANT.mobile, MERCHANT.email,
       MERCHANT.domain, MERCHANT.industry, MERCHANT.country, MERCHANT.state, MERCHANT.currency]
    );
    const merchant = m.rows[0];

    // Device auth key. Kept if one already exists — regenerating would unbind
    // any phone already paired against it.
    const existingKey = await client.query(
      'SELECT device_auth_key FROM merchant_keys WHERE merchant_id = $1', [merchant.id]
    );
    const merchantKey = existingKey.rows[0]?.device_auth_key || generateDeviceAuthKey();
    await client.query(
      `INSERT INTO merchant_keys (merchant_id, device_auth_key) VALUES ($1,$2)
       ON CONFLICT (merchant_id) DO NOTHING`,
      [merchant.id, merchantKey]
    );

    // Default brand — carries the api_key a storefront integrates with.
    const existingBrand = await client.query(
      'SELECT id, api_key FROM brands WHERE merchant_id = $1 AND is_default = TRUE', [merchant.id]
    );
    let brand = existingBrand.rows[0];
    if (!brand) {
      const b = await client.query(
        `INSERT INTO brands (merchant_id, name, domain, api_key, secret_key, is_default)
         VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING id, api_key`,
        [merchant.id, MERCHANT.name, MERCHANT.domain, generateApiKey(), generateSecretKey()]
      );
      brand = b.rows[0];
    }

    // Primary account. Unlocked so the merchant isn't stuck behind the
    // one-time key-unlock fee while testing.
    await client.query(
      `INSERT INTO accounts (merchant_id, label, device_auth_key, keys_unlocked, is_default)
       VALUES ($1,'Primary',$2,TRUE,TRUE)
       ON CONFLICT DO NOTHING`,
      [merchant.id, merchantKey]
    );
    await client.query(
      `UPDATE accounts SET keys_unlocked = TRUE WHERE merchant_id = $1 AND is_default = TRUE`,
      [merchant.id]
    );

    /* ── vendor ──────────────────────────────────────────────────────────── */
    const existingVendor = await client.query(
      `SELECT id, device_auth_key FROM accounts
        WHERE merchant_id = $1 AND is_default = FALSE AND external_id = $2`,
      [merchant.id, VENDOR.external]
    );

    let vendor;
    if (existingVendor.rowCount > 0) {
      const v = await client.query(
        `UPDATE accounts
            SET username = $2, password_hash = $3, keys_unlocked = TRUE,
                activated_at = COALESCE(activated_at, NOW())
          WHERE id = $1
          RETURNING id, label, device_auth_key, wallet_balance`,
        [existingVendor.rows[0].id, VENDOR.username, hash]
      );
      vendor = v.rows[0];
    } else {
      const v = await client.query(
        `INSERT INTO accounts
           (merchant_id, label, device_auth_key, keys_unlocked, is_default, external_id,
            username, password_hash, activated_at)
         VALUES ($1,$2,$3,TRUE,FALSE,$4,$5,$6,NOW())
         RETURNING id, label, device_auth_key, wallet_balance`,
        [merchant.id, VENDOR.label, generateDeviceAuthKey(), VENDOR.external, VENDOR.username, hash]
      );
      vendor = v.rows[0];
    }

    // A vendor with no gateway is reported unavailable and can't be paid, so
    // give it one. bKash Personal — a BD vendor's normal rail.
    await client.query(
      `INSERT INTO gateways (merchant_id, account_id, provider, variant, account_number, label, is_enabled)
       VALUES ($1,$2,'bkash','personal',$3,'Demo bKash',TRUE)
       ON CONFLICT (account_id, provider, variant) DO UPDATE
         SET account_number = EXCLUDED.account_number, is_enabled = TRUE`,
      [merchant.id, vendor.id, VENDOR.bkash]
    );

    /* ── platform receiving gateway ──────────────────────────────────────── */
    // "Add balance" opens a checkout that pays INTO the platform merchant.
    // startRecharge() returns 503 when it has no enabled gateway, so without
    // this the top-up flow cannot be tested at all.
    const platform = await client.query('SELECT id FROM merchants WHERE is_platform = TRUE LIMIT 1');
    let platformNote = 'no platform merchant found — run migrations first';
    if (platform.rowCount > 0) {
      const pAcc = await client.query(
        'SELECT id FROM accounts WHERE merchant_id = $1 AND is_default = TRUE LIMIT 1',
        [platform.rows[0].id]
      );
      if (pAcc.rowCount > 0) {
        const before = await client.query(
          `SELECT COUNT(*)::int n FROM gateways WHERE merchant_id = $1 AND is_enabled = TRUE`,
          [platform.rows[0].id]
        );
        await client.query(
          `INSERT INTO gateways (merchant_id, account_id, provider, variant, account_number, label, is_enabled)
           VALUES ($1,$2,'bkash','personal','01799000001','Platform bKash',TRUE)
           ON CONFLICT (account_id, provider, variant) DO UPDATE SET is_enabled = TRUE`,
          [platform.rows[0].id, pAcc.rows[0].id]
        );
        platformNote = before.rows[0].n > 0
          ? `already had ${before.rows[0].n} enabled gateway(s); ensured a bKash one exists`
          : 'added a bKash gateway (it had none — top-up would have 503\'d)';
      }
    }

    await client.query('COMMIT');

    const line = (k, v) => console.log(`  ${k.padEnd(18)} ${v}`);
    console.log('\nSeeded Bangladesh demo data.\n');
    console.log('MERCHANT — sign in at /login');
    line('username', MERCHANT.username);
    line('password', PASSWORD);
    line('country', `${merchant.country} (${merchant.currency})`);
    line('wallet', `${merchant.currency} ${Number(merchant.wallet_balance).toFixed(2)}`);
    line('api_key', brand.api_key);
    console.log('\nVENDOR — sign in at /vendor/login');
    line('username', VENDOR.username);
    line('password', PASSWORD);
    line('label', vendor.label);
    line('gateway', `bKash Personal · ${VENDOR.bkash}`);
    line('device key', vendor.device_auth_key.slice(0, 16) + `… (${vendor.device_auth_key.length} chars)`);
    console.log('\nPLATFORM');
    line('receiving', platformNote);
    console.log('\nTo test: sign in as the merchant → Wallet → Add Balance.\n');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Demo seed failed:', err.message);
  process.exit(1);
});
