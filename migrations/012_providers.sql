CREATE TABLE IF NOT EXISTS providers (
  id          VARCHAR(40)  PRIMARY KEY,            -- slug, e.g. 'bkash', 'upay'
  name        VARCHAR(80)  NOT NULL,               -- display, e.g. 'bKash', 'Upay'
  initials    VARCHAR(8)   NOT NULL,               -- badge initials, e.g. 'bK'
  color       VARCHAR(40)  NOT NULL DEFAULT 'slate',-- palette key (pink, orange, ...)
  variants    JSONB        NOT NULL DEFAULT '[]'::jsonb,  -- ["personal","agent"]
  is_enabled  BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed with existing + Upay
INSERT INTO providers (id, name, initials, color, variants) VALUES
  ('bkash',  'bKash',  'bK', 'pink',   '["personal","agent"]'::jsonb),
  ('nagad',  'Nagad',  'Na', 'orange', '["personal","agent"]'::jsonb),
  ('rocket', 'Rocket', 'Ro', 'purple', '["personal","agent"]'::jsonb),
  ('upay',   'Upay',   'Up', 'blue',   '["personal","agent"]'::jsonb)
ON CONFLICT (id) DO NOTHING;