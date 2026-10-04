-- Личные шаблоны текста заявки поставщику (план spec_erp/plans/order_resource_req/2026-10-04-personal-supplier-text-templates-plan.md):
-- у каждого пользователя свои шаблоны и свой выбор «по умолчанию». Только добавление: общая таблица (229) не меняется,
-- поэтому прежняя версия backend личные шаблоны не видит и не может показать их другим пользователям.
-- Номера личных шаблонов — из той же последовательности, что у общих: templateId уникален в обоих наборах.
BEGIN;

DO $$
DECLARE
  seq TEXT := pg_get_serial_sequence('public.supplier_request_text_templates', 'template_id');
BEGIN
  IF seq IS NULL THEN
    RAISE EXCEPTION 'supplier_request_text_templates.template_id has no sequence (migration 229 missing?)';
  END IF;
  EXECUTE format($sql$
    CREATE TABLE IF NOT EXISTS public.supplier_request_user_text_templates (
      template_id BIGINT PRIMARY KEY DEFAULT nextval(%L::regclass),
      owner_user_id BIGINT NOT NULL REFERENCES public.users(user_id),
      name TEXT NOT NULL,
      body TEXT NOT NULL,
      line_template TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by BIGINT NULL REFERENCES public.users(user_id),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by BIGINT NULL REFERENCES public.users(user_id),
      deleted_at TIMESTAMPTZ NULL,
      deleted_by BIGINT NULL REFERENCES public.users(user_id),
      CONSTRAINT chk_srutt_name CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
      CONSTRAINT chk_srutt_body CHECK (char_length(body) BETWEEN 1 AND 4000),
      CONSTRAINT chk_srutt_line CHECK (char_length(line_template) BETWEEN 1 AND 500),
      CONSTRAINT chk_srutt_version CHECK (version >= 1),
      CONSTRAINT chk_srutt_deleted CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
      -- Цель составного внешнего ключа таблицы выбора: выбрать можно только шаблон этого же владельца.
      CONSTRAINT uq_srutt_template_owner UNIQUE (template_id, owner_user_id)
    )$sql$, seq);
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_srutt_owner_active_name
  ON public.supplier_request_user_text_templates (owner_user_id, lower(btrim(name))) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_srutt_owner
  ON public.supplier_request_user_text_templates (owner_user_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.supplier_request_text_template_defaults (
  user_id BIGINT PRIMARY KEY REFERENCES public.users(user_id),
  shared_template_id BIGINT NULL REFERENCES public.supplier_request_text_templates(template_id),
  own_template_id BIGINT NULL,
  -- Ревизия личного выбора: растёт при каждой смене (выбор, возврат к общему, удаление выбранного шаблона) и не
  -- сбрасывается — строка не удаляется, при возврате к общему правилу обе цели пусты. Нет строки = ревизия 0.
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_srttd_one_target CHECK (num_nonnulls(shared_template_id, own_template_id) <= 1),
  CONSTRAINT chk_srttd_revision CHECK (revision >= 1),
  CONSTRAINT fk_srttd_own_template FOREIGN KEY (own_template_id, user_id)
    REFERENCES public.supplier_request_user_text_templates (template_id, owner_user_id)
);

COMMENT ON TABLE public.supplier_request_user_text_templates IS
  'Личные шаблоны текста заявки поставщику: видит и меняет только владелец';
COMMENT ON TABLE public.supplier_request_text_template_defaults IS
  'Личный выбор шаблона по умолчанию (общий или свой) и его ревизия; нет строки или целей — действует общий шаблон по умолчанию';

COMMIT;
