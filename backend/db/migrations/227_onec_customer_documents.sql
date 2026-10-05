-- Заказы покупателей, поступления и возвраты 1С со связями и авторами в общем слое onec_documents* (модуль onec-sync) —
-- план spec_erp/plans/1c-agent/2026-10-02-onec-customer-documents-plan.md (plan review R4 APPROVED), §4.
-- Аддитивно: новые колонки NULL / со значением по умолчанию, новые таблицы; прежние строки остаются валидными.
-- Связи документов — ссылки 1С (uuid) в шапке и строках, разрешаются при чтении; нормализованные ссылки 1С аудита —
-- onec_document_audit_refs (audit_log_related_entity хранит только BIGINT ID ERP).

ALTER TABLE public.onec_documents
  ADD COLUMN IF NOT EXISTS author_ref_key UUID NULL,
  ADD COLUMN IF NOT EXISTS author_name TEXT NULL,
  ADD COLUMN IF NOT EXISTS responsible_ref_key UUID NULL,
  ADD COLUMN IF NOT EXISTS responsible_name TEXT NULL,
  ADD COLUMN IF NOT EXISTS onec_order_ref_key UUID NULL,
  ADD COLUMN IF NOT EXISTS basis_ref_key UUID NULL,
  ADD COLUMN IF NOT EXISTS basis_type TEXT NULL;

ALTER TABLE public.onec_document_lines
  ADD COLUMN IF NOT EXISTS line_section VARCHAR(8) NOT NULL DEFAULT 'goods',
  ADD COLUMN IF NOT EXISTS settlement_doc_ref_key UUID NULL,
  ADD COLUMN IF NOT EXISTS settlement_doc_type TEXT NULL,
  ADD COLUMN IF NOT EXISTS is_advance BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS content TEXT NULL,
  ADD COLUMN IF NOT EXISTS line_shipment_date DATE NULL;

-- Строка-итог оплаты — раздел 'total' (до этого раздела не было; v3 нормализатора пишет его сам).
UPDATE public.onec_document_lines SET line_section = 'total' WHERE is_document_total AND line_section <> 'total';

-- Реквизиты заказа покупателя 1С (1:1 с onec_documents вида customer_order); пишет только загрузчик в транзакции документа.
CREATE TABLE IF NOT EXISTS public.onec_customer_orders (
  onec_document_id BIGINT PRIMARY KEY REFERENCES public.onec_documents(onec_document_id),
  state_ref_key UUID NULL,
  state_name TEXT NULL,
  order_kind_ref_key UUID NULL,
  order_kind_name TEXT NULL,
  payment_status TEXT NULL,
  production_status TEXT NULL,
  completion_variant TEXT NULL,
  delivery_method TEXT NULL,
  shipment_date DATE NULL,
  delivery_address TEXT NULL,
  delivery_service_ref_key UUID NULL,
  delivery_service_name TEXT NULL,
  expected_delivery_date DATE NULL,
  sales_unit_ref_key UUID NULL,
  workshop_ref_key UUID NULL,
  contract_ref_key UUID NULL,
  onec_changed_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ссылки 1С в записях аудита документов: до и после изменения, включая неразрешённые (документ вне окна загрузки).
CREATE TABLE IF NOT EXISTS public.onec_document_audit_refs (
  audit_id UUID NOT NULL REFERENCES public.audit_log(audit_id) ON DELETE CASCADE,
  source_id BIGINT NOT NULL,
  ref_role VARCHAR(16) NOT NULL,
  onec_ref_key UUID NOT NULL,
  onec_type TEXT NULL,
  state VARCHAR(8) NOT NULL,
  PRIMARY KEY (audit_id, ref_role, onec_ref_key, state)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_onec_documents_kind_v3') THEN
    ALTER TABLE public.onec_documents DROP CONSTRAINT IF EXISTS chk_onec_documents_kind_v2;
    ALTER TABLE public.onec_documents ADD CONSTRAINT chk_onec_documents_kind_v3 CHECK (doc_kind IN (
      'purchase_receipt', 'cash_outflow', 'bank_outflow',
      'sales_shipment', 'supplier_return', 'inventory_writeoff', 'inventory_transfer',
      'customer_order', 'cash_receipt', 'bank_receipt', 'cash_refund', 'bank_refund'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_onec_document_lines_section') THEN
    -- Работы заказа нумеруются 1 000 000 + LineNumber (план §3.3): раздел и диапазон номера согласованы.
    -- Связь 'total' ⇔ is_document_total НЕ ограничивается: загрузчик до v3 (между миграцией и выкладкой, при откате кода)
    -- пишет строку-итог оплаты с разделом по умолчанию 'goods'; v3 исправляет раздел техническим переходом.
    ALTER TABLE public.onec_document_lines ADD CONSTRAINT chk_onec_document_lines_section CHECK (
      line_section IN ('goods', 'works', 'payment', 'total')
      AND (line_section = 'works') = (line_no > 1000000));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_onec_document_audit_refs_role') THEN
    ALTER TABLE public.onec_document_audit_refs ADD CONSTRAINT chk_onec_document_audit_refs_role
      CHECK (ref_role IN ('customer_order', 'settlement_doc', 'basis') AND state IN ('before', 'after'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_onec_documents_order_ref
  ON public.onec_documents(source_id, onec_order_ref_key) WHERE onec_order_ref_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_onec_document_lines_order_ref
  ON public.onec_document_lines(onec_order_ref_key) WHERE onec_order_ref_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_onec_document_lines_settlement_ref
  ON public.onec_document_lines(settlement_doc_ref_key) WHERE settlement_doc_ref_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_onec_documents_ref
  ON public.onec_documents(source_id, onec_ref_key);
CREATE INDEX IF NOT EXISTS idx_onec_document_audit_refs_ref
  ON public.onec_document_audit_refs(source_id, onec_ref_key, audit_id);

COMMENT ON TABLE public.onec_customer_orders IS 'Реквизиты заказа покупателя 1С (состояние, вид, оплата, доставка); пишет загрузчик onec-sync';
COMMENT ON TABLE public.onec_document_audit_refs IS 'Ссылки 1С (заказ, документ зачёта, основание) записей аудита документов 1С: до/после';
COMMENT ON COLUMN public.onec_documents.author_ref_key IS 'Автор_Key документа 1С (Catalog_Пользователи)';
COMMENT ON COLUMN public.onec_documents.responsible_ref_key IS 'Ответственный_Key документа 1С (Catalog_Сотрудники)';
COMMENT ON COLUMN public.onec_documents.onec_order_ref_key IS 'Заказ покупателя шапки (Заказ при Заказ_Type = Document_ЗаказПокупателя)';
COMMENT ON COLUMN public.onec_documents.basis_ref_key IS 'ДокументОснование (только Document_*), тип — basis_type';
COMMENT ON COLUMN public.onec_document_lines.line_section IS 'Раздел строки: goods (Запасы), works (Работы, line_no > 1e6), payment (РасшифровкаПлатежа), total (итог оплаты)';
COMMENT ON COLUMN public.onec_document_lines.settlement_doc_ref_key IS 'Документ расчётов строки расшифровки платежа (Документ, только Document_*)';
COMMENT ON COLUMN public.onec_document_lines.is_advance IS 'ПризнакАванса строки расшифровки платежа';
