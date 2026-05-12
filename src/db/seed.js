const bcrypt = require('bcryptjs');
const pool = require('./pool');
require('dotenv').config();

async function seed() {
  const username = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
  const password = process.env.DEFAULT_ADMIN_PASSWORD || 'admin@123';

  const existing = await pool.query('SELECT id FROM admins WHERE username = $1', [username]);
  if (existing.rowCount > 0) {
    console.log(`Admin "${username}" already exists. Skipping seed.`);
    await pool.end();
    return;
  }

  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    'INSERT INTO admins (username, password_hash) VALUES ($1, $2)',
    [username, hash]
  );
  console.log(`Seeded default admin: ${username} / ${password}`);
  console.log('CHANGE THIS PASSWORD IN PRODUCTION.');
  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
