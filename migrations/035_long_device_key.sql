-- C4 follow-up: device auth keys are now 350+ characters (far longer than the
-- old VARCHAR(40/80) ceilings). Widen every column that stores the key to TEXT
-- so long keys aren't rejected or truncated. Both columns are still written:
--   - accounts.device_auth_key      — the active key each account authenticates with
--   - merchant_keys.device_auth_key — legacy table, still populated on register
-- UNIQUE constraints/indexes are rebuilt automatically by the TYPE change; a
-- ~350-byte value is well under Postgres's btree index limit (~2704 bytes).
ALTER TABLE accounts      ALTER COLUMN device_auth_key TYPE TEXT;
ALTER TABLE merchant_keys ALTER COLUMN device_auth_key TYPE TEXT;
