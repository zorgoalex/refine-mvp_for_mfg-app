import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { LabelsService } from '../application/labels.service';
import { PgLabelsRepository } from './pg-labels-repository';

// Full-stack scanResolve integration against the LIVE erp_test schema (public,
// real tables/views — NOT a throwaway schema like the QR-templates test,
// because findScanCandidates reads order_details_view + orders + production_statuses
// + order_label_detail_data, which would be expensive/fragile to fully recreate).
// Gated on LABELS_INTEGRATION_DATABASE_URL (falls back to CUT_INTEGRATION_DATABASE_URL,
// same var the sibling adapters/*.integration.test.ts files use); skips cleanly
// without a database. All rows this file creates are deleted in afterAll, even on
// failure (order delete cascades to order_details + order_label_detail_data).
const databaseUrl = process.env.LABELS_INTEGRATION_DATABASE_URL ?? process.env.CUT_INTEGRATION_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

const namePrefix = `Тест-скан-${Date.now()}`;
const qrContentTemplate = '{order.order_name}|{bazis.col_005}|{bazis.position_in_product}';

function currentUser(userId: number): CurrentUser {
  return {
    id: String(userId),
    username: 'labels-scan-integration',
    role: 'admin',
    permissions: ['labels.view', 'labels.manage_templates', 'labels.generate'],
  } as unknown as CurrentUser;
}

function makeDatabase(pool: Pool): DatabaseService {
  return {
    isConfigured: true,
    query<T extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
      return pool.query<T>(text, [...params]);
    },
    async transaction<T>(handler: (client: TransactionClient) => Promise<T>): Promise<T> {
      const raw: PoolClient = await pool.connect();
      try {
        await raw.query('BEGIN');
        const tx: TransactionClient = {
          raw: raw as never,
          query: (text: string, params: readonly unknown[] = []) => raw.query(text, [...params]),
        };
        const result = await handler(tx);
        await raw.query('COMMIT');
        return result;
      } catch (error) {
        await raw.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        raw.release();
      }
    },
  } as unknown as DatabaseService;
}

describeIntegration('LabelsService.scanResolve (integration, erp_test)', () => {
  let pool: Pool;
  let repo: PgLabelsRepository;
  let service: LabelsService;
  let user: CurrentUser;

  // Reference ids resolved at runtime (not hardcoded) so this test tolerates
  // whatever seed data the target erp_test happens to have.
  let clientId: number;
  let orderStatusId: number;
  let paymentStatusId: number;
  let sheetMaterialTypeId: number;
  let millingTypeId: number;
  let edgeTypeId: number;
  let labelTemplateId: number;
  let actorUserId: number;

  let qrTemplateId: number;
  let qrTemplateCreatedByUs = false;

  let orderId: number;
  let detailId: number;
  const renamedOrderName = `${namePrefix}-renamed`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });

    const [clientRow, orderStatusRow, paymentStatusRow, sheetTypeRow, millingRow, edgeRow, templateRow, userRow] = await Promise.all([
      pool.query<{ client_id: string }>('SELECT client_id FROM clients ORDER BY client_id LIMIT 1'),
      pool.query<{ order_status_id: number }>('SELECT order_status_id FROM order_statuses ORDER BY order_status_id LIMIT 1'),
      pool.query<{ payment_status_id: number }>('SELECT payment_status_id FROM payment_statuses ORDER BY payment_status_id LIMIT 1'),
      pool.query<{ sheet_material_type_id: string }>(
        'SELECT sheet_material_type_id FROM sheet_material_types WHERE is_active = true ORDER BY sheet_material_type_id LIMIT 1',
      ),
      pool.query<{ milling_type_id: number }>('SELECT milling_type_id FROM milling_types ORDER BY milling_type_id LIMIT 1'),
      pool.query<{ edge_type_id: number }>('SELECT edge_type_id FROM edge_types ORDER BY edge_type_id LIMIT 1'),
      pool.query<{ label_template_id: string }>(
        "SELECT label_template_id FROM label_templates WHERE is_active = true AND deleted_at IS NULL ORDER BY label_template_id LIMIT 1",
      ),
      pool.query<{ user_id: string }>('SELECT user_id FROM users ORDER BY user_id LIMIT 1'),
    ]);

    if (
      clientRow.rowCount === 0 ||
      orderStatusRow.rowCount === 0 ||
      paymentStatusRow.rowCount === 0 ||
      sheetTypeRow.rowCount === 0 ||
      millingRow.rowCount === 0 ||
      edgeRow.rowCount === 0 ||
      templateRow.rowCount === 0 ||
      userRow.rowCount === 0
    ) {
      throw new Error(
        'label-scan.integration.test.ts: erp_test is missing baseline reference rows (clients/order_statuses/' +
          'payment_statuses/sheet_material_types/milling_types/edge_types/label_templates/users) required to seed a test order.',
      );
    }

    clientId = Number(clientRow.rows[0].client_id);
    orderStatusId = Number(orderStatusRow.rows[0].order_status_id);
    paymentStatusId = Number(paymentStatusRow.rows[0].payment_status_id);
    sheetMaterialTypeId = Number(sheetTypeRow.rows[0].sheet_material_type_id);
    millingTypeId = Number(millingRow.rows[0].milling_type_id);
    edgeTypeId = Number(edgeRow.rows[0].edge_type_id);
    labelTemplateId = Number(templateRow.rows[0].label_template_id);
    actorUserId = Number(userRow.rows[0].user_id);
    user = currentUser(actorUserId);

    repo = new PgLabelsRepository(makeDatabase(pool));
    service = new LabelsService({ repo });

    // Reuse an identical active QR template if one already exists on erp_test;
    // otherwise create one scoped to this test run (deleted in afterAll).
    const existingTemplate = await pool.query<{ label_qr_template_id: string }>(
      'SELECT label_qr_template_id FROM label_qr_templates WHERE is_active = true AND content_template = $1 LIMIT 1',
      [qrContentTemplate],
    );
    if (existingTemplate.rowCount && existingTemplate.rowCount > 0) {
      qrTemplateId = Number(existingTemplate.rows[0].label_qr_template_id);
      qrTemplateCreatedByUs = false;
    } else {
      const created = await pool.query<{ label_qr_template_id: string }>(
        `INSERT INTO label_qr_templates (name, content_template, error_correction, default_size_mm, is_active, created_by, updated_by)
         VALUES ($1, $2, 'M', 20, true, $3, $3)
         RETURNING label_qr_template_id`,
        [`${namePrefix} qr`, qrContentTemplate, actorUserId],
      );
      qrTemplateId = Number(created.rows[0].label_qr_template_id);
      qrTemplateCreatedByUs = true;
    }

    // Order Тест-скан-<timestamp> + detail (detail_number=1, width=50, height=750).
    const orderRow = await pool.query<{ order_id: string }>(
      `INSERT INTO orders (order_name, client_id, order_status_id, payment_status_id, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING order_id`,
      [namePrefix, clientId, orderStatusId, paymentStatusId, actorUserId],
    );
    orderId = Number(orderRow.rows[0].order_id);

    const width = 50;
    const height = 750;
    const area = Math.round(((width * height) / 1_000_000) * 100) / 100;
    const detailRow = await pool.query<{ detail_id: string }>(
      `INSERT INTO order_details
         (order_id, detail_number, height, width, quantity, area, milling_type_id, edge_type_id, sheet_material_type_id, created_by)
       VALUES ($1, 1, $2, $3, 1, $4, $5, $6, $7, $8)
       RETURNING detail_id`,
      [orderId, height, width, area, millingTypeId, edgeTypeId, sheetMaterialTypeId, actorUserId],
    );
    detailId = Number(detailRow.rows[0].detail_id);
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      if (orderId != null) {
        // Scenario 2's real updateOrderLabelData path also writes audit_log
        // (+ audit_log_related_entity, which cascades via its FK on audit_id) —
        // no FK cascade from orders, so delete explicitly. related_order_id =
        // our orderId is exclusive to this run (the order is created fresh above).
        await pool.query('DELETE FROM audit_log WHERE related_order_id = $1', [orderId]);
        // Cascades to order_details + order_label_detail_data.
        await pool.query('DELETE FROM orders WHERE order_id = $1', [orderId]);
      }
      // command_idempotency_keys has no cascade either; PK = the exact key
      // scenario 2 passed to updateOrderLabelData.
      await pool.query('DELETE FROM command_idempotency_keys WHERE idempotency_key = $1', [`${namePrefix}-snapshot-seed`]);
      if (qrTemplateCreatedByUs && qrTemplateId != null) {
        await pool.query('DELETE FROM label_qr_templates WHERE label_qr_template_id = $1', [qrTemplateId]);
      }
    } finally {
      await pool.end();
    }
  }, 30_000);

  it(
    '1) resolves the seeded detail by QR-template match on order_name + detail_number',
    async () => {
      const payload = `${namePrefix}|60084|1`;
      const result = await service.scanResolve({
        currentUser: user,
        requestId: 'req-scan-int-1',
        payload,
        source: 'qr',
      });

      expect(result.candidates).toHaveLength(1);
      const candidate = result.candidates[0];
      expect(candidate.detailId).toBe(detailId);
      expect(candidate.orderId).toBe(orderId);
      expect(candidate.matchedFields).toEqual(expect.arrayContaining(['order_name', 'detail_number']));
    },
    20_000,
  );

  it(
    '2) seeds a print snapshot via the real updateOrderLabelData path, then finds it by snapshot after a rename (pins bazis_fields key format)',
    async () => {
      // Seed via the REAL service path (not a direct INSERT) so this test fails
      // loudly if toSnapshotKey's assumed key format ever drifts from the write path.
      await service.updateOrderLabelData({
        currentUser: user,
        requestId: 'req-scan-int-2-seed',
        orderId,
        input: {
          templateId: labelTemplateId,
          rows: [
            {
              detailId,
              bazisFields: { 'bazis.col_005': '60084', 'bazis.position_in_product': '1' },
            },
          ],
          idempotencyKey: `${namePrefix}-snapshot-seed`,
        },
      });

      // Rename the order — the OLD name only survives inside the print snapshot now.
      await pool.query('UPDATE orders SET order_name = $1 WHERE order_id = $2', [renamedOrderName, orderId]);

      const payload = `${namePrefix}|60084|1`; // still the OLD name
      const result = await service.scanResolve({
        currentUser: user,
        requestId: 'req-scan-int-2-resolve',
        payload,
        source: 'qr',
      });

      const candidate = result.candidates.find((c) => c.detailId === detailId);
      expect(candidate).toBeDefined();
      expect(candidate?.orderId).toBe(orderId);
      expect(candidate?.orderName).toBe(renamedOrderName);
      expect(candidate?.matchedFields).toEqual(expect.arrayContaining(['snapshot']));
    },
    20_000,
  );

  it(
    '3) excludes the order once it is soft-deleted',
    async () => {
      await pool.query('UPDATE orders SET delete_flag = true WHERE order_id = $1', [orderId]);

      const result = await service.scanResolve({
        currentUser: user,
        requestId: 'req-scan-int-3',
        payload: renamedOrderName,
        source: 'manual',
      });

      expect(result.candidates).toHaveLength(0);
    },
    20_000,
  );

  it(
    '4) rejects an empty payload with 422',
    async () => {
      await expect(
        service.scanResolve({ currentUser: user, requestId: 'req-scan-int-4a', payload: '', source: 'manual' }),
      ).rejects.toMatchObject({ statusCode: 422, code: 'LABEL_SCAN_PAYLOAD_EMPTY' });
    },
    20_000,
  );

  it(
    '5) returns zero candidates for a nonexistent order name',
    async () => {
      const result = await service.scanResolve({
        currentUser: user,
        requestId: 'req-scan-int-4b',
        payload: `${namePrefix}-does-not-exist`,
        source: 'manual',
      });
      expect(result.candidates).toHaveLength(0);
    },
    20_000,
  );
});
