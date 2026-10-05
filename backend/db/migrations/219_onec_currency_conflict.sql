-- Конфликт смены валюты документа 1С при активных распределениях (запрос сессии закупок, фаза 3б-2): код строки
-- CURRENCY_CHANGED. Загрузчик (onec-sync) сохраняет прежнюю валюту, новая — load_conflict.proposedCurrency.
-- Только расширение CHECK кодов (новое имя — пробы раннера не срабатывают до применения).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_onec_document_lines_conflict_code_v2') THEN
    ALTER TABLE public.onec_document_lines DROP CONSTRAINT IF EXISTS chk_onec_document_lines_conflict_code;
    ALTER TABLE public.onec_document_lines ADD CONSTRAINT chk_onec_document_lines_conflict_code_v2 CHECK (
      load_conflict_code IS NULL OR load_conflict_code IN
        ('QUANTITY_BELOW_ALLOCATED', 'REMOVED_WITH_ALLOCATION', 'MATERIAL_CHANGED', 'UNIT_CHANGED', 'AMOUNT_BELOW_ALLOCATED',
         'CURRENCY_CHANGED'));
  END IF;
END $$;
