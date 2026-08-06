-- 109_cnc_telegram_worker_audit_classification_codes.sql
-- Close Telegram message classification at the database boundary.

BEGIN;

ALTER TABLE cnc_telegram_worker_message_observations
  ADD CONSTRAINT chk_cnc_tg_worker_observation_classification_code CHECK (
    classification_code = ANY (ARRAY[
      'message_svg','message_dxf','message_image','message_gcode',
      'message_bot_reply','message_text','message_other'
    ]::TEXT[])
  ) NOT VALID;

ALTER TABLE cnc_telegram_worker_message_observations
  VALIDATE CONSTRAINT chk_cnc_tg_worker_observation_classification_code;

COMMIT;
