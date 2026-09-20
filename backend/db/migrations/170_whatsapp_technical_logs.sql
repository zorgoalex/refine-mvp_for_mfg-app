BEGIN;

CREATE TABLE IF NOT EXISTS whatsapp_technical_logs (
  technical_log_id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  component text NOT NULL CHECK (component IN ('backend','waha','webhook','relay','cleanup')),
  level text NOT NULL CHECK (level IN ('info','warn','error')),
  event_code text NOT NULL CHECK (event_code ~ '^[a-z0-9_.-]{1,100}$'),
  outcome text NOT NULL CHECK (outcome IN ('started','succeeded','failed','observed')),
  operation text CHECK (operation IS NULL OR char_length(operation) BETWEEN 1 AND 160),
  http_status integer CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 3600000),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,100}$'),
  error_message text CHECK (error_message IS NULL OR char_length(error_message) <= 500),
  request_id text CHECK (request_id IS NULL OR char_length(request_id) <= 200),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS whatsapp_technical_logs_time_idx
  ON whatsapp_technical_logs(occurred_at DESC, technical_log_id DESC);
CREATE INDEX IF NOT EXISTS whatsapp_technical_logs_error_idx
  ON whatsapp_technical_logs(level, occurred_at DESC)
  WHERE level IN ('warn','error');
CREATE INDEX IF NOT EXISTS whatsapp_technical_logs_event_idx
  ON whatsapp_technical_logs(event_code, occurred_at DESC);

COMMIT;
