-- Distinguish visible machine-file cards from internal packets that seed an
-- explicitly requested vacuum-bath card on the MDF board.

BEGIN;

ALTER TABLE cnc_telegram_packets
  ADD COLUMN IF NOT EXISTS mdf_board_card_kind TEXT NOT NULL DEFAULT 'machine_file';

ALTER TABLE cnc_telegram_packets
  DROP CONSTRAINT IF EXISTS chk_cnc_telegram_packets_mdf_board_card_kind;

ALTER TABLE cnc_telegram_packets
  ADD CONSTRAINT chk_cnc_telegram_packets_mdf_board_card_kind
  CHECK (mdf_board_card_kind IN ('machine_file', 'bath_seed'));

CREATE INDEX IF NOT EXISTS idx_cnc_telegram_packets_cut_job_card_kind
  ON cnc_telegram_packets(svg_cut_job_id, mdf_board_card_kind, workday DESC)
  WHERE mdf_board_hidden_at IS NULL;

-- Candidate-scoped bath lookup starts from the normalized order keys present
-- in the currently listed cut results instead of projecting all CNC history.
CREATE INDEX IF NOT EXISTS idx_cnc_telegram_packet_items_unmatched_order_key
  ON cnc_telegram_packet_items(lower(trim(order_name)), packet_id)
  WHERE match_order_id IS NULL AND match_detail_id IS NULL;

CREATE TABLE IF NOT EXISTS cnc_telegram_packet_whole_order_keys (
  packet_id UUID NOT NULL REFERENCES cnc_telegram_packets(packet_id) ON DELETE CASCADE,
  order_key TEXT NOT NULL CHECK (order_key ~ '^[0-9]{4,}$'),
  PRIMARY KEY (packet_id, order_key)
);

CREATE INDEX IF NOT EXISTS idx_cnc_telegram_packet_whole_order_keys_order
  ON cnc_telegram_packet_whole_order_keys(order_key, packet_id);

INSERT INTO cnc_telegram_packet_whole_order_keys (packet_id, order_key)
SELECT DISTINCT
  packet.packet_id,
  lower(trim(order_match.match[2])) AS order_key
FROM cnc_telegram_packets packet
CROSS JOIN LATERAL jsonb_array_elements_text(packet.comments_json) AS packet_comment(comment_text)
CROSS JOIN LATERAL regexp_matches(
  packet_comment.comment_text,
  '(^|[^0-9])([0-9]{4,})(?=[^0-9]|$)',
  'g'
) AS order_match(match)
WHERE lower(packet_comment.comment_text) LIKE '%весь%'
ON CONFLICT (packet_id, order_key) DO NOTHING;

COMMIT;
