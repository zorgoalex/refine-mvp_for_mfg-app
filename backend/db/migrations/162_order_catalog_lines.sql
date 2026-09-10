-- Sale rows are valid on production orders AND precursors. No fake manufacturing children.
CREATE TABLE IF NOT EXISTS public.order_catalog_lines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY CHECK (id BETWEEN 1 AND 9007199254740991),
  order_id bigint NOT NULL REFERENCES public.orders(order_id) ON DELETE RESTRICT,
  catalog_item_id bigint NOT NULL REFERENCES public.catalog_items(id) ON DELETE RESTRICT,
  line_number integer NOT NULL CHECK (line_number > 0),
  name varchar(200) NOT NULL CHECK (length(btrim(name)) > 0),
  sku varchar(80),
  kind text NOT NULL CHECK (kind IN ('made_to_order','stock_item','service')),
  unit_id smallint NOT NULL REFERENCES public.units(unit_id) ON DELETE RESTRICT,
  unit_name text NOT NULL,
  catalog_version integer NOT NULL CHECK (catalog_version > 0),
  ref_key_1c uuid,
  quantity numeric(12,3) NOT NULL CHECK (quantity > 0 AND quantity <> 'NaN'::numeric),
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0 AND unit_price <> 'NaN'::numeric),
  amount numeric(12,2) GENERATED ALWAYS AS (round(quantity * unit_price, 2)) STORED,
  notes varchar(2000) NOT NULL DEFAULT '',
  delete_flag boolean NOT NULL DEFAULT false,
  created_by bigint NOT NULL REFERENCES public.users(user_id) ON DELETE RESTRICT,
  edited_by bigint NOT NULL REFERENCES public.users(user_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_catalog_lines_order_idx ON public.order_catalog_lines(order_id,delete_flag,line_number,id);
COMMENT ON TABLE public.order_catalog_lines IS 'Order-owned sale snapshots; parent order version/command controls mutations, not manufacturing details';

CREATE OR REPLACE FUNCTION validate_order_kind_aggregate_id(p_order_id BIGINT)
RETURNS void AS $$
DECLARE
  o orders%ROWTYPE;
BEGIN
  -- Serialize aggregate checks even for child writers outside the order command.
  -- Subsequent EXISTS statements see the preceding lock owner's committed children.
  SELECT * INTO o FROM orders WHERE order_id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF o.order_kind = 'production_order' THEN
    IF o.project_id IS NULL THEN
      RAISE EXCEPTION 'production order % requires project', p_order_id
        USING ERRCODE = '23514', CONSTRAINT = 'chk_orders_kind_project';
    END IF;

    IF o.delete_flag = false
       AND o.legacy_zero_detail_exempt = false
       AND NOT EXISTS (
         SELECT 1 FROM order_details od
         WHERE od.order_id = p_order_id AND od.delete_flag = false
       ) AND NOT EXISTS (
         SELECT 1 FROM order_catalog_lines cl
         WHERE cl.order_id = p_order_id AND cl.delete_flag = false
       ) THEN
      RAISE EXCEPTION 'production order % requires an active detail or catalogue line', p_order_id
        USING ERRCODE = '23514', CONSTRAINT = 'chk_orders_production_detail_required';
    END IF;

    IF o.legacy_zero_detail_exempt = true
       AND (EXISTS (
         SELECT 1 FROM order_details od
         WHERE od.order_id = p_order_id AND od.delete_flag = false
       ) OR EXISTS (
         SELECT 1 FROM order_catalog_lines cl
         WHERE cl.order_id = p_order_id AND cl.delete_flag = false
       )) THEN
      UPDATE orders SET legacy_zero_detail_exempt = false
      WHERE order_id = p_order_id AND legacy_zero_detail_exempt = true;
    END IF;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM order_details od
    WHERE od.order_id = p_order_id
      AND od.delete_flag = false
      AND (od.production_status_id IS NOT NULL OR od.joint_order_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'precursor order % detail has production/joint state', p_order_id
      USING ERRCODE = '23514', CONSTRAINT = 'chk_order_details_precursor_state';
  END IF;

  IF EXISTS (SELECT 1 FROM payments p WHERE p.order_id = p_order_id AND p.delete_flag = false)
     OR EXISTS (SELECT 1 FROM order_workshops ow WHERE ow.order_id = p_order_id AND ow.delete_flag = false)
     OR EXISTS (SELECT 1 FROM order_resource_requirements r WHERE r.order_id = p_order_id AND r.is_active = true)
     OR EXISTS (SELECT 1 FROM order_doweling_links l WHERE l.order_id = p_order_id AND l.delete_flag = false)
     OR EXISTS (
       SELECT 1 FROM production_status_events e
       LEFT JOIN order_details od ON od.detail_id = e.detail_id
       WHERE e.order_id = p_order_id OR od.order_id = p_order_id
     )
     OR EXISTS (SELECT 1 FROM deadline_instances d WHERE d.order_id = p_order_id)
     OR EXISTS (SELECT 1 FROM deadline_events d WHERE d.order_id = p_order_id)
     OR EXISTS (SELECT 1 FROM cut_job_item c WHERE c.order_id = p_order_id AND c.is_active = true)
     OR EXISTS (SELECT 1 FROM bazis_order_links b WHERE b.order_id = p_order_id)
     OR EXISTS (SELECT 1 FROM bazis_node_order_detail_map b WHERE b.order_id = p_order_id)
     OR EXISTS (SELECT 1 FROM bazis_cut_set_details b WHERE b.source_order_id = p_order_id)
     OR EXISTS (
       SELECT 1 FROM bazis_cut_set_details b
       JOIN order_details od ON od.detail_id = b.source_order_detail_id
       WHERE od.order_id = p_order_id
     )
     OR EXISTS (SELECT 1 FROM movement_items m JOIN order_details od ON od.detail_id=m.order_detail_id WHERE od.order_id=p_order_id)
     OR EXISTS (SELECT 1 FROM cnc_telegram_packet_items c WHERE c.match_order_id=p_order_id)
     OR EXISTS (
       SELECT 1 FROM cnc_telegram_packet_items c
       JOIN order_details od ON od.detail_id=c.match_detail_id
       WHERE od.order_id=p_order_id
     )
     OR EXISTS (SELECT 1 FROM group_order_groups g WHERE g.order_id=p_order_id)
     OR EXISTS (SELECT 1 FROM order_label_detail_data l WHERE l.order_id = p_order_id)
     OR EXISTS (SELECT 1 FROM order_label_generations l WHERE l.order_id = p_order_id) THEN
    RAISE EXCEPTION 'precursor order % has prohibited production/finance children', p_order_id
      USING ERRCODE = '23514', CONSTRAINT = 'chk_orders_precursor_children';
  END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ctrg_order_catalog_lines_kind_aggregate ON public.order_catalog_lines;
CREATE CONSTRAINT TRIGGER ctrg_order_catalog_lines_kind_aggregate
AFTER INSERT OR UPDATE OR DELETE ON public.order_catalog_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_order_kind_aggregate();
