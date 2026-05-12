const pool = require('../db/pool');

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'user';
}

async function generateUniqueUsername(name) {
  const base = slugify(name);
  let candidate = base;
  let attempt = 0;

  while (attempt < 50) {
    const { rowCount } = await pool.query(
      'SELECT 1 FROM merchants WHERE username = $1',
      [candidate]
    );
    if (rowCount === 0) return candidate;
    attempt += 1;
    const suffix = Math.floor(1000 + Math.random() * 9000);
    candidate = `${base}_${suffix}`;
  }
  throw new Error('Could not generate unique username');
}

module.exports = { slugify, generateUniqueUsername };
