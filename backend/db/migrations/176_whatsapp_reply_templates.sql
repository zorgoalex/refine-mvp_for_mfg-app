BEGIN;
ALTER TABLE whatsapp_webhook_events DROP CONSTRAINT whatsapp_webhook_events_result_code_check;
ALTER TABLE whatsapp_webhook_events ADD CONSTRAINT whatsapp_webhook_events_result_code_check
  CHECK (result_code IN ('ignored','unmatched','queued','failed'));
ALTER TABLE whatsapp_message_templates ADD COLUMN body_mode text NOT NULL DEFAULT 'text'
  CHECK (body_mode IN ('text','template'));
ALTER TABLE whatsapp_keyword_rules DROP CONSTRAINT whatsapp_keyword_rules_match_mode_check;
ALTER TABLE whatsapp_keyword_rules ADD CONSTRAINT whatsapp_keyword_rules_match_mode_check
  CHECK (match_mode IN ('contains_any','exact_any','pattern_exact','pattern_contains'));
ALTER TABLE whatsapp_keyword_rules ADD COLUMN reply_mode text NOT NULL DEFAULT 'plain' CHECK (reply_mode IN ('plain','quote'));
ALTER TABLE whatsapp_keyword_rules ADD COLUMN counter_value bigint NOT NULL DEFAULT 0 CHECK (counter_value >= 0);
ALTER TABLE whatsapp_delivery_jobs ADD COLUMN reply_mode text NOT NULL DEFAULT 'plain' CHECK (reply_mode IN ('plain','quote'));
ALTER TABLE whatsapp_delivery_jobs ADD COLUMN reply_to text CHECK (char_length(reply_to) BETWEEN 1 AND 255);
ALTER TABLE whatsapp_delivery_jobs ADD COLUMN rendered_at timestamptz;
ALTER TABLE whatsapp_delivery_jobs ADD COLUMN counter_value bigint CHECK (counter_value > 0);
COMMIT;
