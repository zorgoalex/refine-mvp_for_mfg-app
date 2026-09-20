-- Additive, disabled by default. No remote writes or historical enrollment.
CREATE TABLE bitrix24_stage_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  member_id text REFERENCES bitrix24_app_installation(member_id),
  domain text,
  category_id integer CHECK (category_id >= 0),
  completed_status_id smallint REFERENCES order_statuses(order_status_id),
  enabled boolean NOT NULL DEFAULT false,
  binding_locked boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  epoch integer NOT NULL DEFAULT 1,
  updated_by bigint REFERENCES users(user_id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT enabled OR (member_id IS NOT NULL AND domain IS NOT NULL AND category_id IS NOT NULL AND completed_status_id IS NOT NULL))
);
INSERT INTO bitrix24_stage_config(singleton) VALUES (true);

CREATE TABLE bitrix24_stage_catalog (
  member_id text NOT NULL REFERENCES bitrix24_app_installation(member_id),
  category_id integer NOT NULL CHECK (category_id >= 0),
  category_name text NOT NULL,
  stages jsonb NOT NULL CHECK (jsonb_typeof(stages)='array'),
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(member_id, category_id)
);
CREATE TABLE bitrix24_stage_mapping (
  member_id text NOT NULL,
  category_id integer NOT NULL,
  order_status_id smallint NOT NULL REFERENCES order_statuses(order_status_id),
  stage_id text NOT NULL,
  updated_by bigint NOT NULL REFERENCES users(user_id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(member_id,category_id,order_status_id),
  FOREIGN KEY(member_id,category_id) REFERENCES bitrix24_stage_catalog(member_id,category_id)
);

-- A row is enrollment + coalesced desired work, not a history event.
CREATE TABLE bitrix24_stage_work (
  member_id text NOT NULL,
  category_id integer NOT NULL,
  order_id bigint NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  epoch integer NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  initialized boolean NOT NULL DEFAULT false,
  source_status_id smallint,
  applied_status_id smallint,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','processed','waiting_mapping','blocked','failed','cancelled')),
  bitrix_id text,
  observed_stage text,
  target_stage text,
  attempts integer NOT NULL DEFAULT 0,
  restore_count integer NOT NULL DEFAULT 0,
  restore_window timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  lock_token uuid,
  last_error text,
  approval jsonb,
  job_id uuid,
  actor_user_id bigint REFERENCES users(user_id),
  request_id text NOT NULL DEFAULT gen_random_uuid()::text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY(member_id,category_id,order_id),
  FOREIGN KEY(member_id,category_id) REFERENCES bitrix24_stage_catalog(member_id,category_id)
);
CREATE INDEX idx_bitrix24_stage_work_due ON bitrix24_stage_work(next_attempt_at,order_id)
  WHERE status IN ('pending','processing','waiting_mapping');

CREATE TABLE bitrix24_stage_job (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id text NOT NULL,
  category_id integer NOT NULL,
  epoch integer NOT NULL,
  config_version integer NOT NULL,
  kind text NOT NULL CHECK(kind IN ('settings','provision','reconcile')),
  payload jsonb NOT NULL,
  results jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id bigint NOT NULL REFERENCES users(user_id),
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
  FOREIGN KEY(member_id,category_id) REFERENCES bitrix24_stage_catalog(member_id,category_id)
);
-- Durable dispatch receipt. Survives crash after HTTP and before local finalize.
CREATE TABLE bitrix24_stage_attempt (
  attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id text NOT NULL,
  category_id integer NOT NULL,
  order_id bigint NOT NULL,
  epoch integer NOT NULL,
  revision bigint NOT NULL,
  config_version integer NOT NULL,
  bitrix_id text NOT NULL,
  before_stage text NOT NULL,
  target_stage text NOT NULL,
  state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','verified','uncertain')),
  actor_user_id bigint,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz
);
CREATE INDEX idx_bitrix24_stage_attempt_order ON bitrix24_stage_attempt(member_id,category_id,order_id,created_at DESC);

CREATE FUNCTION bitrix24_stage_enqueue(p_order_id bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c bitrix24_stage_config; s smallint; a bigint;
BEGIN
  SELECT * INTO c FROM bitrix24_stage_config WHERE singleton AND enabled;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT order_status_id,edited_by INTO s,a FROM orders
    WHERE order_id=p_order_id AND order_kind='production_order' AND NOT delete_flag;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO bitrix24_stage_work(member_id,category_id,order_id,epoch,source_status_id,actor_user_id)
  VALUES(c.member_id,c.category_id,p_order_id,c.epoch,s,a)
  ON CONFLICT(member_id,category_id,order_id) DO UPDATE SET
    epoch=EXCLUDED.epoch, revision=bitrix24_stage_work.revision+1,
    initialized=CASE WHEN bitrix24_stage_work.epoch=EXCLUDED.epoch THEN bitrix24_stage_work.initialized ELSE false END,
    applied_status_id=CASE WHEN bitrix24_stage_work.epoch=EXCLUDED.epoch THEN bitrix24_stage_work.applied_status_id ELSE NULL END,
    status=CASE WHEN bitrix24_stage_work.status='processing' AND bitrix24_stage_work.epoch=EXCLUDED.epoch THEN 'processing' ELSE 'pending' END,
    restore_count=CASE WHEN bitrix24_stage_work.source_status_id IS DISTINCT FROM EXCLUDED.source_status_id OR bitrix24_stage_work.epoch<>EXCLUDED.epoch THEN 0 ELSE bitrix24_stage_work.restore_count END,
    restore_window=CASE WHEN bitrix24_stage_work.source_status_id IS DISTINCT FROM EXCLUDED.source_status_id THEN NULL ELSE bitrix24_stage_work.restore_window END,
    source_status_id=EXCLUDED.source_status_id, actor_user_id=EXCLUDED.actor_user_id,
    approval=NULL, job_id=NULL, attempts=0, last_error=NULL, next_attempt_at=now(),updated_at=now(),request_id=gen_random_uuid()::text;
END $$;

CREATE FUNCTION bitrix24_stage_order_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Do not suppress conversion under app.crm_sync_origin=bitrix24. Only committed
  -- production status/kind/restoration transitions invalidate stage work.
  IF TG_OP='INSERT' THEN
    PERFORM bitrix24_stage_enqueue(NEW.order_id);
  ELSIF NEW.order_status_id IS DISTINCT FROM OLD.order_status_id
      OR NEW.order_kind IS DISTINCT FROM OLD.order_kind
      OR NEW.delete_flag IS DISTINCT FROM OLD.delete_flag THEN
    PERFORM bitrix24_stage_enqueue(NEW.order_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_bitrix24_stage_order_changed AFTER INSERT OR UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION bitrix24_stage_order_changed();

CREATE FUNCTION bitrix24_stage_mapping_available() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.entity_type='order' AND NEW.bitrix_object='deal' AND NEW.bitrix_id IS NOT NULL AND NEW.status='active' THEN
    UPDATE bitrix24_stage_work w SET status='pending',next_attempt_at=now(),updated_at=now()
      FROM bitrix24_stage_config c
      WHERE c.enabled AND w.member_id=c.member_id AND w.category_id=c.category_id AND w.epoch=c.epoch
        AND w.order_id::text=NEW.erp_id AND w.status='waiting_mapping';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_bitrix24_stage_mapping_available AFTER INSERT OR UPDATE ON crm_sync_mapping
  FOR EACH ROW EXECUTE FUNCTION bitrix24_stage_mapping_available();

-- No Hasura permissions or notification-engine outbox subscriptions added.
