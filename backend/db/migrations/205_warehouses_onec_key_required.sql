-- Склад ERP обязан иметь ключ 1С (ref_key_1c): приходные и расходные документы 1С
-- ссылаются на склады справочника 1С. Ограничение NOT VALID: сразу действует для новых
-- и изменяемых строк; существующий склад без ключа (сид «Склад плёнки» миграции 203)
-- остаётся до привязки в справочнике складов. Если непривязанных складов нет —
-- ограничение сразу проверяется целиком.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.warehouses'::regclass AND conname = 'chk_warehouses_ref_key_1c_required'
  ) THEN
    ALTER TABLE public.warehouses
      ADD CONSTRAINT chk_warehouses_ref_key_1c_required CHECK (ref_key_1c IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.warehouses WHERE ref_key_1c IS NULL) THEN
    ALTER TABLE public.warehouses VALIDATE CONSTRAINT chk_warehouses_ref_key_1c_required;
  END IF;
END $$;

COMMENT ON CONSTRAINT chk_warehouses_ref_key_1c_required ON public.warehouses IS
  'Ключ склада 1С обязателен (документы 1С ссылаются на склады 1С); NOT VALID до привязки старых складов';
