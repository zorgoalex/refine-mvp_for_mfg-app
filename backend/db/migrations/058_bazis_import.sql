-- 058_bazis_import.sql
-- Bazis XML import: immutable CAD/BOM revisions + node tree projection +
-- material mappings + order-creation links. Additive only.
-- current_revision_id намеренно без FK: circular dependency
-- bazis_projects <-> bazis_project_revisions, целостность держит приложение.

CREATE TABLE IF NOT EXISTS bazis_projects (
  bazis_project_id    bigserial PRIMARY KEY,
  project_id          bigint NOT NULL REFERENCES projects(project_id),
  name                text NOT NULL,
  current_revision_id bigint NULL,
  created_by          bigint REFERENCES users(user_id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bazis_projects_project_idx ON bazis_projects (project_id);

CREATE TABLE IF NOT EXISTS bazis_project_revisions (
  bazis_revision_id bigserial PRIMARY KEY,
  bazis_project_id  bigint NOT NULL REFERENCES bazis_projects(bazis_project_id),
  revision_no       integer NOT NULL,
  file_name         text,
  file_size         bigint,
  xml_sha256        text NOT NULL,
  raw_xml           bytea NOT NULL,
  bazis_version     text,
  product_name      text,
  product_price     numeric,
  summary_json      jsonb NOT NULL DEFAULT '{}'::jsonb,
  imported_by       bigint REFERENCES users(user_id) ON DELETE SET NULL,
  imported_at       timestamptz NOT NULL DEFAULT now(),
  request_id        text,
  UNIQUE (bazis_project_id, xml_sha256),
  UNIQUE (bazis_project_id, revision_no)
);

CREATE TABLE IF NOT EXISTS bazis_nodes (
  bazis_node_id       bigserial PRIMARY KEY,
  revision_id         bigint NOT NULL REFERENCES bazis_project_revisions(bazis_revision_id) ON DELETE CASCADE,
  parent_node_id      bigint NULL REFERENCES bazis_nodes(bazis_node_id) ON DELETE CASCADE,
  seq                 integer NOT NULL,
  node_kind           text NOT NULL CHECK (node_kind IN ('product','assembly','block','object')),
  object_type         text,
  name                text,
  detail_code         text,
  position            text,
  designation         text,
  quantity            numeric,
  cumulative_quantity numeric,
  length_mm           numeric,
  width_mm            numeric,
  height_mm           numeric,
  thickness_mm        numeric,
  price               numeric,
  is_rectangular      boolean,
  texture_orientation text,
  main_material_name  text,
  raw_json            jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS bazis_nodes_revision_idx ON bazis_nodes (revision_id);
CREATE INDEX IF NOT EXISTS bazis_nodes_revision_type_idx ON bazis_nodes (revision_id, object_type);
CREATE INDEX IF NOT EXISTS bazis_nodes_parent_idx ON bazis_nodes (revision_id, parent_node_id);

CREATE TABLE IF NOT EXISTS bazis_material_mappings (
  bazis_material_mapping_id bigserial PRIMARY KEY,
  source_kind            text NOT NULL CHECK (source_kind IN ('sheet','film','edge')),
  -- source_kind = контекст, в котором имя встретилось в XML (ОсновнойМатериал
  -- панели / Пласть / Кромка). Ключ маппинга — пара (source_kind, имя): одинаковое
  -- имя в разных контекстах маппится независимо (Critic R1 finding 4).
  bazis_name             text NOT NULL,
  target_kind            text NOT NULL CHECK (target_kind IN ('sheet','film','edge','ignore')),
  sheet_material_type_id bigint NULL REFERENCES sheet_material_types(sheet_material_type_id),
  film_id                bigint NULL REFERENCES films(film_id),
  edge_type_id           bigint NULL REFERENCES edge_types(edge_type_id),
  created_by             bigint REFERENCES users(user_id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             bigint REFERENCES users(user_id) ON DELETE SET NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bazis_material_mappings_target_chk CHECK (
    (target_kind = 'ignore' AND sheet_material_type_id IS NULL AND film_id IS NULL AND edge_type_id IS NULL)
    OR (target_kind = 'sheet' AND sheet_material_type_id IS NOT NULL AND film_id IS NULL AND edge_type_id IS NULL)
    OR (target_kind = 'film'  AND film_id IS NOT NULL AND sheet_material_type_id IS NULL AND edge_type_id IS NULL)
    OR (target_kind = 'edge'  AND edge_type_id IS NOT NULL AND sheet_material_type_id IS NULL AND film_id IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS bazis_material_mappings_name_uniq
  ON bazis_material_mappings (source_kind, lower(bazis_name));

CREATE TABLE IF NOT EXISTS bazis_node_order_detail_map (
  bazis_node_order_detail_map_id bigserial PRIMARY KEY,
  node_id         bigint NOT NULL REFERENCES bazis_nodes(bazis_node_id) ON DELETE CASCADE,
  order_detail_id bigint NULL REFERENCES order_details(detail_id) ON DELETE SET NULL,
  order_id        bigint NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  mapping_kind    text NOT NULL CHECK (mapping_kind IN ('created','ignored','manual')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (node_id, order_id)
);
CREATE INDEX IF NOT EXISTS bazis_node_map_order_idx ON bazis_node_order_detail_map (order_id);

CREATE TABLE IF NOT EXISTS bazis_order_links (
  bazis_order_link_id bigserial PRIMARY KEY,
  bazis_project_id bigint NOT NULL REFERENCES bazis_projects(bazis_project_id),
  order_id         bigint NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  revision_id      bigint NOT NULL REFERENCES bazis_project_revisions(bazis_revision_id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bazis_project_id, order_id)
);
CREATE INDEX IF NOT EXISTS bazis_order_links_order_idx ON bazis_order_links (order_id);

CREATE TABLE IF NOT EXISTS bazis_import_runs (
  bazis_import_run_id bigserial PRIMARY KEY,
  file_name   text,
  xml_sha256  text,
  status      text NOT NULL CHECK (status IN ('parsed','failed')),
  error_json  jsonb,
  revision_id bigint NULL REFERENCES bazis_project_revisions(bazis_revision_id),
  imported_by bigint REFERENCES users(user_id) ON DELETE SET NULL,
  request_id  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
