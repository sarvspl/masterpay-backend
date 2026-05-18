-- Upay only supports Personal accounts in this phase. Agent comes later.
UPDATE providers
   SET variants = '["personal"]'::jsonb, updated_at = NOW()
 WHERE id = 'upay';
