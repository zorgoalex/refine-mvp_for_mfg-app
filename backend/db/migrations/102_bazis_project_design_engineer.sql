-- 102_bazis_project_design_engineer.sql
-- Конструктор Базис-проекта: ручной выбор + безопасный импорт из XML.

ALTER TABLE bazis_projects
  ADD COLUMN IF NOT EXISTS design_engineer_id bigint NULL
    REFERENCES employees(employee_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS design_engineer_xml_name text NULL,
  ADD COLUMN IF NOT EXISTS design_engineer_source text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bazis_projects_design_engineer_source'
      AND conrelid = 'bazis_projects'::regclass
  ) THEN
    ALTER TABLE bazis_projects
      ADD CONSTRAINT chk_bazis_projects_design_engineer_source
      CHECK (design_engineer_source IS NULL OR design_engineer_source IN ('xml', 'manual'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS bazis_projects_design_engineer_idx
  ON bazis_projects (design_engineer_id)
  WHERE design_engineer_id IS NOT NULL;

COMMENT ON COLUMN bazis_projects.design_engineer_id IS
  'Конструктор Базис-проекта из employees; заполняется из XML или вручную.';
COMMENT ON COLUMN bazis_projects.design_engineer_xml_name IS
  'Очищенное исходное значение корневого XML-поля Разработчик.';
COMMENT ON COLUMN bazis_projects.design_engineer_source IS
  'Источник текущего значения конструктора: xml или manual.';

-- Backfill текущих проектов. Выбираем сотрудника только при однозначном
-- совпадении: сначала полное ФИО, затем фамилия + инициалы (Тапен Ж.К).
WITH root_developers AS (
  SELECT bp.bazis_project_id,
         NULLIF(
           btrim(regexp_replace(n.raw_json->>'Разработчик',
             '^\s*(Конструктор|Разработчик)\s*:\s*', '', 'i')),
           ''
         ) AS xml_name
  FROM bazis_projects bp
  JOIN bazis_nodes n ON n.revision_id = bp.current_revision_id
                    AND n.parent_node_id IS NULL
), normalized_roots AS (
  SELECT bazis_project_id,
         xml_name,
         btrim(regexp_replace(lower(replace(xml_name, 'ё', 'е')), '[^[:alnum:]]+', ' ', 'g')) AS norm
  FROM root_developers
  WHERE xml_name IS NOT NULL
), unambiguous_xml AS (
  SELECT bazis_project_id, min(xml_name) AS xml_name, min(norm) AS norm
  FROM normalized_roots
  GROUP BY bazis_project_id
  HAVING count(DISTINCT norm) = 1
), employee_norm AS (
  SELECT e.employee_id,
         btrim(regexp_replace(lower(replace(e.full_name, 'ё', 'е')), '[^[:alnum:]]+', ' ', 'g')) AS norm
  FROM employees e
  WHERE e.is_active = true
), candidates AS (
  SELECT x.bazis_project_id,
         x.xml_name,
         e.employee_id,
         CASE WHEN e.norm = x.norm THEN 0 ELSE 1 END AS match_rank
  FROM unambiguous_xml x
  JOIN employee_norm e
    ON e.norm = x.norm
    OR (
      split_part(e.norm, ' ', 1) = split_part(x.norm, ' ', 1)
      AND left(split_part(e.norm, ' ', 2), 1) = left(split_part(x.norm, ' ', 2), 1)
      AND left(split_part(x.norm, ' ', 2), 1) <> ''
      AND (
        split_part(x.norm, ' ', 3) = ''
        OR split_part(e.norm, ' ', 3) = ''
        OR left(split_part(e.norm, ' ', 3), 1) = left(split_part(x.norm, ' ', 3), 1)
      )
    )
), best_rank AS (
  SELECT bazis_project_id, min(match_rank) AS match_rank
  FROM candidates
  GROUP BY bazis_project_id
), unique_match AS (
  SELECT c.bazis_project_id, min(c.xml_name) AS xml_name, min(c.employee_id) AS employee_id
  FROM candidates c
  JOIN best_rank b USING (bazis_project_id, match_rank)
  GROUP BY c.bazis_project_id
  HAVING count(*) = 1
)
UPDATE bazis_projects bp
SET design_engineer_xml_name = x.xml_name,
    design_engineer_id = m.employee_id,
    design_engineer_source = CASE WHEN m.employee_id IS NOT NULL THEN 'xml' ELSE NULL END
FROM unambiguous_xml x
LEFT JOIN unique_match m ON m.bazis_project_id = x.bazis_project_id
WHERE bp.bazis_project_id = x.bazis_project_id
  AND bp.design_engineer_source IS NULL;
