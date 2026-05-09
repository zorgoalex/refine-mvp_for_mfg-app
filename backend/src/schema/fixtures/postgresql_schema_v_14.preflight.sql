CREATE UNIQUE INDEX idx_film_vendors_ref_key ON film_vendors(ref_key_1c);

CREATE TABLE orders (
  order_id INTEGER PRIMARY KEY,
  final_amount NUMERIC,
  total_amount NUMERIC,
  discount NUMERIC,
  surcharge NUMERIC,
  ADD CONSTRAINT chk_orders_final_amount_consistent CHECK (final_amount = total_amount - discount + surcharge)
);

CREATE TABLE production_statuses (
  production_status_id SMALLINT,
  sort_order SMALLINT NOT NULL,
  production_status_name TEXT,
  production_status_code TEXT,
  color TEXT,
  CONSTRAINT uq_production_statuses_sort_order UNIQUE (sort_order)
);

INSERT INTO production_statuses (sort_order, production_status_name, production_status_code, color) VALUES
  (10, 'New', 'new', '#000000'),
  (10, 'Drawn', 'drawn', '#000000')
ON CONFLICT (production_status_name) DO NOTHING;

CREATE TABLE materials (
  material_id INTEGER PRIMARY KEY
);

CREATE TABLE material_unit_conversions (
  material_id BIGINT NOT NULL
);

CREATE TABLE edge_types (
  edge_type_id SMALLINT PRIMARY KEY
);

CREATE TABLE suppliers (
  supplier_id INTEGER PRIMARY KEY
);

CREATE TABLE order_resource_requirements (
  order_id INTEGER NOT NULL,
  resource_type TEXT NOT NULL,
  material_id INTEGER,
  film_id INTEGER,
  edge_type_id BIGINT,
  supplier_id BIGINT,
  CONSTRAINT uq_orr_order_resource UNIQUE (order_id, resource_type, material_id, film_id, edge_type_id)
);

CREATE TABLE payment_statuses (
  payment_status_id INTEGER PRIMARY KEY,
  payment_status_name TEXT
);

CREATE TABLE roles (
  role_id INTEGER PRIMARY KEY,
  role_code TEXT
);
