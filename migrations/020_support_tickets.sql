-- Merchant-raised support tickets + their message threads.
-- A merchant creates a ticket (subject, description, contact email/phone).
-- Admins reply from /console/tickets; both parties see the same thread.

CREATE SEQUENCE IF NOT EXISTS support_ticket_number_seq START 1001;

CREATE TABLE IF NOT EXISTS support_tickets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number  TEXT UNIQUE NOT NULL,                 -- e.g., 'TKT-001001'
  merchant_id    UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  subject        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','in_progress','resolved','closed')),
  priority       TEXT NOT NULL DEFAULT 'normal'
                   CHECK (priority IN ('low','normal','high')),
  contact_email  TEXT,
  contact_phone  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_reply_at  TIMESTAMPTZ,
  last_reply_by  TEXT                                   -- 'merchant' | 'admin'
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_merchant ON support_tickets(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status   ON support_tickets(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_number   ON support_tickets(ticket_number);

CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id    UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_type  TEXT NOT NULL CHECK (author_type IN ('merchant','admin')),
  author_id    UUID,                                   -- nullable; refers to merchants.id or NULL for admin
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_ticket ON support_ticket_messages(ticket_id, created_at);
