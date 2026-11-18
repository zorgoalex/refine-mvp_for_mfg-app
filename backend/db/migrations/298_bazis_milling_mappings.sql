-- Базис → ERP: сопоставление фрезеровок, которых нет в справочнике milling_types.
-- Фрезеровка панели приходит из пользовательского свойства «Фрезировка»/«Фрезеровка» XML
-- (например «Выборка по фото»). Раньше ненайденное название молча превращалось в
-- milling_type_id = 1; теперь импорт предлагает выбрать фрезеровку ERP, выбор хранится
-- здесь как source_kind = 'milling' (target_kind 'milling' + milling_type_id, либо 'ignore').
-- Только расширение: существующие строки (sheet/film/edge/ignore) проходят новые проверки
-- без изменений (milling_type_id у них NULL). Таблица маленькая (сотни строк).
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.bazis_material_mappings
  ADD COLUMN IF NOT EXISTS milling_type_id bigint NULL REFERENCES public.milling_types(milling_type_id);

ALTER TABLE public.bazis_material_mappings
  DROP CONSTRAINT IF EXISTS bazis_material_mappings_source_kind_check,
  DROP CONSTRAINT IF EXISTS bazis_material_mappings_target_kind_check,
  DROP CONSTRAINT IF EXISTS bazis_material_mappings_target_chk;

ALTER TABLE public.bazis_material_mappings
  ADD CONSTRAINT bazis_material_mappings_source_kind_check
    CHECK (source_kind IN ('sheet', 'film', 'edge', 'milling')),
  ADD CONSTRAINT bazis_material_mappings_target_kind_check
    CHECK (target_kind IN ('sheet', 'film', 'edge', 'milling', 'ignore')),
  ADD CONSTRAINT bazis_material_mappings_target_chk CHECK (
    (target_kind = 'ignore' AND sheet_material_type_id IS NULL AND film_id IS NULL AND edge_type_id IS NULL AND milling_type_id IS NULL)
    OR (target_kind = 'sheet' AND sheet_material_type_id IS NOT NULL AND film_id IS NULL AND edge_type_id IS NULL AND milling_type_id IS NULL)
    OR (target_kind = 'film' AND film_id IS NOT NULL AND sheet_material_type_id IS NULL AND edge_type_id IS NULL AND milling_type_id IS NULL)
    OR (target_kind = 'edge' AND edge_type_id IS NOT NULL AND sheet_material_type_id IS NULL AND film_id IS NULL AND milling_type_id IS NULL)
    OR (target_kind = 'milling' AND milling_type_id IS NOT NULL AND sheet_material_type_id IS NULL AND film_id IS NULL AND edge_type_id IS NULL)
  );

COMMENT ON COLUMN public.bazis_material_mappings.milling_type_id IS
  'Фрезеровка ERP для source_kind = milling (название фрезеровки из свойства панели Базиса)';

COMMIT;
