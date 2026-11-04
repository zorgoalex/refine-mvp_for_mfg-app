-- Persist canonical physical proof lineage for explicitly opted-in v2 receipts.
-- No producer is switched to this contract by this migration.
BEGIN;

DO $$
DECLARE
BEGIN
  IF to_regclass(format('%I.%I', current_schema(), 'mdf_evidence_revisions')) IS NULL
    OR to_regclass(format('%I.%I', current_schema(), 'mdf_revision_context')) IS NULL
    OR to_regclass(format('%I.%I', current_schema(), 'mdf_revision_seals')) IS NULL
    OR to_regclass(format('%I.%I', current_schema(), 'mdf_source_heads')) IS NULL
    OR to_regclass(format('%I.%I', current_schema(), 'mdf_evidence_lines')) IS NULL THEN
    RAISE EXCEPTION 'MDF migration 182 requires local receipt, context, seal, head, and evidence-line tables in schema %', current_schema();
  END IF;
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('mdf_revision_context','effect_policy'),
      ('mdf_revision_context','acceptance_requested'),
      ('mdf_revision_context','composition_complete'),
      ('mdf_revision_context','predecessor_accepted_revision_key'),
      ('mdf_revision_context','predecessor_received_revision_key'),
      ('mdf_revision_demand','source_kind'),('mdf_revision_demand','source_id'),
      ('mdf_revision_demand','revision_key'),('mdf_revision_demand','order_id'),
      ('mdf_revision_demand','detail_id'),('mdf_revision_demand','quantity'),
      ('mdf_evidence_revisions','origin'),('mdf_evidence_lines','evidence_line_id'),
      ('mdf_evidence_lines','line_key'),('mdf_evidence_lines','order_id'),
      ('mdf_evidence_lines','detail_id'),('mdf_evidence_lines','quantity'),
      ('mdf_evidence_lines','stage_code'),('mdf_evidence_lines','evidence_kind'),
      ('mdf_evidence_lines','rework'),('mdf_source_heads','accepted_revision_key'),
      ('mdf_source_heads','received_revision_key')) AS required(table_name,column_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid=to_regclass(format('%I.%I',current_schema(),required.table_name))
        AND a.attname=required.column_name AND a.attnum>0 AND NOT a.attisdropped
    )
  ) THEN
    RAISE EXCEPTION 'MDF migration 182 requires execution-context and frozen-demand columns from migrations 174 and 178 in schema %', current_schema();
  END IF;
  -- These guards preserve the append-only source/context contract that v2
  -- relies on; do not silently install 182 over partially migrated tables.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname=current_schema() AND r.relname='mdf_source_heads'
      AND t.tgname='mdf_source_fence_guard' AND t.tgenabled='O' AND NOT t.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname=current_schema() AND r.relname='mdf_revision_context'
      AND t.tgname='mdf_context_immutable' AND t.tgenabled='O' AND NOT t.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname=current_schema() AND r.relname='mdf_revision_demand'
      AND t.tgname='mdf_demand_immutable' AND t.tgenabled='O' AND NOT t.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname=current_schema() AND r.relname='mdf_source_heads'
      AND t.tgname='mdf_accepted_revision_guard' AND t.tgenabled='O' AND NOT t.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname=current_schema() AND r.relname='mdf_recalculation_jobs'
      AND t.tgname='mdf_job_effect_policy_binding' AND t.tgenabled='O' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'MDF migration 182 requires enabled local source, immutable-context, and effect-policy guards';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS mdf_physical_lineage_contracts (
  source_kind TEXT NOT NULL CHECK (source_kind IN ('packet','bazisCutSet','bath')),
  source_id TEXT NOT NULL CHECK (length(btrim(source_id)) BETWEEN 1 AND 240),
  revision_key TEXT NOT NULL CHECK (length(btrim(revision_key)) BETWEEN 1 AND 240),
  operation TEXT NOT NULL CHECK (operation IN ('production','carry','correction')),
  production_authority TEXT CHECK (production_authority IN ('manual_production','cnc_observation')),
  predecessor_accepted_revision_key TEXT,
  manifest_digest TEXT NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  dropped_predecessor_evidence_line_ids UUID[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(source_kind,source_id,revision_key),
  FOREIGN KEY(source_kind,source_id,revision_key)
    REFERENCES mdf_revision_context(source_kind,source_id,revision_key) ON DELETE RESTRICT,
  FOREIGN KEY(source_kind,source_id,predecessor_accepted_revision_key)
    REFERENCES mdf_revision_seals(source_kind,source_id,revision_key) ON DELETE RESTRICT,
  CONSTRAINT chk_mdf_physical_lineage_authority CHECK (
    (operation='production' AND production_authority IS NOT NULL
      AND production_authority IN ('manual_production','cnc_observation'))
    OR (operation IN ('carry','correction') AND production_authority IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS mdf_physical_lineage_transitions (
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  revision_key TEXT NOT NULL,
  evidence_line_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('root','carry','reduce')),
  predecessor_evidence_line_id UUID,
  canonical_origin_evidence_line_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(evidence_line_id),
  UNIQUE(source_kind,source_id,revision_key,canonical_origin_evidence_line_id),
  UNIQUE(source_kind,source_id,revision_key,predecessor_evidence_line_id),
  FOREIGN KEY(source_kind,source_id,revision_key)
    REFERENCES mdf_physical_lineage_contracts(source_kind,source_id,revision_key) ON DELETE RESTRICT,
  FOREIGN KEY(evidence_line_id) REFERENCES mdf_evidence_lines(evidence_line_id) ON DELETE RESTRICT,
  FOREIGN KEY(predecessor_evidence_line_id) REFERENCES mdf_evidence_lines(evidence_line_id) ON DELETE RESTRICT,
  FOREIGN KEY(canonical_origin_evidence_line_id) REFERENCES mdf_evidence_lines(evidence_line_id) ON DELETE RESTRICT,
  CONSTRAINT chk_mdf_physical_lineage_transition_parent CHECK (
    (action='root' AND predecessor_evidence_line_id IS NULL)
    OR (action IN ('carry','reduce') AND predecessor_evidence_line_id IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION mdf_guard_physical_lineage_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM mdf_evidence_revisions
    WHERE source_kind=NEW.source_kind AND source_id=NEW.source_id AND revision_key=NEW.revision_key
    FOR UPDATE;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM mdf_revision_seals
      WHERE source_kind=NEW.source_kind AND source_id=NEW.source_id AND revision_key=NEW.revision_key) THEN
    RAISE EXCEPTION 'MDF physical lineage revision is absent or sealed' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION mdf_guard_physical_lineage_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'MDF physical lineage is append-only' USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS mdf_physical_lineage_contract_insert_guard ON mdf_physical_lineage_contracts;
CREATE TRIGGER mdf_physical_lineage_contract_insert_guard BEFORE INSERT ON mdf_physical_lineage_contracts
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_physical_lineage_insert();
DROP TRIGGER IF EXISTS mdf_physical_lineage_transition_insert_guard ON mdf_physical_lineage_transitions;
CREATE TRIGGER mdf_physical_lineage_transition_insert_guard BEFORE INSERT ON mdf_physical_lineage_transitions
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_physical_lineage_insert();
DROP TRIGGER IF EXISTS mdf_physical_lineage_contract_immutable ON mdf_physical_lineage_contracts;
CREATE TRIGGER mdf_physical_lineage_contract_immutable BEFORE UPDATE OR DELETE ON mdf_physical_lineage_contracts
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_physical_lineage_immutable();
DROP TRIGGER IF EXISTS mdf_physical_lineage_transition_immutable ON mdf_physical_lineage_transitions;
CREATE TRIGGER mdf_physical_lineage_transition_immutable BEFORE UPDATE OR DELETE ON mdf_physical_lineage_transitions
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_physical_lineage_immutable();

-- Final validation runs at seal time, after current lines/contract/transitions
-- have been inserted, and while recordMdfReceipt still owns the source head.
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
$$;

DROP TRIGGER IF EXISTS mdf_physical_lineage_seal_guard ON mdf_revision_seals;
CREATE TRIGGER mdf_physical_lineage_seal_guard BEFORE INSERT ON mdf_revision_seals
  FOR EACH ROW EXECUTE FUNCTION mdf_validate_physical_lineage_seal();

CREATE OR REPLACE FUNCTION mdf_guard_physical_lineage_source_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_received_is_v2 BOOLEAN := false;
DECLARE new_received_predecessor TEXT;
DECLARE new_received_is_v2 BOOLEAN := false;
BEGIN
  IF TG_OP='INSERT' THEN
    IF EXISTS (SELECT 1 FROM mdf_physical_lineage_contracts c
      WHERE c.source_kind=NEW.source_kind AND c.source_id=NEW.source_id)
      AND NOT EXISTS (SELECT 1 FROM mdf_physical_lineage_contracts c
        WHERE c.source_kind=NEW.source_kind AND c.source_id=NEW.source_id
          AND c.revision_key=NEW.received_revision_key) THEN
      RAISE EXCEPTION 'MDF lineage-v2 source requires lineage-v2 receipts' USING ERRCODE='23514';
    END IF;
    SELECT c.predecessor_accepted_revision_key INTO new_received_predecessor
      FROM mdf_physical_lineage_contracts c WHERE c.source_kind=NEW.source_kind
        AND c.source_id=NEW.source_id AND c.revision_key=NEW.received_revision_key;
    new_received_is_v2 := FOUND;
    IF new_received_is_v2 AND new_received_predecessor IS NOT NULL THEN
      RAISE EXCEPTION 'MDF initial lineage receipt cannot name a prior accepted revision' USING ERRCODE='23514';
    END IF;
    IF new_received_is_v2 AND NEW.accepted_revision_key IS NOT NULL
      AND NEW.accepted_revision_key IS DISTINCT FROM NEW.received_revision_key THEN
      RAISE EXCEPTION 'MDF initial lineage acceptance must point to its received revision' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT EXISTS (SELECT 1 FROM mdf_physical_lineage_contracts c
    WHERE c.source_kind=OLD.source_kind AND c.source_id=OLD.source_id
      AND c.revision_key=OLD.received_revision_key) INTO old_received_is_v2;
  SELECT c.predecessor_accepted_revision_key INTO new_received_predecessor
    FROM mdf_physical_lineage_contracts c WHERE c.source_kind=NEW.source_kind
      AND c.source_id=NEW.source_id AND c.revision_key=NEW.received_revision_key;
  new_received_is_v2 := FOUND;

  IF old_received_is_v2 AND NOT new_received_is_v2 THEN
    RAISE EXCEPTION 'MDF lineage-v2 source requires lineage-v2 receipts' USING ERRCODE='23514';
  END IF;
  IF (old_received_is_v2 OR new_received_is_v2)
    AND NEW.received_revision_key IS DISTINCT FROM OLD.received_revision_key
    AND OLD.accepted_revision_key IS DISTINCT FROM OLD.received_revision_key THEN
    RAISE EXCEPTION 'MDF received lineage cannot advance while its predecessor is pending' USING ERRCODE='23514';
  END IF;
  IF new_received_is_v2 AND (
      NEW.received_revision_key IS DISTINCT FROM OLD.received_revision_key
      OR NEW.accepted_revision_key IS DISTINCT FROM OLD.accepted_revision_key)
    AND new_received_predecessor IS DISTINCT FROM OLD.accepted_revision_key THEN
    RAISE EXCEPTION 'MDF lineage receipt predecessor differs from accepted head' USING ERRCODE='23514';
  END IF;
  IF (old_received_is_v2 OR new_received_is_v2)
    AND NEW.accepted_revision_key IS DISTINCT FROM OLD.accepted_revision_key
    AND NEW.accepted_revision_key IS DISTINCT FROM NEW.received_revision_key THEN
    RAISE EXCEPTION 'MDF lineage acceptance must point to the received revision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mdf_physical_lineage_source_head_guard ON mdf_source_heads;
CREATE TRIGGER mdf_physical_lineage_source_head_guard BEFORE INSERT OR UPDATE ON mdf_source_heads
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_physical_lineage_source_head();

COMMENT ON TABLE mdf_physical_lineage_contracts IS
  'Immutable v2 lineage manifest sealed with an MDF revision; does not backfill or promote v1 physical evidence.';
COMMENT ON TABLE mdf_physical_lineage_transitions IS
  'Immutable per-physical-line root/carry/reduce identity; canonical roots are database-derived.';

COMMIT;
