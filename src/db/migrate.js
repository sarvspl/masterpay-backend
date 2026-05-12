const fs = require('fs');
const path = require('path');
const pool = require('./pool');
const { currencyForCountry } = require('../utils/currency');

async function ensureTrackingTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        VARCHAR(255) PRIMARY KEY,
      applied_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
}

/**
 * Bootstrap: if _migrations is empty but the schema clearly shows that
 * earlier migrations have already been applied, mark them as applied so
 * they don't run again (and break against the current schema state).
 */
async function bootstrapApplied() {
  const { rows } = await pool.query('SELECT 1 FROM _migrations LIMIT 1');
  if (rows.length > 0) return; // tracking already populated

  const check = async (sql, params = []) => {
    const r = await pool.query(sql, params);
    return r.rowCount > 0;
  };

  const has = {
    merchantsEmail: await check(`SELECT 1 FROM information_schema.columns WHERE table_name='merchants' AND column_name='email'`),
    brandsTable:    await check(`SELECT 1 FROM information_schema.tables WHERE table_name='brands'`),
    merchantsTable: await check(`SELECT 1 FROM information_schema.tables WHERE table_name='merchants'`),
  };

  const seeded = [];
  if (has.merchantsTable) seeded.push('001_init.sql');
  if (has.merchantsEmail) seeded.push('002_add_email.sql');
  if (has.brandsTable)    seeded.push('003_brands.sql');

  for (const name of seeded) {
    await pool.query('INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
    console.log(`Bootstrapped as already-applied: ${name}`);
  }
}

async function migrate() {
  await ensureTrackingTable();
  await bootstrapApplied();

  const dir = path.join(__dirname, '..', '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  const { rows } = await pool.query('SELECT name FROM _migrations');
  const applied = new Set(rows.map((r) => r.name));

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`✓ ${file} (already applied)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log(`▸ Running: ${file}`);
    await pool.query(sql);
    await pool.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);

    // After 007 (currency column), backfill currency from country for existing rows.
    if (file === '007_merchant_currency.sql') {
      const { rows } = await pool.query(`SELECT id, country FROM merchants WHERE currency = 'USD'`);
      let updated = 0;
      for (const r of rows) {
        const cur = currencyForCountry(r.country);
        if (cur !== 'USD') {
          await pool.query('UPDATE merchants SET currency = $1 WHERE id = $2', [cur, r.id]);
          updated++;
        }
      }
      if (rows.length > 0) console.log(`   Backfilled currency on ${updated}/${rows.length} merchant(s).`);
    }

    ran += 1;
  }
  console.log(ran === 0 ? 'No new migrations.' : `Applied ${ran} migration(s).`);
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
