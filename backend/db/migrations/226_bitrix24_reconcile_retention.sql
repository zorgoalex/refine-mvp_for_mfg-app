-- Retention of the Bitrix24 payment reconcile trail (owner decision 2026-10-01): keep every
-- reconcile record for 7 days; older than that keep only the records where something changed.
-- The scheduled reconcile walks every deal about ten times a day and writes one audit_log row and
-- one bitrix24_inbound_event row per deal even when nothing changed (~50k rows a day in each).
--
-- prune_bitrix24_reconcile_noise(cutoff, batch) is the single definition of what may be removed;
-- the backend scheduler calls it periodically and this migration calls it for everything
-- accumulated so far. A reconcile record older than the cutoff is kept when
--   * its writer marked it (metadata_json.changed = true), or
--   * its after_json differs from the previous record of the same object (the first record of an
--     object is its baseline).
-- So the kept records are the marked ones plus every point where the recorded state differs from
-- the record before it. A removed record always has the same after_json as its predecessor,
-- which makes the verdict of every other record independent of the removal: batched, repeated
-- and resumed runs converge to the same set as a single pass, for any mix of marked and unmarked
-- records.
--
-- DELETE does not return disk space: the dump shrinks at once, the table files only after an
-- operator-run VACUUM FULL.
BEGIN;

-- cad_events references audit_log without an index; every audit_log delete probes it.
CREATE INDEX IF NOT EXISTS idx_cad_events_audit_id
  ON public.cad_events (audit_id)
  WHERE audit_id IS NOT NULL;

-- The pruning candidates of the queue, oldest first: without it every run reads the whole table,
-- which stays physically large after the one-time cleanup until an operator runs VACUUM FULL.
CREATE INDEX IF NOT EXISTS idx_bitrix24_inbound_event_reconcile_processed
  ON public.bitrix24_inbound_event (processed_at, inbound_event_id)
  WHERE event_name = 'BITRIX24_RECONCILE_DEAL' AND status = 'processed';

CREATE OR REPLACE FUNCTION public.prune_bitrix24_reconcile_noise(
  p_cutoff TIMESTAMPTZ,
  p_batch INTEGER
)
RETURNS TABLE (audit_deleted BIGINT, inbound_deleted BIGINT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_audit BIGINT;
  v_inbound BIGINT;
BEGIN
  IF p_cutoff IS NULL THEN
    RAISE EXCEPTION 'prune_bitrix24_reconcile_noise: cutoff is required';
  END IF;
  IF p_batch IS NOT NULL AND p_batch <= 0 THEN
    RAISE EXCEPTION 'prune_bitrix24_reconcile_noise: batch must be positive';
  END IF;

  -- Only records older than the cutoff are classified: the predecessor of such a record is older
  -- still, so the last 7 days never enter the window and a periodic run stays cheap.
  WITH classified AS (
    SELECT a.audit_id,
           a.created_at,
           COALESCE(a.metadata_json -> 'changed' = 'true'::jsonb, false)
             OR a.after_json IS DISTINCT FROM lag(a.after_json) OVER (
               PARTITION BY a.event, a.entity_id
               ORDER BY a.created_at, a.audit_id
             ) AS keep
      FROM public.audit_log a
     WHERE a.event IN (
       'bitrix24_reverse.order_payments_reconcile',
       'bitrix24_reverse.request_payments_reconcile'
     )
       AND a.created_at < p_cutoff
  ),
  doomed AS (
    SELECT c.audit_id
      FROM classified c
     WHERE NOT c.keep
       AND NOT EXISTS (SELECT 1 FROM public.cad_events ce WHERE ce.audit_id = c.audit_id)
       AND NOT EXISTS (SELECT 1 FROM public.onec_audit_links l WHERE l.audit_id = c.audit_id)
     ORDER BY c.created_at, c.audit_id
     LIMIT p_batch
  ),
  deleted AS (
    DELETE FROM public.audit_log a
     USING doomed d
     WHERE a.audit_id = d.audit_id
    RETURNING 1
  )
  SELECT count(*) INTO v_audit FROM deleted;

  -- A queue event stays while any audit row still points at it (request_id = inbound_event_id),
  -- so a kept record can always be traced back to the event that produced it.
  WITH doomed AS (
    SELECT e.inbound_event_id
      FROM public.bitrix24_inbound_event e
     WHERE e.event_name = 'BITRIX24_RECONCILE_DEAL'
       AND e.payload_json ->> 'source' = 'scheduled-reconcile'
       AND e.status = 'processed'
       AND e.processed_at < p_cutoff
       AND NOT EXISTS (
         SELECT 1 FROM public.audit_log a WHERE a.request_id = e.inbound_event_id::text
       )
     ORDER BY e.processed_at, e.inbound_event_id
     LIMIT p_batch
  ),
  deleted AS (
    DELETE FROM public.bitrix24_inbound_event e
     USING doomed d
     WHERE e.inbound_event_id = d.inbound_event_id
    RETURNING 1
  )
  SELECT count(*) INTO v_inbound FROM deleted;

  RETURN QUERY SELECT v_audit, v_inbound;
END;
$$;

COMMENT ON FUNCTION public.prune_bitrix24_reconcile_noise(TIMESTAMPTZ, INTEGER) IS
  'Удаляет записи сверки Bitrix24 старше cutoff, в которых ничего не изменилось: строки audit_log двух событий сверки и обработанные события плановой сверки без оставшегося аудита';

COMMIT;

-- One-time cleanup of everything accumulated before the scheduler took over. Each batch commits
-- together with its own audit row (this block runs outside a transaction), so an interrupted run
-- leaves every committed removal audited and a rerun of the migration resumes where it stopped.
-- The 'migration:226' row marks completion and is written once the backlog is gone.
DO $$
DECLARE
  v_cutoff CONSTANT TIMESTAMPTZ := now() - interval '7 days';
  v_batch CONSTANT INTEGER := 200000;
  v_run_id CONSTANT UUID := gen_random_uuid();
  v_batch_no INTEGER := 0;
  v_audit BIGINT := 0;
  v_inbound BIGINT := 0;
  v_batch_audit BIGINT;
  v_batch_inbound BIGINT;
BEGIN
  LOOP
    SELECT audit_deleted, inbound_deleted
      INTO v_batch_audit, v_batch_inbound
      FROM public.prune_bitrix24_reconcile_noise(v_cutoff, v_batch);
    v_batch_no := v_batch_no + 1;
    v_audit := v_audit + v_batch_audit;
    v_inbound := v_inbound + v_batch_inbound;
    IF v_batch_audit + v_batch_inbound > 0 THEN
      INSERT INTO public.audit_log (
        event, entity_type, entity_id, request_id, source, metadata_json
      )
      VALUES (
        'bitrix24_reverse.reconcile_retention_pruned',
        'audit_retention',
        'bitrix24_reconcile',
        format('migration:226:%s:%s', v_run_id, v_batch_no),
        'bitrix24',
        jsonb_build_object(
          'trigger', 'migration',
          'runId', v_run_id,
          'batch', v_batch_no,
          'retentionDays', 7,
          'cutoff', v_cutoff,
          'auditDeleted', v_batch_audit,
          'inboundDeleted', v_batch_inbound
        )
      );
    END IF;
    COMMIT;
    RAISE NOTICE 'bitrix24 reconcile retention: removed % audit rows and % queue events so far',
      v_audit, v_inbound;
    EXIT WHEN v_batch_audit < v_batch AND v_batch_inbound < v_batch;
  END LOOP;

  INSERT INTO public.audit_log (
    event, entity_type, entity_id, request_id, source, metadata_json
  )
  VALUES (
    'bitrix24_reverse.reconcile_retention_pruned',
    'audit_retention',
    'bitrix24_reconcile',
    'migration:226',
    'bitrix24',
    jsonb_build_object(
      'trigger', 'migration',
      'completed', true,
      'runId', v_run_id,
      'batches', v_batch_no,
      'retentionDays', 7,
      'cutoff', v_cutoff,
      'auditDeleted', v_audit,
      'inboundDeleted', v_inbound
    )
  );
END;
$$;
