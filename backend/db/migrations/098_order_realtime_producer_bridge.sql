-- Narrow compatibility bridge for runtime writers that still mutate live-state
-- tables outside backend command services. Disabled by default in app_settings.

BEGIN;

INSERT INTO app_settings (setting_key, value_json, description, is_active)
VALUES
  (
    'order_realtime.writes',
    '{"enabled":false,"maxFanoutOrders":5000,"maxDetailIds":500}'::jsonb,
    'Transactional order realtime producer bridge',
    true
  ),
  (
    'order_realtime.rollout',
    '{"enabled":false,"userIds":[],"rolloutPercent":0}'::jsonb,
    'Order realtime SSE rollout cohort',
    true
  )
ON CONFLICT (setting_key) DO NOTHING;

UPDATE app_settings
SET value_json = jsonb_set(value_json, '{maxDetailIds}', '500'::jsonb),
    updated_at = now()
WHERE setting_key = 'order_realtime.writes'
  AND NOT (value_json ? 'maxDetailIds');

CREATE OR REPLACE FUNCTION order_realtime_bridge_config()
RETURNS TABLE(enabled BOOLEAN, max_fanout_orders INTEGER)
LANGUAGE sql
STABLE
AS $$
  SELECT
    CASE
      WHEN lower(COALESCE(value_json->>'enabled', 'false')) IN ('true', 'false')
        THEN (value_json->>'enabled')::boolean
      ELSE false
    END,
    CASE
      WHEN COALESCE(value_json->>'maxFanoutOrders', '') ~ '^[1-9][0-9]{0,5}$'
        THEN LEAST((value_json->>'maxFanoutOrders')::integer, 100000)
      ELSE 5000
    END
  FROM app_settings
  WHERE setting_key = 'order_realtime.writes' AND is_active = true
  UNION ALL
  SELECT false, 5000
  WHERE NOT EXISTS (
    SELECT 1 FROM app_settings
    WHERE setting_key = 'order_realtime.writes' AND is_active = true
  )
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION order_realtime_bridge_max_detail_ids()
RETURNS INTEGER
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN COALESCE(value_json->>'maxDetailIds', '') ~ '^[1-9][0-9]{0,4}$'
      THEN LEAST((value_json->>'maxDetailIds')::integer, 10000)
    ELSE 500
  END
  FROM app_settings
  WHERE setting_key = 'order_realtime.writes' AND is_active = true
  UNION ALL
  SELECT 500
  WHERE NOT EXISTS (
    SELECT 1 FROM app_settings
    WHERE setting_key = 'order_realtime.writes' AND is_active = true
  )
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION order_realtime_bridge_enabled_for_fanout(p_order_count INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_enabled BOOLEAN;
  v_limit INTEGER;
BEGIN
  SELECT enabled, max_fanout_orders
  INTO v_enabled, v_limit
  FROM order_realtime_bridge_config();

  IF NOT COALESCE(v_enabled, false) THEN
    RETURN false;
  END IF;
  IF p_order_count > v_limit THEN
    RAISE EXCEPTION 'ORDER_REALTIME_FANOUT_LIMIT: % orders exceeds %', p_order_count, v_limit
      USING ERRCODE = 'P0001';
  END IF;
  RETURN true;
END
$$;

-- Serialize shared cut-reference writers before resolving order membership.
-- Global bridge order is cut_job ASC -> cut_param_profile ASC -> order ASC.
CREATE OR REPLACE FUNCTION order_realtime_lock_cut_roots(p_cut_job_ids BIGINT[])
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_enabled BOOLEAN;
BEGIN
  SELECT enabled INTO v_enabled FROM order_realtime_bridge_config();
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN;
  END IF;

  PERFORM 1
  FROM cut_job cj
  WHERE cj.cut_job_id = ANY(COALESCE(p_cut_job_ids, ARRAY[]::BIGINT[]))
  ORDER BY cj.cut_job_id
  FOR UPDATE;

  PERFORM 1
  FROM cut_param_profiles cpp
  WHERE cpp.cut_param_profile_id IN (
    SELECT cj.param_profile_id
    FROM cut_job cj
    WHERE cj.cut_job_id = ANY(COALESCE(p_cut_job_ids, ARRAY[]::BIGINT[]))
      AND cj.param_profile_id IS NOT NULL
  )
  ORDER BY cpp.cut_param_profile_id
  FOR UPDATE;
END
$$;

CREATE OR REPLACE FUNCTION order_realtime_cut_job_snapshot_visible(
  p_cut_job_id BIGINT,
  p_status TEXT,
  p_last_calc_basis TEXT,
  p_current_cut_result_id BIGINT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    p_status = 'ready'
    AND p_last_calc_basis IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM cut_result cr
      WHERE cr.cut_result_id = p_current_cut_result_id
        AND cr.cut_job_id = p_cut_job_id
        AND NOT EXISTS (
          SELECT 1
          FROM cut_result_archive_state archived
          WHERE archived.cut_job_id = cr.cut_job_id
            AND archived.result_no = cr.result_no
        )
    ),
    false
  )
$$;

CREATE OR REPLACE FUNCTION order_realtime_order_snapshot_visible(p_order_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.order_id = p_order_id AND o.delete_flag = false
  )
$$;

CREATE OR REPLACE FUNCTION order_realtime_emit_one(
  p_order_id BIGINT,
  p_domains TEXT[],
  p_detail_ids BIGINT[],
  p_source_type TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_enabled BOOLEAN;
  v_max_detail_ids INTEGER;
  v_domains TEXT[];
  v_detail_ids BIGINT[];
  v_stream order_realtime_stream%ROWTYPE;
BEGIN
  SELECT enabled INTO v_enabled FROM order_realtime_bridge_config();
  SELECT order_realtime_bridge_max_detail_ids() INTO v_max_detail_ids;
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN false;
  END IF;

  SELECT array_agg(domain_name ORDER BY domain_name)
  INTO v_domains
  FROM (
    SELECT DISTINCT domain_name
    FROM unnest(p_domains) AS domain_name
    WHERE domain_name IN ('detail_status', 'cut_refs')
  ) normalized;
  IF COALESCE(cardinality(v_domains), 0) = 0 THEN
    RAISE EXCEPTION 'ORDER_REALTIME_INVALID_DOMAIN' USING ERRCODE = 'P0001';
  END IF;

  SELECT array_agg(detail_id ORDER BY detail_id)
  INTO v_detail_ids
  FROM (
    SELECT DISTINCT detail_id
    FROM unnest(COALESCE(p_detail_ids, ARRAY[]::BIGINT[])) AS detail_id
    WHERE detail_id > 0
  ) normalized;
  IF COALESCE(cardinality(v_detail_ids), 0) > v_max_detail_ids THEN
    v_detail_ids := NULL;
  END IF;

  INSERT INTO order_realtime_stream (order_id)
  SELECT p_order_id
  WHERE EXISTS (SELECT 1 FROM orders WHERE order_id = p_order_id)
  ON CONFLICT (order_id) DO NOTHING;

  PERFORM 1
  FROM order_realtime_stream
  WHERE order_id = p_order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE order_realtime_stream
  SET commit_sequence = commit_sequence + 1,
      detail_status_revision = detail_status_revision
        + CASE WHEN 'detail_status' = ANY(v_domains) THEN 1 ELSE 0 END,
      cut_refs_revision = cut_refs_revision
        + CASE WHEN 'cut_refs' = ANY(v_domains) THEN 1 ELSE 0 END,
      updated_at = now()
  WHERE order_id = p_order_id
  RETURNING * INTO v_stream;

  INSERT INTO realtime_event_log (
    order_id, commit_sequence, detail_status_revision, cut_refs_revision,
    domains, detail_ids, schema_version, source_type, source_key, occurred_at
  )
  VALUES (
    p_order_id,
    v_stream.commit_sequence,
    CASE WHEN 'detail_status' = ANY(v_domains) THEN v_stream.detail_status_revision ELSE NULL END,
    CASE WHEN 'cut_refs' = ANY(v_domains) THEN v_stream.cut_refs_revision ELSE NULL END,
    v_domains,
    CASE WHEN cardinality(v_detail_ids) = 0 THEN NULL ELSE v_detail_ids END,
    1,
    left(p_source_type, 200),
    -- Technical transport identity only. Business audit/idempotency remains
    -- owned by the command or legacy writer that performed the mutation.
    left('db-bridge:' || p_source_type || ':' || txid_current()::text || ':' || v_stream.commit_sequence::text, 200),
    statement_timestamp()
  );
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION trg_order_realtime_detail_status_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_count INTEGER;
  v_row RECORD;
  v_emitted BOOLEAN := false;
BEGIN
  IF NOT order_realtime_bridge_enabled_for_fanout(0) THEN RETURN NULL; END IF;
  SELECT count(DISTINCT order_id) INTO v_count
  FROM new_rows
  WHERE delete_flag = false AND order_realtime_order_snapshot_visible(order_id);
  IF NOT order_realtime_bridge_enabled_for_fanout(v_count) THEN RETURN NULL; END IF;
  FOR v_row IN
    SELECT order_id, array_agg(DISTINCT detail_id ORDER BY detail_id) AS detail_ids
    FROM new_rows
    WHERE delete_flag = false AND order_realtime_order_snapshot_visible(order_id)
    GROUP BY order_id ORDER BY order_id
  LOOP
    v_emitted := order_realtime_emit_one(v_row.order_id, ARRAY['detail_status'], v_row.detail_ids, 'order_details.insert') OR v_emitted;
  END LOOP;
  IF v_emitted THEN PERFORM pg_notify('erp_realtime', 'wake'); END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION trg_order_realtime_detail_status_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_count INTEGER;
  v_row RECORD;
  v_emitted BOOLEAN := false;
BEGIN
  IF NOT order_realtime_bridge_enabled_for_fanout(0) THEN RETURN NULL; END IF;
  WITH changed AS (
    SELECT o.order_id FROM old_rows o JOIN new_rows n USING (detail_id)
    WHERE (
      n.production_status_id IS DISTINCT FROM o.production_status_id
      OR n.delete_flag IS DISTINCT FROM o.delete_flag
      OR n.order_id IS DISTINCT FROM o.order_id
    ) AND o.delete_flag = false
      AND order_realtime_order_snapshot_visible(o.order_id)
    UNION
    SELECT n.order_id FROM old_rows o JOIN new_rows n USING (detail_id)
    WHERE (
      n.production_status_id IS DISTINCT FROM o.production_status_id
      OR n.delete_flag IS DISTINCT FROM o.delete_flag
      OR n.order_id IS DISTINCT FROM o.order_id
    ) AND n.delete_flag = false
      AND order_realtime_order_snapshot_visible(n.order_id)
  ) SELECT count(DISTINCT order_id) INTO v_count FROM changed;
  IF v_count = 0 OR NOT order_realtime_bridge_enabled_for_fanout(v_count) THEN RETURN NULL; END IF;
  FOR v_row IN
    WITH changed AS (
      SELECT o.order_id, o.detail_id FROM old_rows o JOIN new_rows n USING (detail_id)
      WHERE (
        n.production_status_id IS DISTINCT FROM o.production_status_id
        OR n.delete_flag IS DISTINCT FROM o.delete_flag
        OR n.order_id IS DISTINCT FROM o.order_id
      ) AND o.delete_flag = false
        AND order_realtime_order_snapshot_visible(o.order_id)
      UNION
      SELECT n.order_id, n.detail_id FROM old_rows o JOIN new_rows n USING (detail_id)
      WHERE (
        n.production_status_id IS DISTINCT FROM o.production_status_id
        OR n.delete_flag IS DISTINCT FROM o.delete_flag
        OR n.order_id IS DISTINCT FROM o.order_id
      ) AND n.delete_flag = false
        AND order_realtime_order_snapshot_visible(n.order_id)
    )
    SELECT order_id, array_agg(DISTINCT detail_id ORDER BY detail_id) AS detail_ids
    FROM changed GROUP BY order_id ORDER BY order_id
  LOOP
    v_emitted := order_realtime_emit_one(v_row.order_id, ARRAY['detail_status'], v_row.detail_ids, 'order_details.update') OR v_emitted;
  END LOOP;
  IF v_emitted THEN PERFORM pg_notify('erp_realtime', 'wake'); END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION trg_order_realtime_detail_status_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_count INTEGER;
  v_row RECORD;
  v_emitted BOOLEAN := false;
BEGIN
  IF NOT order_realtime_bridge_enabled_for_fanout(0) THEN RETURN NULL; END IF;
  SELECT count(DISTINCT order_id) INTO v_count
  FROM old_rows
  WHERE delete_flag = false AND order_realtime_order_snapshot_visible(order_id);
  IF NOT order_realtime_bridge_enabled_for_fanout(v_count) THEN RETURN NULL; END IF;
  FOR v_row IN
    SELECT order_id, array_agg(DISTINCT detail_id ORDER BY detail_id) AS detail_ids
    FROM old_rows
    WHERE delete_flag = false AND order_realtime_order_snapshot_visible(order_id)
    GROUP BY order_id ORDER BY order_id
  LOOP
    v_emitted := order_realtime_emit_one(v_row.order_id, ARRAY['detail_status'], v_row.detail_ids, 'order_details.delete') OR v_emitted;
  END LOOP;
  IF v_emitted THEN PERFORM pg_notify('erp_realtime', 'wake'); END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_order_realtime_detail_status_insert ON order_details;
CREATE TRIGGER trg_order_realtime_detail_status_insert
AFTER INSERT ON order_details
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION trg_order_realtime_detail_status_insert();

DROP TRIGGER IF EXISTS trg_order_realtime_detail_status_update ON order_details;
CREATE TRIGGER trg_order_realtime_detail_status_update
AFTER UPDATE ON order_details
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION trg_order_realtime_detail_status_update();

DROP TRIGGER IF EXISTS trg_order_realtime_detail_status_delete ON order_details;
CREATE TRIGGER trg_order_realtime_detail_status_delete
AFTER DELETE ON order_details
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION trg_order_realtime_detail_status_delete();

CREATE OR REPLACE FUNCTION trg_order_realtime_order_visibility_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_count INTEGER;
  v_order_id BIGINT;
  v_emitted BOOLEAN := false;
BEGIN
  IF NOT order_realtime_bridge_enabled_for_fanout(0) THEN RETURN NULL; END IF;
  WITH changed AS (
    SELECT n.order_id
    FROM old_rows o JOIN new_rows n USING (order_id)
    WHERE n.delete_flag IS DISTINCT FROM o.delete_flag
  ) SELECT count(*) INTO v_count FROM changed;
  IF v_count = 0 OR NOT order_realtime_bridge_enabled_for_fanout(v_count) THEN RETURN NULL; END IF;
  FOR v_order_id IN
    SELECT n.order_id
    FROM old_rows o JOIN new_rows n USING (order_id)
    WHERE n.delete_flag IS DISTINCT FROM o.delete_flag
    ORDER BY n.order_id
  LOOP
    v_emitted := order_realtime_emit_one(v_order_id, ARRAY['detail_status', 'cut_refs'], NULL, 'orders.visibility') OR v_emitted;
  END LOOP;
  IF v_emitted THEN PERFORM pg_notify('erp_realtime', 'wake'); END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_order_realtime_order_visibility_update ON orders;
CREATE TRIGGER trg_order_realtime_order_visibility_update
AFTER UPDATE ON orders
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION trg_order_realtime_order_visibility_update();

CREATE OR REPLACE FUNCTION trg_order_realtime_cut_item_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_count INTEGER;
  v_row RECORD;
  v_emitted BOOLEAN := false;
BEGIN
  IF NOT order_realtime_bridge_enabled_for_fanout(0) THEN RETURN NULL; END IF;
  PERFORM order_realtime_lock_cut_roots(ARRAY(
    SELECT DISTINCT n.cut_job_id
    FROM new_rows n
    JOIN cut_job cj ON cj.cut_job_id = n.cut_job_id
    JOIN order_details od ON od.detail_id = n.order_detail_id AND od.order_id = n.order_id
    WHERE n.is_active = true
      AND od.delete_flag = false
      AND order_realtime_order_snapshot_visible(n.order_id)
      AND order_realtime_cut_job_snapshot_visible(
        cj.cut_job_id, cj.status, cj.last_calc_basis, cj.current_cut_result_id
      )
    ORDER BY n.cut_job_id
  ));
  SELECT count(DISTINCT n.order_id) INTO v_count
  FROM new_rows n
  JOIN cut_job cj ON cj.cut_job_id = n.cut_job_id
  JOIN order_details od ON od.detail_id = n.order_detail_id AND od.order_id = n.order_id
  WHERE n.is_active = true
    AND od.delete_flag = false
    AND order_realtime_order_snapshot_visible(n.order_id)
    AND order_realtime_cut_job_snapshot_visible(
      cj.cut_job_id, cj.status, cj.last_calc_basis, cj.current_cut_result_id
    );
  IF NOT order_realtime_bridge_enabled_for_fanout(v_count) THEN RETURN NULL; END IF;
  FOR v_row IN
    SELECT n.order_id, array_agg(DISTINCT n.order_detail_id ORDER BY n.order_detail_id) AS detail_ids
    FROM new_rows n
    JOIN cut_job cj ON cj.cut_job_id = n.cut_job_id
    JOIN order_details od ON od.detail_id = n.order_detail_id AND od.order_id = n.order_id
    WHERE n.is_active = true
      AND od.delete_flag = false
      AND order_realtime_order_snapshot_visible(n.order_id)
      AND order_realtime_cut_job_snapshot_visible(
        cj.cut_job_id, cj.status, cj.last_calc_basis, cj.current_cut_result_id
      )
    GROUP BY n.order_id ORDER BY n.order_id
  LOOP
    v_emitted := order_realtime_emit_one(v_row.order_id, ARRAY['cut_refs'], v_row.detail_ids, 'cut_job_item.insert') OR v_emitted;
  END LOOP;
  IF v_emitted THEN PERFORM pg_notify('erp_realtime', 'wake'); END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION trg_order_realtime_cut_item_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_count INTEGER;
  v_row RECORD;
  v_emitted BOOLEAN := false;
BEGIN
  IF NOT order_realtime_bridge_enabled_for_fanout(0) THEN RETURN NULL; END IF;
  PERFORM order_realtime_lock_cut_roots(ARRAY(
    SELECT cut_job_id
    FROM (
      SELECT o.cut_job_id
      FROM old_rows o JOIN new_rows n USING (cut_job_item_id)
      JOIN cut_job cj ON cj.cut_job_id = o.cut_job_id
      JOIN order_details od ON od.detail_id = o.order_detail_id AND od.order_id = o.order_id
      WHERE (
        n.order_id IS DISTINCT FROM o.order_id
        OR n.order_detail_id IS DISTINCT FROM o.order_detail_id
        OR n.cut_job_id IS DISTINCT FROM o.cut_job_id
        OR n.is_active IS DISTINCT FROM o.is_active
      ) AND o.is_active = true
        AND od.delete_flag = false
        AND order_realtime_order_snapshot_visible(o.order_id)
        AND order_realtime_cut_job_snapshot_visible(
          cj.cut_job_id, cj.status, cj.last_calc_basis, cj.current_cut_result_id
        )
      UNION
      SELECT n.cut_job_id
      FROM old_rows o JOIN new_rows n USING (cut_job_item_id)
      JOIN cut_job cj ON cj.cut_job_id = n.cut_job_id
      JOIN order_details od ON od.detail_id = n.order_detail_id AND od.order_id = n.order_id
      WHERE (
        n.order_id IS DISTINCT FROM o.order_id
        OR n.order_detail_id IS DISTINCT FROM o.order_detail_id
        OR n.cut_job_id IS DISTINCT FROM o.cut_job_id
        OR n.is_active IS DISTINCT FROM o.is_active
      ) AND n.is_active = true
        AND od.delete_flag = false
        AND order_realtime_order_snapshot_visible(n.order_id)
        AND order_realtime_cut_job_snapshot_visible(
          cj.cut_job_id, cj.status, cj.last_calc_basis, cj.current_cut_result_id
        )
    ) affected_jobs
    ORDER BY cut_job_id
  ));
  WITH affected AS (
    SELECT o.order_id, o.order_detail_id
    FROM old_rows o JOIN new_rows n USING (cut_job_item_id)
    JOIN cut_job cj ON cj.cut_job_id = o.cut_job_id
    JOIN order_details od ON od.detail_id = o.order_detail_id AND od.order_id = o.order_id
    WHERE (
      n.order_id IS DISTINCT FROM o.order_id
      OR n.order_detail_id IS DISTINCT FROM o.order_detail_id
      OR n.cut_job_id IS DISTINCT FROM o.cut_job_id
      OR n.is_active IS DISTINCT FROM o.is_active
    ) AND o.is_active = true
      AND od.delete_flag = false
      AND order_realtime_order_snapshot_visible(o.order_id)
      AND order_realtime_cut_job_snapshot_visible(
        cj.cut_job_id, cj.status, cj.last_calc_basis, cj.current_cut_result_id
      )
    UNION
    SELECT n.order_id, n.order_detail_id
    FROM old_rows o JOIN new_rows n USING (cut_job_item_id)
    JOIN cut_job cj ON cj.cut_job_id = n.cut_job_id
    JOIN order_details od ON od.detail_id = n.order_detail_id AND od.order_id = n.order_id
    WHERE (
      n.order_id IS DISTINCT FROM o.order_id
      OR n.order_detail_id IS DISTINCT FROM o.order_detail_id
      OR n.cut_job_id IS DISTINCT FROM o.cut_job_id
      OR n.is_active IS DISTINCT FROM o.is_active
    ) AND n.is_active = true
      AND od.delete_flag = false
      AND order_realtime_order_snapshot_visible(n.order_id)
      AND order_realtime_cut_job_snapshot_visible(
        cj.cut_job_id, cj.status, cj.last_calc_basis, cj.current_cut_result_id
      )
  ) SELECT count(DISTINCT order_id) INTO v_count FROM affected;
  IF v_count = 0 OR NOT order_realtime_bridge_enabled_for_fanout(v_count) THEN RETURN NULL; END IF;
  FOR v_row IN
    WITH affected AS (
      SELECT o.order_id, o.order_detail_id
      FROM old_rows o JOIN new_rows n USING (cut_job_item_id)
      JOIN cut_job cj ON cj.cut_job_id = o.cut_job_id
      JOIN order_details od ON od.detail_id = o.order_detail_id AND od.order_id = o.order_id
      WHERE (
        n.order_id IS DISTINCT FROM o.order_id
        OR n.order_detail_id IS DISTINCT FROM o.order_detail_id
        OR n.cut_job_id IS DISTINCT FROM o.cut_job_id
        OR n.is_active IS DISTINCT FROM o.is_active
      ) AND o.is_active = true
        AND od.delete_flag = false
        AND order_realtime_order_snapshot_visible(o.order_id)
        AND order_realtime_cut_job_snapshot_visible(
          cj.cut_job_id, cj.status, cj.last_calc_basis, cj.current_cut_result_id
        )
      UNION
      SELECT n.order_id, n.order_detail_id
      FROM old_rows o JOIN new_rows n USING (cut_job_item_id)
      JOIN cut_job cj ON cj.cut_job_id = n.cut_job_id
      JOIN order_details od ON od.detail_id = n.order_detail_id AND od.order_id = n.order_id
      WHERE (
        n.order_id IS DISTINCT FROM o.order_id
        OR n.order_detail_id IS DISTINCT FROM o.order_detail_id
        OR n.cut_job_id IS DISTINCT FROM o.cut_job_id
        OR n.is_active IS DISTINCT FROM o.is_active
      ) AND n.is_active = true
        AND od.delete_flag = false
        AND order_realtime_order_snapshot_visible(n.order_id)
        AND order_realtime_cut_job_snapshot_visible(
          cj.cut_job_id, cj.status, cj.last_calc_basis, cj.current_cut_result_id
        )
    )
    SELECT order_id, array_agg(DISTINCT order_detail_id ORDER BY order_detail_id) AS detail_ids
    FROM affected GROUP BY order_id ORDER BY order_id
  LOOP
    v_emitted := order_realtime_emit_one(v_row.order_id, ARRAY['cut_refs'], v_row.detail_ids, 'cut_job_item.change') OR v_emitted;
  END LOOP;
  IF v_emitted THEN PERFORM pg_notify('erp_realtime', 'wake'); END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION trg_order_realtime_cut_item_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_count INTEGER;
  v_row RECORD;
  v_emitted BOOLEAN := false;
BEGIN
  IF NOT order_realtime_bridge_enabled_for_fanout(0) THEN RETURN NULL; END IF;
  PERFORM order_realtime_lock_cut_roots(ARRAY(
    SELECT DISTINCT o.cut_job_id
    FROM old_rows o
    JOIN cut_job cj ON cj.cut_job_id = o.cut_job_id
    JOIN order_details od ON od.detail_id = o.order_detail_id AND od.order_id = o.order_id
    WHERE o.is_active = true
      AND od.delete_flag = false
      AND order_realtime_order_snapshot_visible(o.order_id)
      AND order_realtime_cut_job_snapshot_visible(
        cj.cut_job_id, cj.status, cj.last_calc_basis, cj.current_cut_result_id
      )
    ORDER BY o.cut_job_id
  ));
  SELECT count(DISTINCT o.order_id) INTO v_count
  FROM old_rows o
  JOIN cut_job cj ON cj.cut_job_id = o.cut_job_id
  JOIN order_details od ON od.detail_id = o.order_detail_id AND od.order_id = o.order_id
  WHERE o.is_active = true
    AND od.delete_flag = false
    AND order_realtime_order_snapshot_visible(o.order_id)
    AND order_realtime_cut_job_snapshot_visible(
      cj.cut_job_id, cj.status, cj.last_calc_basis, cj.current_cut_result_id
    );
  IF NOT order_realtime_bridge_enabled_for_fanout(v_count) THEN RETURN NULL; END IF;
  FOR v_row IN
    SELECT o.order_id, array_agg(DISTINCT o.order_detail_id ORDER BY o.order_detail_id) AS detail_ids
    FROM old_rows o
    JOIN cut_job cj ON cj.cut_job_id = o.cut_job_id
    JOIN order_details od ON od.detail_id = o.order_detail_id AND od.order_id = o.order_id
    WHERE o.is_active = true
      AND od.delete_flag = false
      AND order_realtime_order_snapshot_visible(o.order_id)
      AND order_realtime_cut_job_snapshot_visible(
        cj.cut_job_id, cj.status, cj.last_calc_basis, cj.current_cut_result_id
      )
    GROUP BY o.order_id ORDER BY o.order_id
  LOOP
    v_emitted := order_realtime_emit_one(v_row.order_id, ARRAY['cut_refs'], v_row.detail_ids, 'cut_job_item.delete') OR v_emitted;
  END LOOP;
  IF v_emitted THEN PERFORM pg_notify('erp_realtime', 'wake'); END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_order_realtime_cut_item_insert ON cut_job_item;
CREATE TRIGGER trg_order_realtime_cut_item_insert
AFTER INSERT ON cut_job_item
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION trg_order_realtime_cut_item_insert();

DROP TRIGGER IF EXISTS trg_order_realtime_cut_item_update ON cut_job_item;
CREATE TRIGGER trg_order_realtime_cut_item_update
AFTER UPDATE ON cut_job_item
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION trg_order_realtime_cut_item_update();

DROP TRIGGER IF EXISTS trg_order_realtime_cut_item_delete ON cut_job_item;
CREATE TRIGGER trg_order_realtime_cut_item_delete
AFTER DELETE ON cut_job_item
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION trg_order_realtime_cut_item_delete();

CREATE OR REPLACE FUNCTION trg_order_realtime_cut_job_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_count INTEGER;
  v_row RECORD;
  v_emitted BOOLEAN := false;
BEGIN
  IF NOT order_realtime_bridge_enabled_for_fanout(0) THEN RETURN NULL; END IF;
  PERFORM order_realtime_lock_cut_roots(ARRAY(
    SELECT n.cut_job_id
    FROM old_rows o JOIN new_rows n USING (cut_job_id)
    WHERE (
      n.status IS DISTINCT FROM o.status
       OR n.current_cut_result_id IS DISTINCT FROM o.current_cut_result_id
       OR n.name IS DISTINCT FROM o.name
       OR n.param_profile_id IS DISTINCT FROM o.param_profile_id
       OR n.last_calc_basis IS DISTINCT FROM o.last_calc_basis
       OR n.last_calc_params IS DISTINCT FROM o.last_calc_params
       OR n.params IS DISTINCT FROM o.params
    ) AND (
      order_realtime_cut_job_snapshot_visible(
        o.cut_job_id, o.status, o.last_calc_basis, o.current_cut_result_id
      )
      OR order_realtime_cut_job_snapshot_visible(
        n.cut_job_id, n.status, n.last_calc_basis, n.current_cut_result_id
      )
    )
    ORDER BY n.cut_job_id
  ));
  WITH changed_jobs AS (
    SELECT n.cut_job_id
    FROM old_rows o JOIN new_rows n USING (cut_job_id)
    WHERE (
      n.status IS DISTINCT FROM o.status
       OR n.current_cut_result_id IS DISTINCT FROM o.current_cut_result_id
       OR n.name IS DISTINCT FROM o.name
       OR n.param_profile_id IS DISTINCT FROM o.param_profile_id
       OR n.last_calc_basis IS DISTINCT FROM o.last_calc_basis
       OR n.last_calc_params IS DISTINCT FROM o.last_calc_params
       OR n.params IS DISTINCT FROM o.params
      ) AND (
        order_realtime_cut_job_snapshot_visible(
          o.cut_job_id, o.status, o.last_calc_basis, o.current_cut_result_id
        )
        OR order_realtime_cut_job_snapshot_visible(
          n.cut_job_id, n.status, n.last_calc_basis, n.current_cut_result_id
        )
      )
  ), affected AS (
    SELECT DISTINCT cji.order_id
    FROM changed_jobs changed JOIN cut_job_item cji USING (cut_job_id)
    JOIN order_details od ON od.detail_id = cji.order_detail_id AND od.order_id = cji.order_id
    WHERE cji.is_active = true
      AND od.delete_flag = false
      AND order_realtime_order_snapshot_visible(cji.order_id)
  ) SELECT count(*) INTO v_count FROM affected;
  IF v_count = 0 OR NOT order_realtime_bridge_enabled_for_fanout(v_count) THEN RETURN NULL; END IF;
  FOR v_row IN
    WITH changed_jobs AS (
      SELECT n.cut_job_id
      FROM old_rows o JOIN new_rows n USING (cut_job_id)
      WHERE (
        n.status IS DISTINCT FROM o.status
         OR n.current_cut_result_id IS DISTINCT FROM o.current_cut_result_id
         OR n.name IS DISTINCT FROM o.name
         OR n.param_profile_id IS DISTINCT FROM o.param_profile_id
         OR n.last_calc_basis IS DISTINCT FROM o.last_calc_basis
         OR n.last_calc_params IS DISTINCT FROM o.last_calc_params
         OR n.params IS DISTINCT FROM o.params
        ) AND (
          order_realtime_cut_job_snapshot_visible(
            o.cut_job_id, o.status, o.last_calc_basis, o.current_cut_result_id
          )
          OR order_realtime_cut_job_snapshot_visible(
            n.cut_job_id, n.status, n.last_calc_basis, n.current_cut_result_id
          )
        )
    )
    SELECT cji.order_id,
           array_agg(DISTINCT cji.order_detail_id ORDER BY cji.order_detail_id) AS detail_ids
    FROM changed_jobs changed JOIN cut_job_item cji USING (cut_job_id)
    JOIN order_details od ON od.detail_id = cji.order_detail_id AND od.order_id = cji.order_id
    WHERE cji.is_active = true
      AND od.delete_flag = false
      AND order_realtime_order_snapshot_visible(cji.order_id)
    GROUP BY cji.order_id ORDER BY cji.order_id
  LOOP
    v_emitted := order_realtime_emit_one(v_row.order_id, ARRAY['cut_refs'], v_row.detail_ids, 'cut_job.update') OR v_emitted;
  END LOOP;
  IF v_emitted THEN PERFORM pg_notify('erp_realtime', 'wake'); END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_order_realtime_cut_job_update ON cut_job;
CREATE TRIGGER trg_order_realtime_cut_job_update
AFTER UPDATE ON cut_job
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION trg_order_realtime_cut_job_update();

CREATE OR REPLACE FUNCTION trg_order_realtime_cut_archive_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_count INTEGER;
  v_row RECORD;
  v_emitted BOOLEAN := false;
BEGIN
  IF NOT order_realtime_bridge_enabled_for_fanout(0) THEN RETURN NULL; END IF;
  PERFORM order_realtime_lock_cut_roots(ARRAY(
    SELECT DISTINCT changed.cut_job_id
    FROM new_rows changed
    JOIN cut_job cj ON cj.cut_job_id = changed.cut_job_id
    JOIN cut_result cr
      ON cr.cut_result_id = cj.current_cut_result_id
     AND cr.cut_job_id = cj.cut_job_id
     AND cr.result_no = changed.result_no
    WHERE cj.status = 'ready' AND cj.last_calc_basis IS NOT NULL
    ORDER BY changed.cut_job_id
  ));
  WITH affected AS (
    SELECT DISTINCT cji.order_id
    FROM new_rows changed
    JOIN cut_job cj ON cj.cut_job_id = changed.cut_job_id
    JOIN cut_result cr
      ON cr.cut_result_id = cj.current_cut_result_id
     AND cr.cut_job_id = cj.cut_job_id
     AND cr.result_no = changed.result_no
    JOIN cut_job_item cji ON cji.cut_job_id = cj.cut_job_id
    JOIN order_details od ON od.detail_id = cji.order_detail_id AND od.order_id = cji.order_id
    WHERE cji.is_active = true
      AND od.delete_flag = false
      AND order_realtime_order_snapshot_visible(cji.order_id)
      AND cj.status = 'ready'
      AND cj.last_calc_basis IS NOT NULL
  ) SELECT count(*) INTO v_count FROM affected;
  IF v_count = 0 OR NOT order_realtime_bridge_enabled_for_fanout(v_count) THEN RETURN NULL; END IF;
  FOR v_row IN
    SELECT cji.order_id, array_agg(DISTINCT cji.order_detail_id ORDER BY cji.order_detail_id) AS detail_ids
    FROM new_rows changed
    JOIN cut_job cj ON cj.cut_job_id = changed.cut_job_id
    JOIN cut_result cr
      ON cr.cut_result_id = cj.current_cut_result_id
     AND cr.cut_job_id = cj.cut_job_id
     AND cr.result_no = changed.result_no
    JOIN cut_job_item cji ON cji.cut_job_id = cj.cut_job_id
    JOIN order_details od ON od.detail_id = cji.order_detail_id AND od.order_id = cji.order_id
    WHERE cji.is_active = true
      AND od.delete_flag = false
      AND order_realtime_order_snapshot_visible(cji.order_id)
      AND cj.status = 'ready'
      AND cj.last_calc_basis IS NOT NULL
    GROUP BY cji.order_id ORDER BY cji.order_id
  LOOP
    v_emitted := order_realtime_emit_one(v_row.order_id, ARRAY['cut_refs'], v_row.detail_ids, 'cut_result_archive.insert') OR v_emitted;
  END LOOP;
  IF v_emitted THEN PERFORM pg_notify('erp_realtime', 'wake'); END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION trg_order_realtime_cut_archive_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_count INTEGER;
  v_row RECORD;
  v_emitted BOOLEAN := false;
BEGIN
  IF NOT order_realtime_bridge_enabled_for_fanout(0) THEN RETURN NULL; END IF;
  PERFORM order_realtime_lock_cut_roots(ARRAY(
    SELECT DISTINCT changed.cut_job_id
    FROM old_rows changed
    JOIN cut_job cj ON cj.cut_job_id = changed.cut_job_id
    JOIN cut_result cr
      ON cr.cut_result_id = cj.current_cut_result_id
     AND cr.cut_job_id = cj.cut_job_id
     AND cr.result_no = changed.result_no
    WHERE cj.status = 'ready' AND cj.last_calc_basis IS NOT NULL
    ORDER BY changed.cut_job_id
  ));
  WITH affected AS (
    SELECT DISTINCT cji.order_id
    FROM old_rows changed
    JOIN cut_job cj ON cj.cut_job_id = changed.cut_job_id
    JOIN cut_result cr
      ON cr.cut_result_id = cj.current_cut_result_id
     AND cr.cut_job_id = cj.cut_job_id
     AND cr.result_no = changed.result_no
    JOIN cut_job_item cji ON cji.cut_job_id = cj.cut_job_id
    JOIN order_details od ON od.detail_id = cji.order_detail_id AND od.order_id = cji.order_id
    WHERE cji.is_active = true
      AND od.delete_flag = false
      AND order_realtime_order_snapshot_visible(cji.order_id)
      AND cj.status = 'ready'
      AND cj.last_calc_basis IS NOT NULL
  ) SELECT count(*) INTO v_count FROM affected;
  IF v_count = 0 OR NOT order_realtime_bridge_enabled_for_fanout(v_count) THEN RETURN NULL; END IF;
  FOR v_row IN
    SELECT cji.order_id, array_agg(DISTINCT cji.order_detail_id ORDER BY cji.order_detail_id) AS detail_ids
    FROM old_rows changed
    JOIN cut_job cj ON cj.cut_job_id = changed.cut_job_id
    JOIN cut_result cr
      ON cr.cut_result_id = cj.current_cut_result_id
     AND cr.cut_job_id = cj.cut_job_id
     AND cr.result_no = changed.result_no
    JOIN cut_job_item cji ON cji.cut_job_id = cj.cut_job_id
    JOIN order_details od ON od.detail_id = cji.order_detail_id AND od.order_id = cji.order_id
    WHERE cji.is_active = true
      AND od.delete_flag = false
      AND order_realtime_order_snapshot_visible(cji.order_id)
      AND cj.status = 'ready'
      AND cj.last_calc_basis IS NOT NULL
    GROUP BY cji.order_id ORDER BY cji.order_id
  LOOP
    v_emitted := order_realtime_emit_one(v_row.order_id, ARRAY['cut_refs'], v_row.detail_ids, 'cut_result_archive.delete') OR v_emitted;
  END LOOP;
  IF v_emitted THEN PERFORM pg_notify('erp_realtime', 'wake'); END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_order_realtime_cut_archive_insert ON cut_result_archive_state;
CREATE TRIGGER trg_order_realtime_cut_archive_insert
AFTER INSERT ON cut_result_archive_state
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION trg_order_realtime_cut_archive_insert();

DROP TRIGGER IF EXISTS trg_order_realtime_cut_archive_delete ON cut_result_archive_state;
CREATE TRIGGER trg_order_realtime_cut_archive_delete
AFTER DELETE ON cut_result_archive_state
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION trg_order_realtime_cut_archive_delete();

CREATE OR REPLACE FUNCTION trg_order_realtime_cut_profile_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_count INTEGER;
  v_row RECORD;
  v_emitted BOOLEAN := false;
BEGIN
  IF NOT order_realtime_bridge_enabled_for_fanout(0) THEN RETURN NULL; END IF;
  WITH changed_profiles AS (
    SELECT n.cut_param_profile_id
    FROM old_rows o JOIN new_rows n USING (cut_param_profile_id)
    WHERE n.name IS DISTINCT FROM o.name
       OR n.is_active IS DISTINCT FROM o.is_active
       OR n.params IS DISTINCT FROM o.params
  ), affected AS (
    SELECT DISTINCT cji.order_id
    FROM changed_profiles changed
    JOIN cut_job cj ON cj.param_profile_id = changed.cut_param_profile_id
    JOIN cut_job_item cji USING (cut_job_id)
    JOIN order_details od ON od.detail_id = cji.order_detail_id AND od.order_id = cji.order_id
    WHERE cji.is_active = true
      AND od.delete_flag = false
      AND order_realtime_order_snapshot_visible(cji.order_id)
      AND order_realtime_cut_job_snapshot_visible(
        cj.cut_job_id, cj.status, cj.last_calc_basis, cj.current_cut_result_id
      )
  ) SELECT count(*) INTO v_count FROM affected;
  IF v_count = 0 OR NOT order_realtime_bridge_enabled_for_fanout(v_count) THEN RETURN NULL; END IF;
  FOR v_row IN
    WITH changed_profiles AS (
      SELECT n.cut_param_profile_id
      FROM old_rows o JOIN new_rows n USING (cut_param_profile_id)
      WHERE n.name IS DISTINCT FROM o.name
         OR n.is_active IS DISTINCT FROM o.is_active
         OR n.params IS DISTINCT FROM o.params
    )
    SELECT cji.order_id, array_agg(DISTINCT cji.order_detail_id ORDER BY cji.order_detail_id) AS detail_ids
    FROM changed_profiles changed
    JOIN cut_job cj ON cj.param_profile_id = changed.cut_param_profile_id
    JOIN cut_job_item cji USING (cut_job_id)
    JOIN order_details od ON od.detail_id = cji.order_detail_id AND od.order_id = cji.order_id
    WHERE cji.is_active = true
      AND od.delete_flag = false
      AND order_realtime_order_snapshot_visible(cji.order_id)
      AND order_realtime_cut_job_snapshot_visible(
        cj.cut_job_id, cj.status, cj.last_calc_basis, cj.current_cut_result_id
      )
    GROUP BY cji.order_id ORDER BY cji.order_id
  LOOP
    v_emitted := order_realtime_emit_one(v_row.order_id, ARRAY['cut_refs'], v_row.detail_ids, 'cut_profile.update') OR v_emitted;
  END LOOP;
  IF v_emitted THEN PERFORM pg_notify('erp_realtime', 'wake'); END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_order_realtime_cut_profile_update ON cut_param_profiles;
CREATE TRIGGER trg_order_realtime_cut_profile_update
AFTER UPDATE ON cut_param_profiles
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION trg_order_realtime_cut_profile_update();

COMMENT ON FUNCTION order_realtime_emit_one(BIGINT, TEXT[], BIGINT[], TEXT)
  IS 'order-realtime-producer-bridge-v1';

COMMIT;
