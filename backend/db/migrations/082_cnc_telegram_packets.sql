-- 082_cnc_telegram_packets.sql
-- Structured, raw-free Telegram CNC packet projection for current-day cutting work.

BEGIN;

CREATE TABLE IF NOT EXISTS cnc_telegram_packets (
  packet_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_packet_key TEXT NOT NULL,
  source_chat_id TEXT NOT NULL,
  source_message_id BIGINT,
  source_thread_id BIGINT,
  source_version BIGINT NOT NULL DEFAULT 1,
  source_updated_at TIMESTAMPTZ,
  payload_hash TEXT NOT NULL,
  workday DATE NOT NULL DEFAULT CURRENT_DATE,
  machine TEXT,
  program_name TEXT,
  material_name TEXT NOT NULL DEFAULT 'МДФ 16мм',
  parse_status TEXT NOT NULL DEFAULT 'parsed',
  completion_status TEXT NOT NULL DEFAULT 'pending',
  thumbs_up BOOLEAN NOT NULL DEFAULT false,
  completed_at TIMESTAMPTZ,
  rework BOOLEAN NOT NULL DEFAULT false,
  comments_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  tools_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  doweling_links_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  analysis_warnings_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  ocr_engine TEXT,
  parser_version TEXT NOT NULL DEFAULT 'cnc-telegram-structured-v1',
  created_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  updated_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_cnc_telegram_packets_external_key UNIQUE (external_packet_key),
  CONSTRAINT chk_cnc_telegram_packets_source_version_positive
    CHECK (source_version > 0),
  CONSTRAINT chk_cnc_telegram_packets_parse_status
    CHECK (parse_status IN ('received', 'parsed', 'needs_review')),
  CONSTRAINT chk_cnc_telegram_packets_completion_status
    CHECK (completion_status IN ('pending', 'completed')),
  CONSTRAINT chk_cnc_telegram_packets_comments_array
    CHECK (jsonb_typeof(comments_json) = 'array'),
  CONSTRAINT chk_cnc_telegram_packets_tools_array
    CHECK (jsonb_typeof(tools_json) = 'array'),
  CONSTRAINT chk_cnc_telegram_packets_doweling_array
    CHECK (jsonb_typeof(doweling_links_json) = 'array'),
  CONSTRAINT chk_cnc_telegram_packets_warnings_array
    CHECK (jsonb_typeof(analysis_warnings_json) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_cnc_telegram_packets_workday_updated
  ON cnc_telegram_packets(workday DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_cnc_telegram_packets_status_workday
  ON cnc_telegram_packets(parse_status, completion_status, workday DESC);

CREATE INDEX IF NOT EXISTS idx_cnc_telegram_packets_source_chat_message
  ON cnc_telegram_packets(source_chat_id, source_message_id);

CREATE TABLE IF NOT EXISTS cnc_telegram_packet_items (
  packet_item_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  packet_id UUID NOT NULL REFERENCES cnc_telegram_packets(packet_id) ON DELETE CASCADE,
  source_item_key TEXT NOT NULL,
  order_name TEXT NOT NULL,
  detail_number INTEGER,
  width_mm NUMERIC(10, 2),
  height_mm NUMERIC(10, 2),
  quantity INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'ocr',
  confidence NUMERIC(5, 4) NOT NULL DEFAULT 0,
  match_order_id BIGINT REFERENCES orders(order_id) ON DELETE SET NULL,
  match_detail_id BIGINT REFERENCES order_details(detail_id) ON DELETE SET NULL,
  match_status TEXT NOT NULL DEFAULT 'unmatched',
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_cnc_telegram_packet_items_source_key UNIQUE (packet_id, source_item_key),
  CONSTRAINT chk_cnc_telegram_packet_items_detail_positive
    CHECK (detail_number IS NULL OR detail_number > 0),
  CONSTRAINT chk_cnc_telegram_packet_items_width_positive
    CHECK (width_mm IS NULL OR width_mm > 0),
  CONSTRAINT chk_cnc_telegram_packet_items_height_positive
    CHECK (height_mm IS NULL OR height_mm > 0),
  CONSTRAINT chk_cnc_telegram_packet_items_quantity_positive
    CHECK (quantity > 0),
  CONSTRAINT chk_cnc_telegram_packet_items_source
    CHECK (source IN ('ocr', 'gcode', 'manual')),
  CONSTRAINT chk_cnc_telegram_packet_items_confidence
    CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT chk_cnc_telegram_packet_items_match_status
    CHECK (match_status IN ('unmatched', 'matched', 'conflict', 'needs_review'))
);

CREATE INDEX IF NOT EXISTS idx_cnc_telegram_packet_items_packet
  ON cnc_telegram_packet_items(packet_id);

CREATE INDEX IF NOT EXISTS idx_cnc_telegram_packet_items_order_detail
  ON cnc_telegram_packet_items(order_name, detail_number);

CREATE INDEX IF NOT EXISTS idx_cnc_telegram_packet_items_match_order
  ON cnc_telegram_packet_items(match_order_id);

CREATE INDEX IF NOT EXISTS idx_cnc_telegram_packet_items_match_detail
  ON cnc_telegram_packet_items(match_detail_id);

COMMIT;
