-- Universal message signals; 172 belongs to paid-request conversion.
BEGIN;
CREATE TABLE message_processing_configuration (
  id boolean PRIMARY KEY DEFAULT true CHECK(id), version integer NOT NULL DEFAULT 1,
  document jsonb NOT NULL DEFAULT '{"sources":[],"signals":[],"resolvers":[],"rules":[]}',
  source_activation jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO message_processing_configuration(id) VALUES(true);
-- Receipts contain no message content and survive retention, preventing replay.
CREATE TABLE inbound_message_receipts (
  message_key text PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE inbound_messages (
  id bigserial PRIMARY KEY, message_key text NOT NULL UNIQUE REFERENCES inbound_message_receipts(message_key),
  channel text NOT NULL, source_code text NOT NULL, source_name text NOT NULL,
  sender text NOT NULL, message_text text NOT NULL, sent_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '90 days',
  config_version integer NOT NULL, request_id text NOT NULL,
  matched boolean NOT NULL
);
CREATE INDEX inbound_messages_received_idx ON inbound_messages(received_at DESC,id DESC);
CREATE INDEX inbound_messages_expiry_idx ON inbound_messages(expires_at);
CREATE TABLE inbound_signal_occurrences (
  id bigserial PRIMARY KEY, message_id bigint NOT NULL REFERENCES inbound_messages(id) ON DELETE CASCADE,
  signal_code text NOT NULL, signal_name text NOT NULL, rule_codes jsonb NOT NULL,
  order_id bigint REFERENCES orders(order_id), version integer NOT NULL DEFAULT 1,
  state text NOT NULL CHECK(state IN ('needs_review','pending','processing','retry_wait','succeeded','no_action','failed','dismissed')),
  reason_code text, execution_guard text, attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), locked_at timestamptz, lock_token uuid,
  processing_request_id text NOT NULL, resolved_by bigint REFERENCES users(user_id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz, UNIQUE(message_id,signal_code)
);
CREATE INDEX inbound_signals_queue_idx ON inbound_signal_occurrences(state,next_attempt_at,id);
CREATE INDEX inbound_signals_order_idx ON inbound_signal_occurrences(order_id,id DESC);
CREATE TABLE inbound_signal_steps (
  id bigserial PRIMARY KEY, signal_id bigint NOT NULL REFERENCES inbound_signal_occurrences(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL DEFAULT now(), event_code text NOT NULL,
  actor_user_id bigint REFERENCES users(user_id), details jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE inbound_signal_commands (
  idempotency_key text PRIMARY KEY, actor_user_id bigint NOT NULL REFERENCES users(user_id),
  request_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO permissions_catalog(permission_name,domain,label,description,sort_order,is_dangerous,is_active)
VALUES
 ('message_signals.view','integrations','Входящие сигналы: просмотр','История в пределах доступных заказов',192,false,true),
 ('message_signals.resolve','integrations','Входящие сигналы: разбор','Общая очередь, привязка и повтор обработки',193,true,true),
 ('message_signals.technical','integrations','Входящие сигналы: диагностика','Технические сведения без секретов',194,false,true),
 ('message_signals.manage_config','integrations','Обработка сообщений: настройка','Источники, сигналы, правила и шаблоны',195,true,true);
INSERT INTO role_permissions(role_id,permission_name,is_enabled)
SELECT r.role_id,p.permission_name,true FROM roles r CROSS JOIN permissions_catalog p
WHERE p.permission_name LIKE 'message_signals.%' AND
 (r.role_code IN ('superadmin','admin')
 OR r.role_code='top_manager' AND p.permission_name IN ('message_signals.view','message_signals.resolve')
 OR r.role_code='manager' AND p.permission_name='message_signals.view')
ON CONFLICT DO NOTHING;
UPDATE permissions_state SET version=version+1,updated_at=now() WHERE id=true;
COMMIT;
