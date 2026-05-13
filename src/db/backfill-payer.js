/**
 * One-shot backfill: extracts payer_name + payer_phone from `matched_sms`
 * on every existing transaction that doesn't already have them.
 *
 * Safe to re-run — it only touches rows where both payer fields are still NULL.
 */
require('dotenv').config();
const pool = require('./pool');
const { extractPayer } = require('../controllers/sms.controller');

async function backfill() {
  const { rows } = await pool.query(
    `SELECT id, matched_sms
       FROM transactions
      WHERE matched_sms IS NOT NULL
        AND payer_name IS NULL
        AND payer_phone IS NULL`
  );

  if (rows.length === 0) {
    console.log('Nothing to backfill. All transactions already have payer info (or none have matched_sms).');
    await pool.end();
    return;
  }

  console.log(`Scanning ${rows.length} transaction(s)…`);
  let updated = 0;
  let skipped = 0;

  for (const t of rows) {
    const payer = extractPayer(t.matched_sms);
    if (!payer.name && !payer.phone) {
      skipped += 1;
      continue;
    }
    await pool.query(
      `UPDATE transactions
          SET payer_name  = $2,
              payer_phone = $3,
              updated_at  = NOW()
        WHERE id = $1`,
      [t.id, payer.name, payer.phone]
    );
    updated += 1;
  }

  console.log(`✓ Updated ${updated} transaction(s).`);
  console.log(`  Skipped ${skipped} (SMS format didn't match any known payer pattern).`);
  await pool.end();
}

backfill().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
