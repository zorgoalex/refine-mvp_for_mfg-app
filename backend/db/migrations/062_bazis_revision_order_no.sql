ALTER TABLE bazis_project_revisions
  ADD COLUMN IF NOT EXISTS bazis_order_no text NULL;

COMMENT ON COLUMN bazis_project_revisions.bazis_order_no IS
  'Внутренний номер заказа Базис (Проект@Наименование, fallback Изделие/Заказ). NULL у старых ревизий — read-фоллбек по raw_json изделий.';
