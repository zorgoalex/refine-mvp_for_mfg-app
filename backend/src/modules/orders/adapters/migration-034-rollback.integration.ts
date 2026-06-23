// backend/src/modules/orders/adapters/migration-034-rollback.integration.ts
// Integration test: apply 034 then 034_rollback, assert Variant-A invariants are restored.
// Uses an ephemeral Postgres; set SHEET_INTEGRATION_DATABASE_URL to enable.
//
// ISOLATION: this file runs its ENTIRE lifecycle inside a dedicated schema
// (vb_rollback_<hrtime>) so it never touches `public` and cannot collide with
// sibling integration files (029-apply, 034-apply, shadow-material) that all
// create objects in public in parallel.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrapVariantBSchema,
  seedVariantAMain,
} from './__fixtures__/variant-b-migration-fixture';

const url = process.env.SHEET_INTEGRATION_DATABASE_URL;
const d = url ? describe : describe.skip;
const mig = (n: string) =>
  readFileSync(join(__dirname, '../../../../db/migrations', n), 'utf8');

d('migration 034 rollback (Variant B → Variant A revert)', () => {
  const client = new Client({ connectionString: url });
  // Unique schema name for this run — avoids collision even under rapid re-runs.
  const schema = `vb_rollback_${process.hrtime.bigint()}`;

  beforeAll(async () => {
    await client.connect();

    // Create the isolated schema and put it first on the search path.
    // All subsequent DDL/DML (bootstrap, seed, migrations) lands here, not in public.
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);

    // Apply the full forward chain first: bootstrap + seed Variant-A data + 034.
    await bootstrapVariantBSchema(client);
    await seedVariantAMain(client);
    await client.query(mig('034_order_material_sunset_legacy.sql'));
    // Now apply the rollback.
    await client.query(mig('034_rollback.sql'));
  });

  afterAll(async () => {
    // Reset search_path before dropping the schema (avoids stale path on re-use).
    try { await client.query(`SET search_path TO public`); } catch { /* ignore */ }
    try { await client.query(`DROP SCHEMA ${schema} CASCADE`); } catch { /* ignore */ }
    await client.end();
  });

  it('every non-deleted detail has material_id NOT NULL after rollback', async () => {
    const r = await client.query(
      `SELECT count(*)::int n FROM order_details WHERE delete_flag = false AND material_id IS NULL`,
    );
    expect(r.rows[0].n).toBe(0);
  });

  it('every non-deleted detail material_id points at an is_sheet_shadow row matching its sheet', async () => {
    const r = await client.query(`
      SELECT count(*)::int n
      FROM order_details od
      INNER JOIN materials m ON m.material_id = od.material_id
      WHERE od.delete_flag = false
        AND m.is_sheet_shadow = true
        AND m.shadow_of_sheet_material_type_id = od.sheet_material_type_id
    `);
    const total = await client.query(
      `SELECT count(*)::int n FROM order_details WHERE delete_flag = false`,
    );
    // All non-deleted details should be covered
    expect(r.rows[0].n).toBe(total.rows[0].n);
  });

  it('the 030 shadow_pairing trigger is restored with the correct name trg_order_detail_shadow_pairing', async () => {
    const r = await client.query(`
      SELECT count(*)::int n FROM pg_trigger
      WHERE tgname = 'trg_order_detail_shadow_pairing'
        AND tgrelid = 'order_details'::regclass
    `);
    expect(r.rows[0].n).toBe(1);
  });

  it('the wrongly-named order_detail_shadow_pairing trigger is NOT present after rollback', async () => {
    const r = await client.query(`
      SELECT count(*)::int n FROM pg_trigger
      WHERE tgname = 'order_detail_shadow_pairing'
        AND tgrelid = 'order_details'::regclass
    `);
    expect(r.rows[0].n).toBe(0);
  });

  it('chk_orders_sheet_xor_material constraint is restored', async () => {
    const r = await client.query(`
      SELECT count(*)::int n FROM pg_constraint
      WHERE conname = 'chk_orders_sheet_xor_material'
        AND conrelid = 'orders'::regclass
    `);
    expect(r.rows[0].n).toBe(1);
  });

  it('order_details_view returns non-null material_name for a rolled-back legacy-material detail', async () => {
    // After rollback: order_details_view uses COALESCE(m.material_name, smt.name).
    // The live detail (delete_flag=false) has material_id pointing at its shadow material,
    // so material_name must be non-null and non-empty.
    const r = await client.query<{ material_name: string | null }>(`
      SELECT material_name
      FROM order_details_view
      LIMIT 1
    `);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows[0].material_name).toBeTruthy();
  });

  it('orders_view returns non-null material_name for orders after rollback', async () => {
    // After rollback: orders_view uses COALESCE(smt.name, m.material_name).
    // Legacy order has material_id=161 → m.material_name should resolve.
    // Sheet-seeded order has sheet_material_type_id → smt.name takes priority.
    const r = await client.query<{ order_name: string; material_name: string | null }>(`
      SELECT order_name, material_name
      FROM orders_view
      WHERE order_name = 'VB заказ легаси'
    `);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].material_name).toBeTruthy();
  });

  it('order_details_view after rollback hides details belonging to a SOFT-DELETED order (Critic R7 M3)', async () => {
    // Seed: a live detail under a soft-deleted order.
    // After rollback, order_details_view must NOT expose it (orders.delete_flag join).
    // seedVariantAMain already inserts a soft-deleted order (VB удалённый заказ) with
    // a soft-deleted detail (delete_flag=true). We need a LIVE detail (delete_flag=false)
    // under a SOFT-DELETED order to prove the orders-join filter is present.
    const softDelOrdRes = await client.query<{ order_id: number }>(
      `INSERT INTO orders (order_name, delete_flag) VALUES ('RB тест мягко удалён', true) RETURNING order_id`,
    );
    const softDelOrdId: number = softDelOrdRes.rows[0].order_id;

    // A live detail (delete_flag=false) attached to the soft-deleted order.
    await client.query(
      `INSERT INTO order_details (order_id, detail_number, detail_name, height, width, quantity, area,
         material_id, milling_type_id, edge_type_id, priority)
       VALUES ($1, 99, 'RB утечка деталь', 100, 100, 1, 0.01,
         (SELECT material_id FROM materials WHERE is_sheet_shadow = false LIMIT 1),
         1, 1, 100)`,
      [softDelOrdId],
    );

    // After rollback, this detail must NOT appear in order_details_view.
    const r = await client.query(
      `SELECT count(*)::int n FROM order_details_view WHERE order_id = $1`,
      [softDelOrdId],
    );
    expect(r.rows[0].n).toBe(0); // hidden by orders.delete_flag join
  });

  it('rollback is idempotent: re-applying 034_rollback leaves the same state', async () => {
    // Apply rollback a second time — must not error or double-insert shadows.
    await client.query(mig('034_rollback.sql'));
    const shadows = await client.query(
      `SELECT count(*)::int n FROM materials WHERE is_sheet_shadow = true`,
    );
    // Should not have doubled
    const shadowsByType = await client.query(
      `SELECT shadow_of_sheet_material_type_id, count(*)::int n FROM materials WHERE is_sheet_shadow = true GROUP BY shadow_of_sheet_material_type_id HAVING count(*) > 1`,
    );
    expect(shadowsByType.rows).toHaveLength(0);
    // details still all covered
    const uncovered = await client.query(
      `SELECT count(*)::int n FROM order_details WHERE delete_flag = false AND material_id IS NULL`,
    );
    expect(uncovered.rows[0].n).toBe(0);
  });
});

// Roundtrip test: rollback → re-apply 034 must succeed with no dangling trigger or
// DROP FUNCTION dependency error. This is the exact failure scenario described in
// Finding 1: if the rollback recreates the trigger with the WRONG name, re-applying
// 034 would leave a stale trigger attached to the function, causing
// `DROP FUNCTION IF EXISTS assert_order_detail_shadow_pairing()` to fail on dependency.
d('migration 034 rollback→forward roundtrip (no dangling trigger / no DROP FUNCTION dependency)', () => {
  const client = new Client({ connectionString: url });
  const schema = `vb_roundtrip_${process.hrtime.bigint()}`;

  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);

    // Forward chain: bootstrap + seed + apply 034.
    await bootstrapVariantBSchema(client);
    await seedVariantAMain(client);
    await client.query(mig('034_order_material_sunset_legacy.sql'));

    // Rollback: must leave trigger with the correct name so 034 can drop it again.
    await client.query(mig('034_rollback.sql'));

    // Re-apply 034: must succeed — DROP TRIGGER must find the correct name, and
    // DROP FUNCTION must not fail on a dangling dependency.
    // If the rollback used the wrong trigger name, this throws here.
    await client.query(mig('034_order_material_sunset_legacy.sql'));
  });

  afterAll(async () => {
    try { await client.query(`SET search_path TO public`); } catch { /* ignore */ }
    try { await client.query(`DROP SCHEMA ${schema} CASCADE`); } catch { /* ignore */ }
    await client.end();
  });

  it('034 re-applied cleanly: assert_order_detail_shadow_pairing function is gone (no dependency error)', async () => {
    const r = await client.query(`
      SELECT count(*)::int n FROM pg_proc
      WHERE proname = 'assert_order_detail_shadow_pairing'
        AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
    `);
    expect(r.rows[0].n).toBe(0);
  });

  it('034 re-applied cleanly: trg_order_detail_shadow_pairing trigger is gone', async () => {
    const r = await client.query(`
      SELECT count(*)::int n FROM pg_trigger
      WHERE tgname = 'trg_order_detail_shadow_pairing'
        AND tgrelid = 'order_details'::regclass
    `);
    expect(r.rows[0].n).toBe(0);
  });

  it('034 re-applied cleanly: no stale order_detail_shadow_pairing trigger either', async () => {
    const r = await client.query(`
      SELECT count(*)::int n FROM pg_trigger
      WHERE tgname = 'order_detail_shadow_pairing'
        AND tgrelid = 'order_details'::regclass
    `);
    expect(r.rows[0].n).toBe(0);
  });

  it('034 re-applied cleanly: order_details.material_id is nullable', async () => {
    const r = await client.query(`
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_name = 'order_details'
        AND column_name = 'material_id'
        AND table_schema = current_schema()
    `);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].is_nullable).toBe('YES');
  });
});
