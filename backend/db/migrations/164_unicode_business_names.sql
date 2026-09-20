BEGIN;

-- Business-visible project/group codes accept Unicode letters and numbers.
-- Keep protocol identifiers, uniqueness and existing length limits unchanged.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS chk_projects_code;
ALTER TABLE projects ADD CONSTRAINT chk_projects_code
  CHECK (code ~ '^[[:alnum:]-]{1,20}$');
ALTER TABLE group_groups DROP CONSTRAINT IF EXISTS chk_group_groups_code_format;
ALTER TABLE group_groups ADD CONSTRAINT chk_group_groups_code_format
  CHECK (code ~ '^[[:alnum:]][[:alnum:]_-]{1,63}$');

-- Projection keys originate from explicit packet order identities, not numeric substrings.
ALTER TABLE cnc_telegram_packet_whole_order_keys
  DROP CONSTRAINT IF EXISTS cnc_telegram_packet_whole_order_keys_order_key_check;
ALTER TABLE cnc_telegram_packet_whole_order_keys
  ADD CONSTRAINT cnc_telegram_packet_whole_order_keys_order_key_check
  CHECK (length(btrim(order_key)) BETWEEN 1 AND 200 AND order_key !~ '[[:cntrl:]]');

COMMIT;
