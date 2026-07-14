ALTER TABLE bazis_nodes
  ADD COLUMN IF NOT EXISTS notes text NULL;

COMMENT ON COLUMN bazis_nodes.notes IS
  'Примечание оператора к узлу (вкладка «Панели»). Живёт в своей ревизии: при импорте новой ревизии узлы пересоздаются с пустым примечанием.';
