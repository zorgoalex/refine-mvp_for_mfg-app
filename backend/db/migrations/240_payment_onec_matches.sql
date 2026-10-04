-- Сверка поступлений 1С от покупателей с платежами заказов ERP
-- (план spec_erp/plans/1c-agent/2026-10-04-onec-incoming-payments-plan.md, §4). Только добавление: новые таблицы и
-- права; существующие таблицы и данные не меняются. В срезе A таблицы остаются пустыми (только чтение).
BEGIN;

-- Ручные исключения связи «заказ 1С ↔ заказ ERP». Правило по серии номера — в коде, не хранится.
-- order_id NULL = «этот заказ 1С к ERP не относится» (запрет правила).
CREATE TABLE IF NOT EXISTS public.order_onec_order_links (
  link_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id BIGINT NOT NULL REFERENCES public.onec_sources(source_id),
  onec_order_ref_key UUID NOT NULL,
  order_id BIGINT NULL REFERENCES public.orders(order_id) ON DELETE CASCADE,
  note TEXT NULL,
  created_by BIGINT NOT NULL REFERENCES public.users(user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_by BIGINT NULL REFERENCES public.users(user_id),
  removed_at TIMESTAMPTZ NULL,
  CONSTRAINT chk_ooo_links_removed CHECK ((removed_at IS NULL) = (removed_by IS NULL)),
  CONSTRAINT chk_ooo_links_note CHECK (note IS NULL OR char_length(note) <= 500)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ooo_links_onec
  ON public.order_onec_order_links (source_id, onec_order_ref_key) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ooo_links_order
  ON public.order_onec_order_links (order_id) WHERE removed_at IS NULL AND order_id IS NOT NULL;

-- Сверка строки поступления 1С с платежом ERP (1:1) либо «разобрано без связи». Строки не удаляются:
-- снятие — removed_at. Принадлежность и реквизиты на момент сверки хранятся как точка сравнения для «изменилось».
CREATE TABLE IF NOT EXISTS public.payment_onec_matches (
  match_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  onec_document_line_id BIGINT NOT NULL REFERENCES public.onec_document_lines(onec_document_line_id),
  kind VARCHAR(12) NOT NULL,
  origin VARCHAR(8) NOT NULL,
  -- FK обнуляется при физическом удалении платежа; исторический id остаётся в payment_id_at_match.
  payment_id BIGINT NULL REFERENCES public.payments(payment_id) ON DELETE SET NULL,
  payment_id_at_match BIGINT NULL,
  order_id_at_match BIGINT NULL,
  source_id BIGINT NOT NULL REFERENCES public.onec_sources(source_id),
  onec_order_ref_key UUID NULL,
  onec_amount NUMERIC(14,2) NOT NULL,
  onec_currency CHAR(3) NULL,
  onec_doc_date DATE NOT NULL,
  payment_amount NUMERIC(12,2) NULL,
  payment_date DATE NULL,
  note TEXT NULL,
  review_seq INTEGER NOT NULL DEFAULT 0,
  changed_fingerprint TEXT NULL,
  created_by BIGINT NOT NULL REFERENCES public.users(user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_by BIGINT NULL REFERENCES public.users(user_id),
  removed_at TIMESTAMPTZ NULL,
  removed_reason VARCHAR(32) NULL,
  CONSTRAINT chk_pom_kind CHECK (kind IN ('matched', 'dismissed')),
  CONSTRAINT chk_pom_origin CHECK (origin IN ('auto', 'manual', 'created')),
  CONSTRAINT chk_pom_matched_fields CHECK ((kind = 'matched') = (payment_id_at_match IS NOT NULL
    AND payment_amount IS NOT NULL AND payment_date IS NOT NULL AND order_id_at_match IS NOT NULL)),
  -- Активная сверка держит платёж: его физическое удаление (SET NULL) нарушит ограничение и будет отклонено.
  CONSTRAINT chk_pom_active_payment CHECK (removed_at IS NOT NULL OR kind <> 'matched' OR payment_id IS NOT NULL),
  CONSTRAINT chk_pom_dismissed CHECK (kind <> 'dismissed' OR (origin = 'manual' AND note IS NOT NULL)),
  CONSTRAINT chk_pom_removed CHECK ((removed_at IS NULL) = (removed_by IS NULL)),
  CONSTRAINT chk_pom_note CHECK (note IS NULL OR char_length(note) <= 500)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pom_line
  ON public.payment_onec_matches (onec_document_line_id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pom_payment
  ON public.payment_onec_matches (payment_id) WHERE removed_at IS NULL AND payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pom_line_all ON public.payment_onec_matches (onec_document_line_id);

-- Реестр команд «создать платёж из 1С»: идемпотентность переживает снятие сверки и удаление платежа.
CREATE TABLE IF NOT EXISTS public.payment_onec_commands (
  idempotency_key UUID PRIMARY KEY,
  request_fingerprint TEXT NOT NULL,
  onec_document_line_id BIGINT NOT NULL REFERENCES public.onec_document_lines(onec_document_line_id),
  payment_id BIGINT NOT NULL,
  match_id BIGINT NOT NULL REFERENCES public.payment_onec_matches(match_id),
  created_by BIGINT NOT NULL REFERENCES public.users(user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Подсказка типа оплаты по счёту/кассе 1С (на сверку не влияет).
CREATE TABLE IF NOT EXISTS public.onec_account_payment_types (
  source_id BIGINT NOT NULL REFERENCES public.onec_sources(source_id),
  account_kind VARCHAR(8) NOT NULL,
  account_ref_key UUID NOT NULL,
  type_paid_id SMALLINT NOT NULL REFERENCES public.payment_types(type_paid_id),
  updated_by BIGINT NOT NULL REFERENCES public.users(user_id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_onec_account_payment_types PRIMARY KEY (source_id, account_kind, account_ref_key),
  CONSTRAINT chk_oapt_kind CHECK (account_kind IN ('bank', 'cash'))
);

-- Права. Каталог — добавление; ролям — только тем, у кого уже включены базовые права, и без перезаписи
-- существующих строк (runtime-настройки ролей сохраняются).
INSERT INTO public.permissions_catalog
  (permission_name, domain, label, description, sort_order, is_dangerous, is_active)
VALUES
  ('payments.onec.view', 'payments', 'Поступления 1С: просмотр',
   'Вкладка «Поступления 1С» на экране «Платежи»: поступления и возвраты 1С и состояние их сверки с платежами заказов', 26, false, true),
  ('payments.onec.manage', 'payments', 'Поступления 1С: сверка',
   'Сверка поступлений 1С с платежами заказов, создание платежа по поступлению, ручная связь заказа 1С с заказом', 27, true, true)
ON CONFLICT (permission_name) DO UPDATE SET
  domain = EXCLUDED.domain, label = EXCLUDED.label, description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order, is_dangerous = EXCLUDED.is_dangerous, is_active = true, updated_at = now();

INSERT INTO public.role_permissions (role_id, permission_name, is_enabled)
SELECT rp.role_id, 'payments.onec.view', true
  FROM public.role_permissions rp
  JOIN public.role_permissions pv ON pv.role_id = rp.role_id AND pv.permission_name = 'payments.view' AND pv.is_enabled
 WHERE rp.permission_name = 'finance.view' AND rp.is_enabled
ON CONFLICT (role_id, permission_name) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_name, is_enabled)
SELECT rp.role_id, 'payments.onec.manage', true
  FROM public.role_permissions rp
  JOIN public.role_permissions pv ON pv.role_id = rp.role_id AND pv.permission_name = 'payments.view' AND pv.is_enabled
  JOIN public.role_permissions pc ON pc.role_id = rp.role_id AND pc.permission_name = 'payments.create' AND pc.is_enabled
  JOIN public.role_permissions pu ON pu.role_id = rp.role_id AND pu.permission_name = 'payments.update' AND pu.is_enabled
 WHERE rp.permission_name = 'finance.view' AND rp.is_enabled
ON CONFLICT (role_id, permission_name) DO NOTHING;

UPDATE public.permissions_state SET version = version + 1, updated_at = now() WHERE id = true;

COMMIT;
