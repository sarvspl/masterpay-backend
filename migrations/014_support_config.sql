-- Singleton row holding the platform's support contact details.
-- Surfaced to merchants on the login page when their account is suspended.
CREATE TABLE IF NOT EXISTS support_config (
  id          SMALLINT PRIMARY KEY DEFAULT 1,
  email       TEXT,
  phone       TEXT,
  whatsapp    TEXT,
  hours       TEXT,
  message     TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT support_config_singleton CHECK (id = 1)
);

-- Seed the single row so callers can always UPDATE without checking existence.
INSERT INTO support_config (id, email, phone, message)
VALUES (1, 'support@payverify.com', NULL,
        'Need help with your account? Reach out to our support team.')
ON CONFLICT (id) DO NOTHING;
