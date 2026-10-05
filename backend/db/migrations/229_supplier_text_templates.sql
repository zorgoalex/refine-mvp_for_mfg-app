-- Шаблоны текста заявки поставщику (план spec_erp/plans/order_resource_req/2026-10-02-supplier-text-templates-plan.md,
-- plan review R3 APPROVED): общие для компании шаблоны «Скопировать текст для поставщика». Только добавление.
-- Сид «Стандартный» = прежний текст, он же по умолчанию. Команды (create/update/delete/default) сериализуются
-- advisory-блокировкой набора; индексы — страховка уникальности активного имени и единственного «по умолчанию».
BEGIN;

CREATE TABLE IF NOT EXISTS public.supplier_request_text_templates (
  template_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  line_template TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NULL REFERENCES public.users(user_id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NULL REFERENCES public.users(user_id),
  deleted_at TIMESTAMPTZ NULL,
  deleted_by BIGINT NULL REFERENCES public.users(user_id),
  CONSTRAINT chk_srtt_name CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT chk_srtt_body CHECK (char_length(body) BETWEEN 1 AND 4000),
  CONSTRAINT chk_srtt_line CHECK (char_length(line_template) BETWEEN 1 AND 500),
  CONSTRAINT chk_srtt_version CHECK (version >= 1),
  CONSTRAINT chk_srtt_deleted CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
  CONSTRAINT chk_srtt_deleted_not_default CHECK (deleted_at IS NULL OR NOT is_default)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_srtt_active_name
  ON public.supplier_request_text_templates (lower(btrim(name))) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_srtt_one_default
  ON public.supplier_request_text_templates ((true)) WHERE is_default AND deleted_at IS NULL;

INSERT INTO public.supplier_request_text_templates (name, body, line_template, is_default)
SELECT 'Стандартный',
       E'Заявка {номер} · {поставщик}\n{позиции}\nОжидаем к: {ожидаем_к}\n{комментарий}',
       '{материал} — {количество_с_единицей}',
       true
 WHERE NOT EXISTS (SELECT 1 FROM public.supplier_request_text_templates);

COMMENT ON TABLE public.supplier_request_text_templates IS
  'Шаблоны текста заявки поставщику («Скопировать текст для поставщика»); один активный — по умолчанию';

COMMIT;
