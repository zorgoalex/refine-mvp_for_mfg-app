-- §5.4e confirmed order corrections. (1) Terminal source-scoped position detachment: in source S a detached
-- (order, detail) position counts nowhere — every line of S at that position, in any revision, including new roots, is
-- history only. Written only by a confirmed order correction together with the cascade receipts that re-freeze demand
-- without the position. (2) Confirmed order-cascade intents (reductions/detachments allowed) carry their preview digest.
-- (3) The lineage seal guard accepts evidence at positions detached in that source. No backfill; no producer enabled.
BEGIN;

DO $$
BEGIN
  IF to_regclass(format('%I.%I',current_schema(),'mdf_order_cascade_intents')) IS NULL THEN
    RAISE EXCEPTION 'MDF migration 191 requires migration 188 in schema %',current_schema();
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS mdf_position_detachments (
  source_kind TEXT NOT NULL CHECK (source_kind IN ('packet','bazisCutSet','bath')),
  source_id TEXT NOT NULL CHECK (length(btrim(source_id)) BETWEEN 1 AND 240),
  order_id BIGINT NOT NULL CHECK (order_id>0),
  detail_id BIGINT NOT NULL CHECK (detail_id>0),
  correction_id UUID NOT NULL,
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 2000),
  actor_user_id BIGINT NOT NULL CHECK (actor_user_id>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Terminal: a (source, position) is detached at most once and never re-attached.
  PRIMARY KEY(source_kind,source_id,order_id,detail_id)
);
CREATE INDEX IF NOT EXISTS idx_mdf_position_detachments_order ON mdf_position_detachments(order_id,detail_id);

CREATE OR REPLACE FUNCTION mdf_reject_position_detachment_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'MDF position detachments are immutable and terminal' USING ERRCODE='55000';
END;
$$;
DROP TRIGGER IF EXISTS mdf_position_detachment_immutable ON mdf_position_detachments;
CREATE TRIGGER mdf_position_detachment_immutable BEFORE UPDATE OR DELETE ON mdf_position_detachments
  FOR EACH ROW EXECUTE FUNCTION mdf_reject_position_detachment_change();

ALTER TABLE mdf_order_cascade_intents ADD COLUMN IF NOT EXISTS confirmed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE mdf_order_cascade_intents ADD COLUMN IF NOT EXISTS preview_digest TEXT
  CHECK (preview_digest IS NULL OR preview_digest ~ '^[a-f0-9]{64}$');
ALTER TABLE mdf_order_cascade_intents DROP CONSTRAINT IF EXISTS mdf_order_cascade_intents_confirmed_digest;
ALTER TABLE mdf_order_cascade_intents ADD CONSTRAINT mdf_order_cascade_intents_confirmed_digest
  CHECK (confirmed = (preview_digest IS NOT NULL));

-- The lineage seal guard exists only once migration 182 is applied; redefine it only then.
DO $do$
BEGIN
  IF to_regclass(format('%I.%I',current_schema(),'mdf_physical_lineage_contracts')) IS NOT NULL THEN
    EXECUTE $fn$
CREATE OR REPLACE FUNCTION mdf_validate_physical_lineage_seal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  lineage_contract mdf_physical_lineage_contracts%ROWTYPE;
  source_origin TEXT;
  context_acceptance BOOLEAN;
  context_complete BOOLEAN;
  context_policy TEXT;
  context_predecessor_accepted TEXT;
  context_predecessor_received TEXT;
  current_head RECORD;
  parent_physical_count BIGINT;
BEGIN
  -- Serialize with the same parent-revision row lock used by evidence/context
  -- inserts before reading any lineage rows. Alphabetically this trigger runs
  -- before the historical seal guard, so it must acquire the lock itself.
  PERFORM 1 FROM mdf_evidence_revisions
    WHERE source_kind=NEW.source_kind AND source_id=NEW.source_id AND revision_key=NEW.revision_key
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MDF physical lineage revision is absent' USING ERRCODE='23503';
  END IF;

  SELECT * INTO lineage_contract FROM mdf_physical_lineage_contracts
  WHERE source_kind=NEW.source_kind AND source_id=NEW.source_id AND revision_key=NEW.revision_key;
  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT r.origin,c.acceptance_requested,c.composition_complete,c.effect_policy,
    c.predecessor_accepted_revision_key,c.predecessor_received_revision_key
    INTO source_origin,context_acceptance,context_complete,context_policy,
      context_predecessor_accepted,context_predecessor_received
  FROM mdf_evidence_revisions r
  JOIN mdf_revision_context c USING(source_kind,source_id,revision_key)
  WHERE r.source_kind=NEW.source_kind AND r.source_id=NEW.source_id AND r.revision_key=NEW.revision_key;
  IF NOT FOUND OR NOT context_acceptance OR NOT context_complete
    OR lineage_contract.source_kind NOT IN ('packet','bazisCutSet','bath') THEN
    RAISE EXCEPTION 'MDF physical lineage requires complete accepted context' USING ERRCODE='23514';
  END IF;
  IF context_predecessor_accepted IS DISTINCT FROM lineage_contract.predecessor_accepted_revision_key
    OR context_predecessor_received IS DISTINCT FROM lineage_contract.predecessor_accepted_revision_key THEN
    RAISE EXCEPTION 'MDF lineage contract and frozen context predecessor differ' USING ERRCODE='23514';
  END IF;
  IF lineage_contract.operation='correction' THEN
    IF source_origin<>'manual' OR context_policy<>'publish_only' THEN
      RAISE EXCEPTION 'MDF correction lineage requires manual publish-only receipt' USING ERRCODE='23514';
    END IF;
  ELSIF context_policy<>'forward' THEN
    RAISE EXCEPTION 'MDF non-correction lineage must be forward' USING ERRCODE='23514';
  END IF;
  IF lineage_contract.operation='production' AND (
    ((lineage_contract.production_authority='manual_production' AND source_origin='manual')
      OR (lineage_contract.production_authority='cnc_observation' AND source_origin='cnc'
        AND lineage_contract.source_kind='packet')) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'MDF physical production authority does not match receipt' USING ERRCODE='23514';
  END IF;
  IF lineage_contract.operation='carry' AND source_origin<>'manual' THEN
    RAISE EXCEPTION 'MDF carry lineage requires manual receipt' USING ERRCODE='23514';
  END IF;

  SELECT h.accepted_revision_key,h.received_revision_key INTO current_head
  FROM mdf_source_heads h WHERE h.source_kind=NEW.source_kind AND h.source_id=NEW.source_id;
  IF FOUND THEN
    IF current_head.accepted_revision_key IS DISTINCT FROM current_head.received_revision_key
      OR lineage_contract.predecessor_accepted_revision_key IS DISTINCT FROM current_head.accepted_revision_key THEN
      RAISE EXCEPTION 'MDF physical lineage predecessor is stale' USING ERRCODE='23514';
    END IF;
  ELSIF lineage_contract.predecessor_accepted_revision_key IS NOT NULL THEN
    RAISE EXCEPTION 'MDF initial physical lineage cannot name a predecessor' USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM mdf_evidence_lines e
    WHERE e.source_kind=NEW.source_kind AND e.source_id=NEW.source_id AND e.revision_key=NEW.revision_key
      AND NOT ((e.stage_code='membership' AND e.evidence_kind='derived')
        OR (NEW.source_kind IN ('order','orderDetail') AND e.evidence_kind='declaration'
          AND e.stage_code IN ('cut','laminated'))
        OR (NEW.source_kind='bath' AND e.evidence_kind IN ('physical','declaration')
          AND e.stage_code='laminated')
        OR (NEW.source_kind IN ('packet','bazisCutSet') AND e.evidence_kind IN ('physical','declaration')
          AND e.stage_code='cut'))
  ) THEN
    RAISE EXCEPTION 'MDF lineage receipt contains invalid stage/evidence meaning' USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM mdf_evidence_lines e
    WHERE e.source_kind=NEW.source_kind AND e.source_id=NEW.source_id AND e.revision_key=NEW.revision_key
      AND NOT EXISTS (
        SELECT 1 FROM mdf_revision_demand d
        WHERE d.source_kind=e.source_kind AND d.source_id=e.source_id AND d.revision_key=e.revision_key
          AND d.order_id=e.order_id AND d.detail_id=e.detail_id)
      -- §5.4e (migration 191): a position detached in this source is history only and may stay outside demand.
      AND NOT EXISTS (
        SELECT 1 FROM mdf_position_detachments x
        WHERE x.source_kind=e.source_kind AND x.source_id=e.source_id
          AND x.order_id=e.order_id AND x.detail_id=e.detail_id)
  ) THEN
    RAISE EXCEPTION 'MDF lineage evidence is outside frozen demand' USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM mdf_evidence_lines e
    LEFT JOIN mdf_physical_lineage_transitions t ON t.evidence_line_id=e.evidence_line_id
      AND t.source_kind=e.source_kind AND t.source_id=e.source_id AND t.revision_key=e.revision_key
    WHERE e.source_kind=NEW.source_kind AND e.source_id=NEW.source_id AND e.revision_key=NEW.revision_key
      AND ((e.evidence_kind='physical' AND t.evidence_line_id IS NULL)
        OR (e.evidence_kind<>'physical' AND t.evidence_line_id IS NOT NULL))
  ) THEN
    RAISE EXCEPTION 'MDF physical lineage must cover physical lines only' USING ERRCODE='23514';
  END IF;

  IF (lineage_contract.operation='production' AND (
      cardinality(lineage_contract.dropped_predecessor_evidence_line_ids)>0 OR EXISTS (
        SELECT 1 FROM mdf_physical_lineage_transitions WHERE source_kind=NEW.source_kind
          AND source_id=NEW.source_id AND revision_key=NEW.revision_key AND action='reduce')))
    OR (lineage_contract.operation='carry' AND (
      cardinality(lineage_contract.dropped_predecessor_evidence_line_ids)>0 OR EXISTS (
        SELECT 1 FROM mdf_physical_lineage_transitions WHERE source_kind=NEW.source_kind
          AND source_id=NEW.source_id AND revision_key=NEW.revision_key AND action<>'carry')))
    OR (lineage_contract.operation='correction' AND EXISTS (
        SELECT 1 FROM mdf_physical_lineage_transitions WHERE source_kind=NEW.source_kind
          AND source_id=NEW.source_id AND revision_key=NEW.revision_key AND action='root')) THEN
    RAISE EXCEPTION 'MDF physical lineage action is not allowed for operation' USING ERRCODE='23514';
  END IF;

  IF cardinality(lineage_contract.dropped_predecessor_evidence_line_ids)<>(
      SELECT count(DISTINCT d.dropped_id)::INTEGER
      FROM unnest(lineage_contract.dropped_predecessor_evidence_line_ids) AS d(dropped_id))
    OR lineage_contract.dropped_predecessor_evidence_line_ids IS DISTINCT FROM (
      SELECT COALESCE(array_agg(d.dropped_id ORDER BY d.dropped_id), ARRAY[]::UUID[])
      FROM (SELECT DISTINCT x.dropped_id FROM unnest(lineage_contract.dropped_predecessor_evidence_line_ids) AS x(dropped_id)) d)
    OR EXISTS (SELECT 1 FROM unnest(lineage_contract.dropped_predecessor_evidence_line_ids) AS d(dropped_id)
      WHERE d.dropped_id IS NULL)
  THEN
    RAISE EXCEPTION 'MDF physical lineage dropped predecessor IDs must be sorted and unique' USING ERRCODE='23514';
  END IF;

  IF lineage_contract.predecessor_accepted_revision_key IS NULL THEN
    IF EXISTS (SELECT 1 FROM mdf_physical_lineage_transitions WHERE source_kind=NEW.source_kind
      AND source_id=NEW.source_id AND revision_key=NEW.revision_key AND predecessor_evidence_line_id IS NOT NULL)
      OR cardinality(lineage_contract.dropped_predecessor_evidence_line_ids)>0 THEN
      RAISE EXCEPTION 'MDF initial lineage cannot carry predecessor evidence' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT accepted_revision_key,received_revision_key INTO current_head
      FROM mdf_source_heads WHERE source_kind=NEW.source_kind AND source_id=NEW.source_id;
    IF NOT FOUND OR current_head.accepted_revision_key IS DISTINCT FROM current_head.received_revision_key
      OR current_head.accepted_revision_key IS DISTINCT FROM lineage_contract.predecessor_accepted_revision_key THEN
      RAISE EXCEPTION 'MDF lineage receipt requires the exact stable accepted predecessor' USING ERRCODE='23514';
    END IF;
    SELECT count(*) INTO parent_physical_count FROM mdf_evidence_lines p
      WHERE p.source_kind=NEW.source_kind AND p.source_id=NEW.source_id
        AND p.revision_key=lineage_contract.predecessor_accepted_revision_key AND p.evidence_kind='physical';
    IF parent_physical_count>0 AND NOT EXISTS (
      SELECT 1 FROM mdf_physical_lineage_contracts pc WHERE pc.source_kind=NEW.source_kind
        AND pc.source_id=NEW.source_id AND pc.revision_key=lineage_contract.predecessor_accepted_revision_key) THEN
      RAISE EXCEPTION 'MDF legacy physical evidence cannot be promoted to lineage' USING ERRCODE='23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM mdf_evidence_lines p
      WHERE p.source_kind=NEW.source_kind AND p.source_id=NEW.source_id
        AND p.revision_key=lineage_contract.predecessor_accepted_revision_key AND p.evidence_kind='physical'
        AND (SELECT count(*) FROM mdf_physical_lineage_transitions t
          WHERE t.source_kind=NEW.source_kind AND t.source_id=NEW.source_id
            AND t.revision_key=NEW.revision_key AND t.predecessor_evidence_line_id=p.evidence_line_id)
          + CASE WHEN p.evidence_line_id=ANY(lineage_contract.dropped_predecessor_evidence_line_ids) THEN 1 ELSE 0 END <> 1
    ) OR EXISTS (
      SELECT 1 FROM unnest(lineage_contract.dropped_predecessor_evidence_line_ids) AS d(dropped_id)
      WHERE NOT EXISTS (SELECT 1 FROM mdf_evidence_lines p WHERE p.evidence_line_id=d.dropped_id
        AND p.source_kind=NEW.source_kind AND p.source_id=NEW.source_id
        AND p.revision_key=lineage_contract.predecessor_accepted_revision_key AND p.evidence_kind='physical')
    ) THEN
      RAISE EXCEPTION 'MDF physical predecessor must be carried, reduced, or explicitly dropped exactly once' USING ERRCODE='23514';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM mdf_physical_lineage_transitions t
    JOIN mdf_evidence_lines child ON child.evidence_line_id=t.evidence_line_id
    LEFT JOIN mdf_evidence_lines parent ON parent.evidence_line_id=t.predecessor_evidence_line_id
    LEFT JOIN mdf_physical_lineage_transitions parent_transition
      ON parent_transition.evidence_line_id=parent.evidence_line_id
    WHERE t.source_kind=NEW.source_kind AND t.source_id=NEW.source_id AND t.revision_key=NEW.revision_key
      AND (child.evidence_kind<>'physical' OR child.source_kind IS DISTINCT FROM t.source_kind
        OR child.source_id IS DISTINCT FROM t.source_id OR child.revision_key IS DISTINCT FROM t.revision_key)
  ) THEN
    RAISE EXCEPTION 'MDF lineage transition references non-physical child' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM mdf_physical_lineage_transitions t
    JOIN mdf_evidence_lines child ON child.evidence_line_id=t.evidence_line_id
    LEFT JOIN mdf_evidence_lines parent ON parent.evidence_line_id=t.predecessor_evidence_line_id
    LEFT JOIN mdf_physical_lineage_transitions parent_transition
      ON parent_transition.evidence_line_id=parent.evidence_line_id
    WHERE t.source_kind=NEW.source_kind AND t.source_id=NEW.source_id AND t.revision_key=NEW.revision_key
      AND ((t.action='root' AND (t.canonical_origin_evidence_line_id<>child.evidence_line_id
          OR t.predecessor_evidence_line_id IS NOT NULL))
        OR (t.action IN ('carry','reduce') AND (
          parent.evidence_line_id IS NULL OR parent.source_kind<>NEW.source_kind OR parent.source_id<>NEW.source_id
          OR parent.revision_key IS DISTINCT FROM lineage_contract.predecessor_accepted_revision_key
          OR parent.evidence_kind<>'physical' OR parent_transition.evidence_line_id IS NULL
          OR t.canonical_origin_evidence_line_id<>parent_transition.canonical_origin_evidence_line_id
          OR (child.order_id,child.detail_id,child.stage_code,child.evidence_kind,child.rework)
             IS DISTINCT FROM (parent.order_id,parent.detail_id,parent.stage_code,parent.evidence_kind,parent.rework)
          OR (t.action='carry' AND child.quantity<>parent.quantity)
          OR (t.action='reduce' AND child.quantity>=parent.quantity)
        ))
        OR (t.action='root' AND (child.stage_code<>(CASE WHEN NEW.source_kind='bath' THEN 'laminated' ELSE 'cut' END)
          OR child.evidence_kind<>'physical')))
  ) THEN
    RAISE EXCEPTION 'MDF physical lineage transition does not preserve exact predecessor identity' USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM mdf_evidence_lines m
    WHERE m.source_kind=NEW.source_kind AND m.source_id=NEW.source_id
      AND m.revision_key=NEW.revision_key AND m.stage_code='membership'
    GROUP BY m.order_id,m.detail_id,m.rework
    HAVING SUM(m.quantity)::NUMERIC>9007199254740991
  ) OR EXISTS (
    WITH members AS (
      SELECT order_id,detail_id,rework,SUM(quantity)::NUMERIC AS quantity
      FROM mdf_evidence_lines WHERE source_kind=NEW.source_kind AND source_id=NEW.source_id
        AND revision_key=NEW.revision_key AND stage_code='membership'
      GROUP BY order_id,detail_id,rework
    ), proof AS (
      SELECT e.order_id,e.detail_id,e.rework,
        SUM(e.quantity) FILTER (WHERE t.action IN ('carry','reduce'))::NUMERIC AS carried,
        SUM(e.quantity) FILTER (WHERE t.action='root')::NUMERIC AS roots,
        SUM(e.quantity)::NUMERIC AS total_physical
      FROM mdf_evidence_lines e JOIN mdf_physical_lineage_transitions t
        ON t.evidence_line_id=e.evidence_line_id
      WHERE e.source_kind=NEW.source_kind AND e.source_id=NEW.source_id
        AND e.revision_key=NEW.revision_key AND e.evidence_kind='physical'
      GROUP BY e.order_id,e.detail_id,e.rework
    )
    SELECT 1 FROM proof p LEFT JOIN members m USING(order_id,detail_id,rework)
    WHERE COALESCE(p.total_physical,0)>9007199254740991
      OR COALESCE(m.quantity,0)>9007199254740991
      OR (COALESCE(p.roots,0)>0 AND (m.quantity IS NULL
        OR COALESCE(p.roots,0)>GREATEST(m.quantity-COALESCE(p.carried,0),0)))
  ) THEN
    RAISE EXCEPTION 'MDF new physical roots exceed uncredited assignment capacity' USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$
$fn$;
  END IF;
END;
$do$;

COMMENT ON TABLE mdf_position_detachments IS
  'Terminal source-scoped detachment of an order position (confirmed order correction): lines of that source at the position are history only.';

COMMIT;
