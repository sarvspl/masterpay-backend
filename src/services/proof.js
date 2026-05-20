/**
 * Payment-proof screenshots uploaded by customers at checkout.
 *
 * Storage model: the image arrives as a base64 data URL in the submit body
 * (client downscales it first), we decode it to a file under uploads/proofs/
 * with a random UUID name, and store only the relative URL on the transaction
 * row. Files are served statically and auto-purged after 30 days.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pool = require('../db/pool');

const PROOF_DIR = path.join(__dirname, '..', '..', 'uploads', 'proofs');
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB hard cap (client compresses to ~200KB)
const TTL_DAYS  = 30;
const TTL_MS    = TTL_DAYS * 24 * 60 * 60 * 1000;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function ensureDir() {
  fs.mkdirSync(PROOF_DIR, { recursive: true });
}

/**
 * Decode + persist a base64 image data URL. Returns the relative public URL
 * (e.g. /uploads/proofs/<uuid>.jpg) or null when no image was supplied.
 * Throws an error with `.status` on invalid / oversized input.
 */
function saveProofImage(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(dataUrl.trim());
  if (!m) throw httpError(400, 'Screenshot must be a PNG, JPG or WebP image.');

  const fmt = m[1].toLowerCase();
  const ext = fmt === 'png' ? 'png' : fmt === 'webp' ? 'webp' : 'jpg';
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0)         throw httpError(400, 'Screenshot is empty.');
  if (buf.length > MAX_BYTES)   throw httpError(413, 'Screenshot is too large (max 5 MB).');

  ensureDir();
  const name = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(PROOF_DIR, name), buf);
  return `/uploads/proofs/${name}`;
}

/** Best-effort unlink of a single stored proof by its public URL. */
function deleteProofByUrl(url) {
  if (!url) return;
  try { fs.unlinkSync(path.join(PROOF_DIR, path.basename(url))); } catch { /* already gone */ }
}

/**
 * Purge proofs older than 30 days: null the DB references and delete the files,
 * then sweep any orphaned files by mtime as a safety net. Returns the count of
 * DB rows cleared.
 */
async function cleanupOldProofs() {
  const cutoff = new Date(Date.now() - TTL_MS);
  const r = await pool.query(
    `UPDATE transactions SET proof_image_url = NULL
      WHERE proof_image_url IS NOT NULL AND created_at < $1
      RETURNING proof_image_url`,
    [cutoff]
  );
  for (const row of r.rows) deleteProofByUrl(row.proof_image_url);

  // Orphan sweep: files on disk with no (or stale) DB reference.
  try {
    ensureDir();
    for (const f of fs.readdirSync(PROOF_DIR)) {
      const fp = path.join(PROOF_DIR, f);
      try {
        if (Date.now() - fs.statSync(fp).mtimeMs > TTL_MS) fs.unlinkSync(fp);
      } catch { /* ignore */ }
    }
  } catch { /* dir may not exist yet */ }

  return r.rowCount;
}

/** Run cleanup on boot, then once every 24h. */
function startProofCleanupJob() {
  const run = () =>
    cleanupOldProofs()
      .then((n) => { if (n) console.log(`[proofs] purged ${n} expired screenshot(s)`); })
      .catch((e) => console.warn('[proofs] cleanup failed:', e.message));
  run();
  const timer = setInterval(run, 24 * 60 * 60 * 1000);
  timer.unref?.();
}

module.exports = { PROOF_DIR, saveProofImage, deleteProofByUrl, cleanupOldProofs, startProofCleanupJob };
