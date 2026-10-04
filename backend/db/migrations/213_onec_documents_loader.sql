-- Загрузчик документов 1С (модуль onec-sync) — план
-- spec_erp/plans/order_resource_req/2026-09-30-onec-documents-loader-plan.md (plan review R4 APPROVED, согласован с
-- сессией закупок). Только аддитивно: колонки состояния загрузки в onec_documents* (197), таблица проходов,
-- соответствие валют 1С. Писатель onec_documents / onec_document_lines — модуль onec-sync.

ALTER TABLE public.onec_documents
  ADD COLUMN IF NOT EXISTS observed_fingerprint TEXT NULL,
  ADD COLUMN IF NOT EXISTS applied_fingerprint TEXT NULL,
  ADD COLUMN IF NOT EXISTS applied_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS load_conflict JSONB NULL,
  ADD COLUMN IF NOT EXISTS missing_in_source_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS mapping_issue TEXT NULL;

ALTER TABLE public.onec_document_lines
  ADD COLUMN IF NOT EXISTS removed_in_onec_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS load_conflict_code TEXT NULL,
  ADD COLUMN IF NOT EXISTS mapping_issue TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_onec_documents_revision') THEN
    ALTER TABLE public.onec_documents ADD CONSTRAINT chk_onec_documents_revision CHECK (applied_revision >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_onec_document_lines_conflict_code') THEN
    ALTER TABLE public.onec_document_lines ADD CONSTRAINT chk_onec_document_lines_conflict_code CHECK (
      load_conflict_code IS NULL OR load_conflict_code IN
        ('QUANTITY_BELOW_ALLOCATED', 'REMOVED_WITH_ALLOCATION', 'MATERIAL_CHANGED', 'UNIT_CHANGED', 'AMOUNT_BELOW_ALLOCATED'));
  END IF;
END $$;

-- Состояние проходов загрузчика по (источник, вид документа): номер прохода выделяется отдельной транзакцией до
-- загрузки; итог и алерт пишет только проход с номером больше finished_seq.
CREATE TABLE IF NOT EXISTS public.onec_documents_load_state (
  source_id BIGINT NOT NULL REFERENCES public.onec_sources(source_id),
  entity_code TEXT NOT NULL,
  last_seq BIGINT NOT NULL DEFAULT 0,
  finished_seq BIGINT NOT NULL DEFAULT 0,
  last_outcome TEXT NULL,
  last_error_code TEXT NULL,
  last_result JSONB NULL,
  finished_at TIMESTAMPTZ NULL,
  CONSTRAINT pk_onec_documents_load_state PRIMARY KEY (source_id, entity_code),
  CONSTRAINT chk_onec_documents_load_seq CHECK (finished_seq >= 0 AND finished_seq <= last_seq),
  CONSTRAINT chk_onec_documents_load_outcome CHECK (last_outcome IS NULL OR last_outcome IN ('succeeded', 'failed'))
);

-- Валюта документа: ключ справочника валют 1С → код ISO. Неизвестный ключ — документ не загружается, алерт.
CREATE TABLE IF NOT EXISTS public.onec_currency_map (
  source_id BIGINT NOT NULL REFERENCES public.onec_sources(source_id),
  currency_ref_key UUID NOT NULL,
  iso_code CHAR(3) NOT NULL,
  CONSTRAINT pk_onec_currency_map PRIMARY KEY (source_id, currency_ref_key),
  CONSTRAINT chk_onec_currency_map_iso CHECK (iso_code ~ '^[A-Z]{3}$')
);

COMMENT ON COLUMN public.onec_documents.applied_revision IS 'Ревизия применённого состояния (шапка, строки, конфликты); ключ outbox onec.document_changed';
COMMENT ON COLUMN public.onec_documents.missing_in_source_at IS 'Документ отсутствует в последней выгрузке 1С — только диагностика, распределения не запрещает';
COMMENT ON COLUMN public.onec_document_lines.removed_in_onec_at IS 'Строка исчезла из документа 1С, но на неё есть ссылки распределений — новые распределения запрещены';
COMMENT ON COLUMN public.onec_document_lines.load_conflict_code IS 'Изменение 1С не применено из-за активных распределений — новые распределения запрещены до разрешения';
COMMENT ON TABLE public.onec_currency_map IS 'Соответствие ключа валюты 1С коду ISO для загрузчика документов';
COMMENT ON TABLE public.resource_suppliers IS
  'Поставщики материала по приходам 1С и вручную. Строки source=onec_receipt: first_seen_at понижается до даты самого раннего прихода (загрузчик документов 1С); source=manual не меняются.';
