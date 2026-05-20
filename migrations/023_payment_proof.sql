-- Customer-supplied payment proof captured at checkout:
--   sender_account  — the mobile/account number the customer says they paid FROM
--                     (a claim; kept separate from payer_phone, which is parsed
--                      from the matched SMS).
--   proof_image_url — relative path to the uploaded screenshot, e.g.
--                     /uploads/proofs/<uuid>.jpg. Files are auto-purged after
--                     30 days; this column is nulled by the same cleanup job.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS sender_account  VARCHAR(40),
  ADD COLUMN IF NOT EXISTS proof_image_url TEXT;
