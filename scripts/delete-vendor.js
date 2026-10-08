/**
 * PERMANENTLY delete one vendor (a non-primary account) and everything tied to it.
 *
 *   node scripts/delete-vendor.js <vendor-account-id>            dry run: shows what would go
 *   node scripts/delete-vendor.js <vendor-account-id> --confirm  actually deletes
 *
 * There is deliberately no UI for this: transactions.gateway_id is ON DELETE
 * RESTRICT so a vendor that has taken payments keeps its history. This script
 * removes that history on purpose. Take a database backup first.
 *
 * Removed:
 *   - transactions paid to the vendor's gateways (sms_messages.matched_tx_id -> NULL)
 *   - payment_sessions routed to the vendor that no longer have any transaction
 *   - the account row, which cascades to gateways, devices, the vendor's own
 *     wallet_ledger rows and vendor_transfers
 * Untouched:
 *   - the merchant and its wallet balance (commission ledger rows that point at
 *     the deleted transactions stay, so merchant/platform totals do not change)
 *   - rows that merely referenced the vendor via ON DELETE SET NULL columns
 *
 * Runs in one DB transaction: any error rolls everything back.
 */
const pool = require('../src/db/pool');

async function main() {
  const id = process.argv[2];
  const confirm = process.argv.includes('--confirm');
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    console.error('Usage: node scripts/delete-vendor.js <vendor-account-id> [--confirm]');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const acc = await client.query(
      `SELECT a.id, a.label, a.username, a.external_id, a.is_default, a.wallet_balance, m.name AS merchant
         FROM accounts a JOIN merchants m ON m.id = a.merchant_id
        WHERE a.id = $1 FOR UPDATE OF a`,
      [id]
    );
    if (acc.rowCount === 0) throw new Error('No account with that id.');
    const a = acc.rows[0];
    if (a.is_default) throw new Error('That is a merchant PRIMARY account, not a vendor. Refusing.');

    const counts = (await client.query(
      `SELECT
         (SELECT COUNT(*) FROM gateways WHERE account_id = $1)::int                                   AS gateways,
         (SELECT COUNT(*) FROM devices  WHERE account_id = $1)::int                                   AS devices,
         (SELECT COUNT(*) FROM transactions t JOIN gateways g ON g.id = t.gateway_id
            WHERE g.account_id = $1)::int                                                             AS transactions,
         (SELECT COUNT(*) FROM wallet_ledger WHERE account_id = $1)::int                              AS ledger_rows,
         (SELECT COUNT(*) FROM payment_sessions WHERE account_id = $1)::int                           AS sessions`,
      [id]
    )).rows[0];

    console.log(`Vendor:   ${a.label || a.username} (@${a.username || '-'}, ${a.external_id || 'no seller id'})`);
    console.log(`Merchant: ${a.merchant}`);
    console.log(`Wallet:   ${a.wallet_balance} (lost with the account)`);
    console.table(counts);

    if (!confirm) {
      await client.query('ROLLBACK');
      console.log('\nDry run only. Nothing deleted. Re-run with --confirm to delete.');
      return;
    }

    const tx = await client.query(
      `DELETE FROM transactions
        WHERE gateway_id IN (SELECT id FROM gateways WHERE account_id = $1)`,
      [id]
    );
    const ss = await client.query(
      `DELETE FROM payment_sessions s
        WHERE s.account_id = $1
          AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.session_id = s.id)`,
      [id]
    );
    await client.query('DELETE FROM accounts WHERE id = $1 AND is_default = FALSE', [id]);

    await client.query('COMMIT');
    console.log(`\nDeleted: ${tx.rowCount} transactions, ${ss.rowCount} sessions, the account and its gateways/devices/ledger.`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Aborted, nothing changed:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
