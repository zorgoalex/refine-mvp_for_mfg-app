// backend/src/modules/orders/adapters/migration-034-apply.integration.ts
// Apply-integration test for migration 034 (Variant B: sunset legacy order material link).
// Uses an ephemeral Postgres; set SHEET_INTEGRATION_DATABASE_URL to enable.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  applyInIsolatedSchema,
  bootstrapVariantBSchema,
  seedVariantAMain,
} from './__fixtures__/variant-b-migration-fixture';

const url = process.env.SHEET_INTEGRATION_DATABASE_URL;
const d = url ? describe : describe.skip;
const mig = (n: string) =>
  readFileSync(join(__dirname, '../../../../db/migrations', n), 'utf8');

d('migration 034 apply (Variant B sunset)', () => {
  const client = new Client({ connectionString: url });
  beforeAll(async () => {
    await client.connect();
    // Critic R7 M3: a CONCRETE bootstrap, not "minimal schema". The 034 view rebuilds
    // reference clients, order_statuses, payment_statuses, production_statuses,
    // milling_types, edge_types, films, employees, doweling_orders, order_doweling_links,
    // plus sheet_material_types/materials/orders/order_details; and the shadow-DELETE
    // guard references material_unit_conversions, requisition_items, material_transactions,
    // warehouse_stock, order_resource_requirements. The shared fixture creates ALL of
    // them, applies 029 + 030, and seeds the Variant-A dataset:
    //   - a LIVE sheet detail (shadow material_id + sheet id),
    //   - a SOFT-DELETED legacy detail mapped via _matmap (delete_flag=true, sheet NULL pre-034),
    //   - a HEADER-ONLY legacy order (orders.material_id set, mappable),
    //   - a header-only order with NO material (material_id NULL, sheet NULL — stays).
    await bootstrapVariantBSchema(client); // reuses the proven 029 harness (R16 B1)
    await seedVariantAMain(client); // main dataset (separate from bootstrap)
  });
  afterAll(async () => {
    await client.end();
  });

  it('after 034: order details (incl. soft-deleted) and headers are sheet-only', async () => {
    await client.query(mig('034_order_material_sunset_legacy.sql'));
    const detailLegacy = await client.query(
      `SELECT count(*)::int n FROM order_details WHERE material_id IS NOT NULL`, // ALL rows
    );
    expect(detailLegacy.rows[0].n).toBe(0);
    const detailNoSheet = await client.query(
      `SELECT count(*)::int n FROM order_details WHERE sheet_material_type_id IS NULL`, // ALL rows
    );
    expect(detailNoSheet.rows[0].n).toBe(0);
    const orderLegacy = await client.query(
      `SELECT count(*)::int n FROM orders WHERE material_id IS NOT NULL`,
    );
    expect(orderLegacy.rows[0].n).toBe(0); // Critic R3 B1: header material_id nulled
    const shadows = await client.query(
      `SELECT count(*)::int n FROM materials WHERE is_sheet_shadow=true`,
    );
    expect(shadows.rows[0].n).toBe(0);
    // Critic R4 B1 / R9 B2: EVERY non-deleted order is SP3-era (incl. blank/headerless),
    // so the FE picker never faces a backend 422.
    const notEligible = await client.query(
      `SELECT count(*)::int n FROM orders WHERE delete_flag = false AND sheet_eligible = false`,
    );
    expect(notEligible.rows[0].n).toBe(0);
  });

  // Each abort case runs in its OWN isolated schema with a per-test SEED hook (R16 B2)
  // that inserts ONLY the offending row(s), so they are executable and isolated.
  const SUNSET = () => mig('034_order_material_sunset_legacy.sql');

  it('aborts on a soft-deleted detail with an UNMAPPED material_id', async () => {
    await expect(
      applyInIsolatedSchema(
        client,
        async (c) => {
          // a material NOT covered by SP2/manifest, on a soft-deleted detail, no sheet:
          await c.query(`INSERT INTO materials (material_id, material_name) OVERRIDING SYSTEM VALUE VALUES (9991, 'unmapped')`);
          await c.query(`INSERT INTO orders (order_id, created_by) OVERRIDING SYSTEM VALUE VALUES (701, 1)`);
          await c.query(
            `INSERT INTO order_details (order_id, detail_number, height, width, quantity, area, material_id, milling_type_id, edge_type_id, priority, created_by, delete_flag)
             VALUES (701, 1, 100, 100, 1, 0.01, 9991, 1, 1, 100, 1, true)`,
          );
        },
        SUNSET(),
      ),
    ).rejects.toThrow(/no sheet_material_type_id/);
  });

  it('aborts on an order with an unmapped header material_id', async () => {
    await expect(
      applyInIsolatedSchema(
        client,
        async (c) => {
          await c.query(`INSERT INTO materials (material_id, material_name) OVERRIDING SYSTEM VALUE VALUES (9992, 'unmapped-hdr')`);
          await c.query(`INSERT INTO orders (order_id, material_id, created_by) OVERRIDING SYSTEM VALUE VALUES (702, 9992, 1)`);
        },
        SUNSET(),
      ),
    ).rejects.toThrow(/unmapped header material_id/);
  });

  it('is idempotent: re-applying 033+034 leaves the same sheet-only end state (Critic R23 M5)', async () => {
    // main fixture already applied 034 once in beforeAll; re-apply 033 (manifest replace)
    // + 034 and assert the end state is unchanged (no dup types, no resurrected shadows,
    // material_id still NULL, conversion_key stable).
    await client.query(mig('033_order_material_conversion_map.sql'));
    await client.query(mig('034_order_material_sunset_legacy.sql'));
    const types = await client.query(
      `SELECT count(*)::int n, count(DISTINCT conversion_key)::int k FROM sheet_material_types WHERE conversion_key IS NOT NULL`,
    );
    expect(types.rows[0].n).toBe(types.rows[0].k); // no duplicate keyed types
    const legacy = await client.query(
      `SELECT count(*)::int n FROM order_details WHERE material_id IS NOT NULL`,
    );
    expect(legacy.rows[0].n).toBe(0);
    const shadows = await client.query(
      `SELECT count(*)::int n FROM materials WHERE is_sheet_shadow=true`,
    );
    expect(shadows.rows[0].n).toBe(0);
  });

  it('aborts when a shadow material is referenced by a non-order FK table (Critic R5 B2)', async () => {
    await expect(
      applyInIsolatedSchema(
        client,
        async (c) => {
          // a shadow material referenced by warehouse_stock -> DELETE guard must RAISE first:
          await c.query(
            `INSERT INTO sheet_material_types (sheet_material_type_id, name, unit_id, material_type_id, width_mm, height_mm, thickness_mm) OVERRIDING SYSTEM VALUE VALUES (50, 'X', 1, 3, 2800, 2070, 16)`,
          );
          await c.query(
            `INSERT INTO materials (material_id, material_name, is_sheet_shadow, shadow_of_sheet_material_type_id) OVERRIDING SYSTEM VALUE VALUES (9993, 'shadow', true, 50)`,
          );
          await c.query(`INSERT INTO warehouse_stock (material_id) VALUES (9993)`);
        },
        SUNSET(),
      ),
    ).rejects.toThrow(/shadow materials still referenced/);
  });

  it('rejects an order detail carrying a material_id', async () => {
    await expect(
      client.query(
        `INSERT INTO order_details (order_id, detail_number, height, width, quantity, area, material_id, sheet_material_type_id, milling_type_id, edge_type_id, priority, created_by)
         VALUES (1, 99, 100, 100, 1, 0.01, 7, 2, 1, 1, 100, 1)`,
      ),
    ).rejects.toThrow(/chk_order_details_sheet_only/);
  });

  it('order_details_view returns the sheet name', async () => {
    const r = await client.query(
      `SELECT material_name FROM order_details_view WHERE order_id = 1 LIMIT 1`,
    );
    expect(r.rows[0].material_name).toBeTruthy();
  });

  // Critic R2 M1: a silent column reorder/drop breaks Hasura metadata + every
  // consumer. Assert the EXACT column list + ordinal position of both rebuilt
  // views matches the live 029 shape (only material_name's SOURCE changes, not
  // the column set/order).
  it('order_details_view column list + order is unchanged from 029', async () => {
    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'order_details_view' ORDER BY ordinal_position`,
    );
    expect(cols.rows.map((c) => c.column_name)).toEqual([
      'detail_id',
      'order_id',
      'detail_number',
      'detail_name',
      'height',
      'width',
      'quantity',
      'area',
      'material_id',
      'sheet_material_type_id',
      'material_name',
      'milling_type_id',
      'edge_type_id',
      'film_id',
      'milling_cost_per_sqm',
      'detail_cost',
      'priority',
      'production_status_id',
      'joint_order_id',
      'note',
      'link_cutting_file',
      'link_cutting_image_file',
      'link_cad_file',
      'link_pdf_file',
      'ref_key_1c',
    ]);
  });
  it('orders_view column list + order is unchanged from 029', async () => {
    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'orders_view' ORDER BY ordinal_position`,
    );
    // exact 029 orders_view column list (verbatim ordinal order) — material_name
    // keeps its position; only its expression changes to smt.name.
    expect(cols.rows.map((c) => c.column_name)).toEqual([
      'order_id',
      'order_name',
      'order_name_numeric',
      'client_id',
      'client_name',
      'order_date',
      'priority',
      'doweling_order_id',
      'doweling_order_name',
      'design_engineer',
      'completion_date',
      'planned_completion_date',
      'order_status_name',
      'payment_status_name',
      'production_status_name',
      'issue_date',
      'total_amount',
      'final_amount',
      'discount',
      'surcharge',
      'paid_amount',
      'payment_date',
      'parts_count',
      'total_area',
      'milling_type_name',
      'edge_type_name',
      'film_name',
      'material_name',
      'notes',
      'link_cutting_file',
      'link_cutting_image_file',
      'order_ref_key_1c',
      'client_ref_key_1c',
      'manager_id',
      'created_by',
      'edited_by',
      'created_at',
      'updated_at',
      'version',
      'sheet_material_type_id',
    ]);
  });

  // Critic R7 M2: ordinal column assertions for the three OTHER rebuilt views too.
  const cols = async (view: string) =>
    (
      await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`,
        [view],
      )
    ).rows.map((c) => c.column_name);

  it('doweling_orders_view column list + order unchanged', async () => {
    expect(await cols('doweling_orders_view')).toEqual([
      'doweling_order_id',
      'doweling_order_name',
      'order_id',
      'order_name',
      'client_id',
      'client_name',
      'doweling_order_date',
      'payment_status_name',
      'production_status_name',
      'issue_date',
      'total_amount',
      'final_amount',
      'discount',
      'surcharge',
      'paid_amount',
      'payment_date',
      'parts_count',
      'milling_type_name',
      'edge_type_name',
      'material_name',
      'design_engineer_id',
      'design_engineer',
      'operator_id',
      'operator',
      'link_cad_file',
      'link_pdf_file',
      'version',
      'order_ref_key_1c',
      'client_ref_key_1c',
      'created_by',
      'edited_by',
      'created_at',
      'updated_at',
    ]);
  });
  it('details_of_order column list + order unchanged', async () => {
    expect(await cols('details_of_order')).toEqual([
      'detail_number',
      'height',
      'width',
      'quantity',
      'milling_type_name',
      'note',
      'order_name',
      'order_id',
      'detail_id',
      'area',
      'material_name',
      'edge_type_name',
      'film_name',
      'milling_cost_per_sqm',
      'detail_cost',
      'priority',
      'production_status_name',
      'joint_order_id',
      'link_cutting_file',
      'link_cutting_image_file',
      'detail_name',
      'detail_ref_key_1c',
      'created_by',
      'edited_by',
      'created_at',
      'updated_at',
    ]);
  });
  it('orders_alias_view column list + order unchanged (Russian labels)', async () => {
    expect(await cols('orders_alias_view')).toEqual([
      'Id заказа',
      'Имя заказа',
      'Имя клиента',
      'Дата заказа',
      'Приоритет заказа',
      'Дата готовности',
      'Планируемая дата готовности',
      'Статус заказа',
      'Статус оплаты заказа',
      'Дата выдачи заказа',
      'Сумма стоимости заказа',
      'Сумма с учетом скидки',
      'Сумма скидки',
      'Сумма наценки',
      'Сумма оплаты заказа',
      'Дата оплаты заказа',
      'Количество деталей',
      'Сумма площади заказа',
      'Тип фрезеровки',
      'Тип обката',
      'Имя пленки',
      'Имя материала',
      'Ссылка на файл раскроя',
      'Ссылка на файл картинки раскроя',
      'Ref_Key_1C заказа',
      'Ref_Key_1C клиента',
      'ID менеджера',
      'ID создавшего',
      'ID редактировавшего',
      'Дата создания',
      'Дата изменения',
    ]);
  });
});
