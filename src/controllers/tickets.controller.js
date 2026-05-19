const pool = require('../db/pool');

const STATUSES   = ['open', 'in_progress', 'resolved', 'closed'];
const PRIORITIES = ['low', 'normal', 'high'];

function clip(s, max) {
  return String(s || '').trim().slice(0, max);
}

async function nextTicketNumber() {
  const r = await pool.query(`SELECT nextval('support_ticket_number_seq')::bigint AS n`);
  return `TKT-${String(r.rows[0].n).padStart(6, '0')}`;
}

async function loadThread(ticketId) {
  const m = await pool.query(
    `SELECT id, author_type, author_id, body, created_at
       FROM support_ticket_messages
      WHERE ticket_id = $1
      ORDER BY created_at ASC`,
    [ticketId],
  );
  return m.rows;
}

/* ─────────────── MERCHANT ─────────────── */

async function merchantCreate(req, res, next) {
  try {
    const merchantId = req.merchant.id;
    const subject   = clip(req.body.subject, 200);
    const body      = clip(req.body.description, 4000);
    const priority  = PRIORITIES.includes(req.body.priority) ? req.body.priority : 'normal';

    if (!subject || !body) {
      return res.status(400).json({ error: 'Subject and description are required.' });
    }

    // Pull contact info from the merchant's profile (auto-fetched, not user input).
    const m = await pool.query(
      `SELECT id, name, email, mobile FROM merchants WHERE id = $1`,
      [merchantId],
    );
    if (m.rowCount === 0) return res.status(404).json({ error: 'Merchant not found.' });
    const merchant = m.rows[0];

    const number = await nextTicketNumber();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const t = await client.query(
        `INSERT INTO support_tickets
           (ticket_number, merchant_id, subject, status, priority, contact_email, contact_phone, last_reply_at, last_reply_by)
         VALUES ($1, $2, $3, 'open', $4, $5, $6, NOW(), 'merchant')
         RETURNING *`,
        [number, merchantId, subject, priority, merchant.email || null, merchant.mobile || null],
      );
      await client.query(
        `INSERT INTO support_ticket_messages (ticket_id, author_type, author_id, body)
         VALUES ($1, 'merchant', $2, $3)`,
        [t.rows[0].id, merchantId, body],
      );
      await client.query('COMMIT');
      const messages = await loadThread(t.rows[0].id);
      res.status(201).json({ ticket: t.rows[0], messages });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) { next(e); }
}

async function merchantList(req, res, next) {
  try {
    const merchantId = req.merchant.id;
    const r = await pool.query(
      `SELECT t.*,
              (SELECT COUNT(*)::int FROM support_ticket_messages m WHERE m.ticket_id = t.id) AS message_count
         FROM support_tickets t
        WHERE t.merchant_id = $1
        ORDER BY t.last_reply_at DESC NULLS LAST, t.created_at DESC`,
      [merchantId],
    );
    res.json({ tickets: r.rows });
  } catch (e) { next(e); }
}

async function merchantGet(req, res, next) {
  try {
    const merchantId = req.merchant.id;
    const t = await pool.query(
      `SELECT * FROM support_tickets WHERE id = $1 AND merchant_id = $2`,
      [req.params.id, merchantId],
    );
    if (t.rowCount === 0) return res.status(404).json({ error: 'Ticket not found.' });
    const messages = await loadThread(t.rows[0].id);
    res.json({ ticket: t.rows[0], messages });
  } catch (e) { next(e); }
}

async function merchantReply(req, res, next) {
  try {
    const merchantId = req.merchant.id;
    const body = clip(req.body.body, 4000);
    if (!body) return res.status(400).json({ error: 'Reply body is required.' });

    const t = await pool.query(
      `SELECT id, status FROM support_tickets WHERE id = $1 AND merchant_id = $2`,
      [req.params.id, merchantId],
    );
    if (t.rowCount === 0) return res.status(404).json({ error: 'Ticket not found.' });
    if (t.rows[0].status === 'closed') {
      return res.status(409).json({ error: 'This ticket is closed. Please open a new one.' });
    }

    await pool.query(
      `INSERT INTO support_ticket_messages (ticket_id, author_type, author_id, body)
       VALUES ($1, 'merchant', $2, $3)`,
      [t.rows[0].id, merchantId, body],
    );
    // Bumping a resolved ticket re-opens it.
    await pool.query(
      `UPDATE support_tickets
          SET last_reply_at = NOW(),
              last_reply_by = 'merchant',
              status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END,
              updated_at = NOW()
        WHERE id = $1`,
      [t.rows[0].id],
    );
    const fresh = await pool.query(`SELECT * FROM support_tickets WHERE id = $1`, [t.rows[0].id]);
    const messages = await loadThread(t.rows[0].id);
    res.status(201).json({ ticket: fresh.rows[0], messages });
  } catch (e) { next(e); }
}

/* ─────────────── ADMIN ─────────────── */

async function adminList(req, res, next) {
  try {
    const status   = STATUSES.includes(req.query.status) ? req.query.status : null;
    const priority = PRIORITIES.includes(req.query.priority) ? req.query.priority : null;
    const q        = (req.query.q || '').trim().slice(0, 100);
    const limit    = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset   = Math.max(0, parseInt(req.query.offset, 10) || 0);

    const wheres = [];
    const params = [];
    if (status)   { params.push(status);   wheres.push(`t.status = $${params.length}`); }
    if (priority) { params.push(priority); wheres.push(`t.priority = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      wheres.push(`(t.subject ILIKE $${params.length}
                    OR t.ticket_number ILIKE $${params.length}
                    OR m.name ILIKE $${params.length}
                    OR m.email ILIKE $${params.length})`);
    }
    const whereSql = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';

    const countSql = `SELECT COUNT(*)::int AS n
                        FROM support_tickets t
                        JOIN merchants m ON m.id = t.merchant_id
                        ${whereSql}`;
    const c = await pool.query(countSql, params);

    params.push(limit);  const limitIdx  = params.length;
    params.push(offset); const offsetIdx = params.length;

    const listSql = `SELECT t.*,
                            m.name AS merchant_name,
                            m.email AS merchant_email,
                            m.mobile AS merchant_mobile,
                            (SELECT COUNT(*)::int FROM support_ticket_messages mm WHERE mm.ticket_id = t.id) AS message_count
                       FROM support_tickets t
                       JOIN merchants m ON m.id = t.merchant_id
                       ${whereSql}
                      ORDER BY t.last_reply_at DESC NULLS LAST, t.created_at DESC
                      LIMIT $${limitIdx} OFFSET $${offsetIdx}`;
    const r = await pool.query(listSql, params);

    // Overall counts (independent of filters) for the nav badge / filter pills.
    const stats = await pool.query(
      `SELECT
         COUNT(*)::int                                     AS total,
         COUNT(*) FILTER (WHERE status = 'open')::int       AS open,
         COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
         COUNT(*) FILTER (WHERE status = 'resolved')::int   AS resolved,
         COUNT(*) FILTER (WHERE status = 'closed')::int     AS closed
       FROM support_tickets`,
    );

    res.json({
      tickets: r.rows,
      total:   c.rows[0].n,
      limit, offset,
      stats:   stats.rows[0],
    });
  } catch (e) { next(e); }
}

async function adminGet(req, res, next) {
  try {
    const t = await pool.query(
      `SELECT t.*, m.name AS merchant_name, m.email AS merchant_email, m.mobile AS merchant_mobile
         FROM support_tickets t
         JOIN merchants m ON m.id = t.merchant_id
        WHERE t.id = $1`,
      [req.params.id],
    );
    if (t.rowCount === 0) return res.status(404).json({ error: 'Ticket not found.' });
    const messages = await loadThread(t.rows[0].id);
    res.json({ ticket: t.rows[0], messages });
  } catch (e) { next(e); }
}

async function adminReply(req, res, next) {
  try {
    const body = clip(req.body.body, 4000);
    if (!body) return res.status(400).json({ error: 'Reply body is required.' });

    const t = await pool.query(
      `SELECT id, status FROM support_tickets WHERE id = $1`,
      [req.params.id],
    );
    if (t.rowCount === 0) return res.status(404).json({ error: 'Ticket not found.' });

    await pool.query(
      `INSERT INTO support_ticket_messages (ticket_id, author_type, body)
       VALUES ($1, 'admin', $2)`,
      [t.rows[0].id, body],
    );
    // When an admin replies, auto-flip 'open' to 'in_progress' so the queue stays meaningful.
    await pool.query(
      `UPDATE support_tickets
          SET last_reply_at = NOW(),
              last_reply_by = 'admin',
              status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END,
              updated_at = NOW()
        WHERE id = $1`,
      [t.rows[0].id],
    );
    const fresh = await pool.query(
      `SELECT t.*, m.name AS merchant_name, m.email AS merchant_email, m.mobile AS merchant_mobile
         FROM support_tickets t JOIN merchants m ON m.id = t.merchant_id
        WHERE t.id = $1`,
      [t.rows[0].id],
    );
    const messages = await loadThread(t.rows[0].id);
    res.status(201).json({ ticket: fresh.rows[0], messages });
  } catch (e) { next(e); }
}

async function adminUpdate(req, res, next) {
  try {
    const sets = [];
    const params = [];
    if (req.body.status && STATUSES.includes(req.body.status)) {
      params.push(req.body.status);
      sets.push(`status = $${params.length}`);
    }
    if (req.body.priority && PRIORITIES.includes(req.body.priority)) {
      params.push(req.body.priority);
      sets.push(`priority = $${params.length}`);
    }
    if (sets.length === 0) return res.status(400).json({ error: 'No valid fields to update.' });

    sets.push(`updated_at = NOW()`);
    params.push(req.params.id);

    const r = await pool.query(
      `UPDATE support_tickets SET ${sets.join(', ')}
        WHERE id = $${params.length}
        RETURNING *`,
      params,
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Ticket not found.' });
    res.json({ ticket: r.rows[0] });
  } catch (e) { next(e); }
}

module.exports = {
  merchantCreate, merchantList, merchantGet, merchantReply,
  adminList,      adminGet,     adminReply,  adminUpdate,
};
