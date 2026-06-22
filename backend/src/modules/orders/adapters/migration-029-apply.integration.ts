import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Re-export bootstrap029 so consumers can import from this file if they prefer.
// The implementation lives in bootstrap029.ts to avoid circular test-suite registration.
export { bootstrap029 } from './bootstrap029';
import { bootstrap029 } from './bootstrap029';

// Fail-fast: the dedicated `test:backend:sheet-integration` script sets
// SHEET_INTEGRATION_REQUIRED=1. In that mode ONLY SHEET_INTEGRATION_DATABASE_URL
// is honored (no TEST_DATABASE_URL fallback that could silently route the suite to
// a different database); a missing value is a hard error, not a silent skip.
const required = process.env.SHEET_INTEGRATION_REQUIRED === '1';
const databaseUrl = required
  ? process.env.SHEET_INTEGRATION_DATABASE_URL
  : process.env.SHEET_INTEGRATION_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (required && !databaseUrl) {
  throw new Error('SHEET_INTEGRATION_DATABASE_URL is required for test:backend:sheet-integration');
}
const describeIntegration = databaseUrl ? describe : describe.skip;
const schemaName = `migration_029_${randomUUID().replaceAll('-', '_')}`;

const MIGRATIONS = resolve(__dirname, '../../../../db/migrations');
function migration(file: string): string {
  return readFileSync(resolve(MIGRATIONS, file), 'utf8');
}

// Pre-029 orders_view columns (migration 004 shape — ends with ord.version, NO sheet column).
const PRE_029_ORDERS_VIEW_COLUMNS = [
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
];

async function applyMigration030(client: PoolClient): Promise<void> {
  await client.query(migration('030_order_detail_shadow_pairing_trigger.sql'));
}

async function getViewColumns(pool: Pool, viewName: string): Promise<string[]> {
  const result = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schemaName, viewName],
  );
  return result.rows.map((r) => r.column_name);
}

describeIntegration('Migration 029: order-side sheet material link (integration, DDL assertions)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}`);
      await bootstrap029(client);
      await applyMigration030(client);
    } finally {
      client.release();
    }
    pool.on('connect', (c) => void c.query(`SET search_path TO ${schemaName}`));
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await pool.end();
    }
  });

  it('1. order_details.sheet_material_type_id and orders.sheet_material_type_id are NULLABLE columns', async () => {
    const result = await pool.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `SELECT table_name, column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name IN ('order_details', 'orders')
         AND column_name = 'sheet_material_type_id'
       ORDER BY table_name`,
      [schemaName],
    );
    expect(result.rowCount).toBe(2);
    for (const row of result.rows) {
      expect(row.is_nullable).toBe('YES');
    }
  });

  it('2. FK constraints fk_order_details_sheet_material_type, fk_orders_sheet_material_type, fk_materials_shadow_of_sheet_material_type exist', async () => {
    const result = await pool.query<{ conname: string }>(
      `SELECT c.conname
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = $1
         AND c.conname IN (
           'fk_order_details_sheet_material_type',
           'fk_orders_sheet_material_type',
           'fk_materials_shadow_of_sheet_material_type'
         )
       ORDER BY c.conname`,
      [schemaName],
    );
    const names = result.rows.map((r) => r.conname).sort();
    expect(names).toEqual([
      'fk_materials_shadow_of_sheet_material_type',
      'fk_order_details_sheet_material_type',
      'fk_orders_sheet_material_type',
    ]);
  });

  it('3. materials.is_sheet_shadow (NOT NULL, default false) and materials.shadow_of_sheet_material_type_id (nullable) exist', async () => {
    const result = await pool.query<{ column_name: string; is_nullable: string; column_default: string }>(
      `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name = 'materials'
         AND column_name IN ('is_sheet_shadow', 'shadow_of_sheet_material_type_id')
       ORDER BY column_name`,
      [schemaName],
    );
    expect(result.rowCount).toBe(2);
    const byShadow = Object.fromEntries(result.rows.map((r) => [r.column_name, r]));
    expect(byShadow['is_sheet_shadow'].is_nullable).toBe('NO');
    expect(byShadow['is_sheet_shadow'].column_default).toMatch(/false/i);
    expect(byShadow['shadow_of_sheet_material_type_id'].is_nullable).toBe('YES');
  });

  it('4. orders.sheet_eligible exists, NOT NULL, default true', async () => {
    const result = await pool.query<{ is_nullable: string; column_default: string }>(
      `SELECT is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name = 'orders'
         AND column_name = 'sheet_eligible'`,
      [schemaName],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].is_nullable).toBe('NO');
    expect(result.rows[0].column_default).toMatch(/true/i);
  });

  it('5. Unique index uq_materials_shadow_of_sheet_material_type_id exists', async () => {
    const result = await pool.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = $1
         AND indexname = 'uq_materials_shadow_of_sheet_material_type_id'`,
      [schemaName],
    );
    expect(result.rowCount).toBe(1);
  });

  it('6. orders_view column order: pre-029 columns first in original order, then sheet_material_type_id appended last', async () => {
    const afterColumns = await getViewColumns(pool, 'orders_view');
    // The after list must start with all pre-029 columns in the same order
    const firstN = afterColumns.slice(0, PRE_029_ORDERS_VIEW_COLUMNS.length);
    expect(firstN).toEqual(PRE_029_ORDERS_VIEW_COLUMNS);
    // sheet_material_type_id is the last column
    expect(afterColumns[afterColumns.length - 1]).toBe('sheet_material_type_id');
    // Total = pre-029 count + 1
    expect(afterColumns.length).toBe(PRE_029_ORDERS_VIEW_COLUMNS.length + 1);
  });

  it('7. order_details_view exists and has a material_name column', async () => {
    const columns = await getViewColumns(pool, 'order_details_view');
    expect(columns).toContain('material_name');
  });

  it('8. COALESCE: order_details_view.material_name prefers sheet type name when sheet_material_type_id set', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${schemaName}`);

      // Insert a sheet type
      const smt = await client.query<{ sheet_material_type_id: number }>(
        `INSERT INTO sheet_material_types (name, material_type_id) VALUES ('МДФ 16 мм ТЕСТ', 1) RETURNING sheet_material_type_id`,
      );
      const smtId = smt.rows[0].sheet_material_type_id;

      // Insert a real material (used as fallback)
      const mat = await client.query<{ material_id: number }>(
        `INSERT INTO materials (material_name, unit_id) VALUES ('Материал резерв ТЕСТ', 1) RETURNING material_id`,
      );
      const matId = mat.rows[0].material_id;

      // Insert an order
      const ord = await client.query<{ order_id: number }>(
        `INSERT INTO orders (order_name) VALUES ('Тест-SP3-COALESCE') RETURNING order_id`,
      );
      const orderId = ord.rows[0].order_id;

      // Insert a detail with both sheet_material_type_id and material_id set
      await client.query(
        `INSERT INTO order_details (order_id, detail_name, sheet_material_type_id, material_id)
         VALUES ($1, 'Деталь-ТЕСТ', $2, $3)`,
        [orderId, smtId, matId],
      );

      // COALESCE should prefer the sheet type name
      const view = await client.query<{ material_name: string }>(
        `SELECT material_name FROM order_details_view WHERE order_id = $1`,
        [orderId],
      );
      expect(view.rowCount).toBe(1);
      expect(view.rows[0].material_name).toBe('МДФ 16 мм ТЕСТ');

      // Also check orders_view header material_name COALESCE for a sheet order
      const ordSheet = await client.query<{ order_id: number }>(
        `INSERT INTO orders (order_name, sheet_material_type_id) VALUES ('Тест-SP3-Header', $1) RETURNING order_id`,
        [smtId],
      );
      const headerOrderId = ordSheet.rows[0].order_id;
      const ordView = await client.query<{ material_name: string }>(
        `SELECT material_name FROM orders_view WHERE order_id = $1`,
        [headerOrderId],
      );
      expect(ordView.rowCount).toBe(1);
      expect(ordView.rows[0].material_name).toBe('МДФ 16 мм ТЕСТ');

      // Cleanup
      await client.query(`DELETE FROM order_details WHERE order_id = $1`, [orderId]);
      await client.query(`DELETE FROM orders WHERE order_id IN ($1, $2)`, [orderId, headerOrderId]);
      await client.query(`DELETE FROM materials WHERE material_id = $1`, [matId]);
      await client.query(`DELETE FROM sheet_material_types WHERE sheet_material_type_id = $1`, [smtId]);
    } finally {
      client.release();
    }
  });

  it('8b. Legacy parity: views return materials.material_name when sheet_material_type_id IS NULL', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${schemaName}`);

      // A real material, no sheet type anywhere (pure legacy / pre-SP3 shape).
      const mat = await client.query<{ material_id: number }>(
        `INSERT INTO materials (material_name, unit_id) VALUES ('ЛДСП Дуб ТЕСТ', 1) RETURNING material_id`,
      );
      const matId = mat.rows[0].material_id;

      const ord = await client.query<{ order_id: number }>(
        `INSERT INTO orders (order_name, material_id) VALUES ('Тест-SP3-Legacy', $1) RETURNING order_id`,
        [matId],
      );
      const orderId = ord.rows[0].order_id;

      // sheet_material_type_id intentionally omitted → NULL (legacy detail).
      await client.query(
        `INSERT INTO order_details (order_id, detail_name, material_id)
         VALUES ($1, 'Деталь-Legacy', $2)`,
        [orderId, matId],
      );

      // order_details_view must return the materials name unchanged (COALESCE falls through).
      const detailView = await client.query<{ material_name: string; sheet_material_type_id: number | null }>(
        `SELECT material_name, sheet_material_type_id FROM order_details_view WHERE order_id = $1`,
        [orderId],
      );
      expect(detailView.rowCount).toBe(1);
      expect(detailView.rows[0].sheet_material_type_id).toBeNull();
      expect(detailView.rows[0].material_name).toBe('ЛДСП Дуб ТЕСТ');

      // orders_view header material_name must equal the materials name for a legacy order.
      const headerView = await client.query<{ material_name: string }>(
        `SELECT material_name FROM orders_view WHERE order_id = $1`,
        [orderId],
      );
      expect(headerView.rowCount).toBe(1);
      expect(headerView.rows[0].material_name).toBe('ЛДСП Дуб ТЕСТ');

      await client.query(`DELETE FROM order_details WHERE order_id = $1`, [orderId]);
      await client.query(`DELETE FROM orders WHERE order_id = $1`, [orderId]);
      await client.query(`DELETE FROM materials WHERE material_id = $1`, [matId]);
    } finally {
      client.release();
    }
  });

  it('9. Soft-delete exclusion: order_details_view excludes details of delete_flag=true orders', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${schemaName}`);

      // Insert a soft-deleted order
      const ord = await client.query<{ order_id: number }>(
        `INSERT INTO orders (order_name, delete_flag) VALUES ('Тест-удалённый-SP3', true) RETURNING order_id`,
      );
      const orderId = ord.rows[0].order_id;

      // Insert a detail for the deleted order
      await client.query(
        `INSERT INTO order_details (order_id, detail_name) VALUES ($1, 'Деталь-удалённая-SP3')`,
        [orderId],
      );

      // detail should NOT appear in the view
      const view = await client.query(
        `SELECT detail_id FROM order_details_view WHERE order_id = $1`,
        [orderId],
      );
      expect(view.rowCount).toBe(0);

      // Cleanup
      await client.query(`DELETE FROM order_details WHERE order_id = $1`, [orderId]);
      await client.query(`DELETE FROM orders WHERE order_id = $1`, [orderId]);
    } finally {
      client.release();
    }
  });

  // Migration 030: DB-boundary shadow-pairing trigger (tier2 critic finding 1). Proves a
  // direct write (bypassing the backend command) cannot inject a shadow material_id with a
  // null/mismatched sheet id, while legitimate legacy + sheet rows still insert.
  describe('Migration 030: shadow-pairing trigger', () => {
    let sheetId: number;
    let otherSheetId: number;
    let shadowId: number;
    let legacyId: number;

    beforeAll(async () => {
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO ${schemaName}`);
        const smt = await client.query<{ sheet_material_type_id: number }>(
          `INSERT INTO sheet_material_types (name, width_mm, height_mm)
           VALUES ('МДФ-030-ТЕСТ', 2800, 2070) RETURNING sheet_material_type_id`,
        );
        sheetId = smt.rows[0].sheet_material_type_id;
        const smt2 = await client.query<{ sheet_material_type_id: number }>(
          `INSERT INTO sheet_material_types (name, width_mm, height_mm)
           VALUES ('МДФ-030-ДРУГОЙ', 2800, 2070) RETURNING sheet_material_type_id`,
        );
        otherSheetId = smt2.rows[0].sheet_material_type_id;
        const shadow = await client.query<{ material_id: number }>(
          `INSERT INTO materials (material_name, unit_id, is_sheet_shadow, shadow_of_sheet_material_type_id)
           VALUES ('МДФ-030-ТЕСТ [лист]', 1, true, $1) RETURNING material_id`,
          [sheetId],
        );
        shadowId = shadow.rows[0].material_id;
        const legacy = await client.query<{ material_id: number }>(
          `INSERT INTO materials (material_name, unit_id) VALUES ('ЛДСП-030-ТЕСТ', 1) RETURNING material_id`,
        );
        legacyId = legacy.rows[0].material_id;
      } finally {
        client.release();
      }
    });

    async function insertDetail(materialId: number, sheetMaterialTypeId: number | null): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO ${schemaName}`);
        const ord = await client.query<{ order_id: number }>(
          `INSERT INTO orders (order_name) VALUES ('Тест-030') RETURNING order_id`,
        );
        const orderId = ord.rows[0].order_id;
        try {
          await client.query(
            `INSERT INTO order_details (order_id, detail_name, material_id, sheet_material_type_id)
             VALUES ($1, 'Деталь-030', $2, $3)`,
            [orderId, materialId, sheetMaterialTypeId],
          );
        } finally {
          await client.query(`DELETE FROM order_details WHERE order_id = $1`, [orderId]);
          await client.query(`DELETE FROM orders WHERE order_id = $1`, [orderId]);
        }
      } finally {
        client.release();
      }
    }

    it('allows a legacy detail (non-shadow material_id, NULL sheet id)', async () => {
      await expect(insertDetail(legacyId, null)).resolves.toBeUndefined();
    });

    it('allows a sheet detail whose shadow material_id matches its sheet id', async () => {
      await expect(insertDetail(shadowId, sheetId)).resolves.toBeUndefined();
    });

    it('BLOCKS a shadow material_id with a NULL sheet id (injection)', async () => {
      await expect(insertDetail(shadowId, null)).rejects.toThrow(/hidden sheet shadow/);
    });

    it('BLOCKS a shadow material_id with a DIFFERENT sheet id', async () => {
      await expect(insertDetail(shadowId, otherSheetId)).rejects.toThrow(/hidden sheet shadow/);
    });

    afterAll(async () => {
      await pool.query(`DELETE FROM materials WHERE material_id = ANY($1::bigint[])`, [[shadowId, legacyId]]);
      await pool.query(`DELETE FROM sheet_material_types WHERE sheet_material_type_id = ANY($1::bigint[])`, [
        [sheetId, otherSheetId],
      ]);
    });
  });
});
