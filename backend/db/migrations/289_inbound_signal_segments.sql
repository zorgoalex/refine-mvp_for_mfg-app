-- Incoming signals: several signals of one kind in one message (one per order).
-- A multi-line message ("Заказ 3087 готов ⏎ Заказ 3094 готов") or a line with several order numbers becomes one
-- occurrence per order. Each occurrence keeps the lines it came from (segment_text), the references of its group with
-- the order each led to at intake (group_references, re-checked by the worker before applying) and the fragment a user
-- without message_signals.resolve may see (visible_text: numbers of other orders masked).
-- Additive: rows of the old kind keep segment_index 0 and NULL segment columns (the whole message, as before).
BEGIN;

ALTER TABLE inbound_signal_occurrences
  ADD COLUMN IF NOT EXISTS segment_index integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS segment_text text,
  ADD COLUMN IF NOT EXISTS group_references jsonb,
  ADD COLUMN IF NOT EXISTS visible_text text;

ALTER TABLE inbound_signal_occurrences
  DROP CONSTRAINT IF EXISTS inbound_signal_occurrences_message_id_signal_code_key;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'inbound_signal_occurrences_message_signal_segment_key'
                    AND conrelid = 'inbound_signal_occurrences'::regclass) THEN
    ALTER TABLE inbound_signal_occurrences
      ADD CONSTRAINT inbound_signal_occurrences_message_signal_segment_key UNIQUE (message_id, signal_code, segment_index);
  END IF;
END $$;

COMMIT;
