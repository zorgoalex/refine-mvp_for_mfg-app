-- Документы расхода 1С в общем слое onec_documents* (модуль onec-sync) — план
-- spec_erp/plans/1c-agent/2026-09-30-onec-consumption-documents-plan.md (plan review R6 APPROVED), §3.1.
-- Виды: расходная накладная (продажа покупателю / возврат поставщику), списание, перемещение. Аддитивно:
-- новые колонки со значениями по умолчанию; прежние строки (приходы, оплаты) остаются валидными.
-- Применять ПОСЛЕ allowlist видов у закупок (feat/backend-erp-stage1 fcfeaebd): их чтения/команды принимают
-- только purchase_receipt / cash_outflow / bank_outflow.

-- Часовой пояс информационной базы 1С: `Date` документов приходит без смещения (локальное время базы).
ALTER TABLE public.onec_sources
  ADD COLUMN IF NOT EXISTS time_zone TEXT NOT NULL DEFAULT 'Asia/Almaty';

ALTER TABLE public.onec_documents
  ADD COLUMN IF NOT EXISTS doc_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS operation_kind TEXT NULL,
  ADD COLUMN IF NOT EXISTS warehouse_ref_key UUID NULL,
  ADD COLUMN IF NOT EXISTS destination_warehouse_ref_key UUID NULL,
  ADD COLUMN IF NOT EXISTS normalizer_version TEXT NULL;

ALTER TABLE public.onec_document_lines
  ADD COLUMN IF NOT EXISTS warehouse_ref_key UUID NULL,
  ADD COLUMN IF NOT EXISTS is_stock_item BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS unit_is_package BOOLEAN NOT NULL DEFAULT false;

-- У списаний и перемещений валюты нет.
ALTER TABLE public.onec_documents ALTER COLUMN currency DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_onec_sources_time_zone') THEN
    -- timezone(text, timestamp) — IMMUTABLE; неизвестное имя пояса отвергается.
    ALTER TABLE public.onec_sources ADD CONSTRAINT chk_onec_sources_time_zone
      CHECK (('2000-01-01 00:00:00'::timestamp AT TIME ZONE time_zone) IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_onec_documents_kind_v2') THEN
    ALTER TABLE public.onec_documents DROP CONSTRAINT IF EXISTS chk_onec_documents_kind;
    ALTER TABLE public.onec_documents ADD CONSTRAINT chk_onec_documents_kind_v2 CHECK (doc_kind IN (
      'purchase_receipt', 'cash_outflow', 'bank_outflow',
      'sales_shipment', 'supplier_return', 'inventory_writeoff', 'inventory_transfer'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_onec_documents_currency_kind') THEN
    ALTER TABLE public.onec_documents ADD CONSTRAINT chk_onec_documents_currency_kind
      CHECK (currency IS NOT NULL OR doc_kind IN ('inventory_writeoff', 'inventory_transfer'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_onec_documents_destination_kind') THEN
    ALTER TABLE public.onec_documents ADD CONSTRAINT chk_onec_documents_destination_kind
      CHECK (destination_warehouse_ref_key IS NULL OR doc_kind = 'inventory_transfer');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_onec_document_lines_warehouse
  ON public.onec_document_lines(warehouse_ref_key, onec_document_id)
  WHERE warehouse_ref_key IS NOT NULL;

COMMENT ON COLUMN public.onec_sources.time_zone IS 'Часовой пояс информационной базы 1С: Date документов (без смещения) → doc_at';
COMMENT ON COLUMN public.onec_documents.doc_at IS 'Момент документа 1С (Date по часовому поясу источника); отсечка проекции склада';
COMMENT ON COLUMN public.onec_documents.operation_kind IS 'ВидОперации документа 1С как есть (диагностика)';
COMMENT ON COLUMN public.onec_documents.destination_warehouse_ref_key IS 'Склад-получатель перемещения (СтруктурнаяЕдиницаПолучатель_Key)';
COMMENT ON COLUMN public.onec_documents.normalizer_version IS 'Версия правил нормализации применённого состояния; NULL — onec-documents-v1';
COMMENT ON COLUMN public.onec_document_lines.warehouse_ref_key IS 'Склад строки 1С (строка, иначе шапка); у перемещения — склад-источник';
COMMENT ON COLUMN public.onec_document_lines.is_stock_item IS 'ТипНоменклатурыЗапас: false — услуга/работа, не складской расход';
COMMENT ON COLUMN public.onec_document_lines.unit_is_package IS 'Количество в единице упаковки (Catalog_ЕдиницыИзмерения, коэффициент неизвестен)';
