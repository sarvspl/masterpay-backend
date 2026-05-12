-- Add email to merchants (idempotent).
-- Safe to run when merchants is empty; if data exists, fill emails first.

ALTER TABLE merchants ADD COLUMN IF NOT EXISTS email VARCHAR(255);

UPDATE merchants SET email = username || '@unset.local' WHERE email IS NULL;

ALTER TABLE merchants ALTER COLUMN email SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS merchants_email_unique ON merchants(LOWER(email));
CREATE INDEX        IF NOT EXISTS idx_merchants_email     ON merchants(email);
