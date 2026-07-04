import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { LabelsService } from '../application/labels.service';
import type { OcrPort } from '../application/labels.types';
import { PgLabelsRepository } from './pg-labels-repository';

// Full-stack scanResolveFields/scanResolveImage integration against the LIVE erp_test
// schema (public, real tables/views), sibling to label-scan.integration.test.ts (which
// covers the v1 QR-payload scanResolve flow). Gated on LABELS_INTEGRATION_DATABASE_URL
// (falls back to CUT_INTEGRATION_DATABASE_URL, same var the other adapters/*.integration
// .test.ts files use); skips cleanly without a database.
//
// scanResolveFields/scanResolveImage are READ-ONLY on the repo side (PgLabelsRepository
// .findScanCandidates is a single SELECT, no writes) — unlike v1 scenario 2's
// updateOrderLabelData seeding, there is no audit_log/command_idempotency_keys row to
// clean up here. Only the seeded order + its cascaded detail need deleting.
//
// OcrPort is a FAKE injected directly into the LabelsService constructor (same pattern as
// application/labels.service.scan-image.test.ts) — no live ocr-service is required or
// contacted by this test.
const databaseUrl = process.env.LABELS_INTEGRATION_DATABASE_URL ?? process.env.CUT_INTEGRATION_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

const ts = Date.now();
// Cleanup-friendly prefix ('Тест-ОCR-%') combined with a realistic order-name shape
// ('548-16мм') so extractLabelFields' Заказ№: capture behaves like it would on a real
// printed label, while staying unmistakably test data (unique per run via ts).
const namePrefix = `Тест-ОCR-${ts}`;
const orderName = `${namePrefix} 548-16мм`;

function currentUser(userId: number): CurrentUser {
  return {
    id: String(userId),
    username: 'labels-scan-image-integration',
    role: 'admin',
    permissions: ['labels.view'],
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

describeIntegration('LabelsService.scanResolveFields / scanResolveImage (integration, erp_test)', () => {
  let pool: Pool;
  let repo: PgLabelsRepository;
  let service: LabelsService;
  let user: CurrentUser;

  // Reference ids resolved at runtime (not hardcoded) so this test tolerates whatever
  // seed data the target erp_test happens to have.
  let clientId: number;
  let orderStatusId: number;
  let paymentStatusId: number;
  let sheetMaterialTypeId: number;
  let millingTypeId: number;
  let edgeTypeId: number;
  let actorUserId: number;

  let orderId: number;
  let detailId: number;
  const detailNumber = 27;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });

    const [clientRow, orderStatusRow, paymentStatusRow, sheetTypeRow, millingRow, edgeRow, userRow] = await Promise.all([
      pool.query<{ client_id: string }>('SELECT client_id FROM clients ORDER BY client_id LIMIT 1'),
      pool.query<{ order_status_id: number }>('SELECT order_status_id FROM order_statuses ORDER BY order_status_id LIMIT 1'),
      pool.query<{ payment_status_id: number }>('SELECT payment_status_id FROM payment_statuses ORDER BY payment_status_id LIMIT 1'),
      pool.query<{ sheet_material_type_id: string }>(
        'SELECT sheet_material_type_id FROM sheet_material_types WHERE is_active = true ORDER BY sheet_material_type_id LIMIT 1',
      ),
      pool.query<{ milling_type_id: number }>('SELECT milling_type_id FROM milling_types ORDER BY milling_type_id LIMIT 1'),
      pool.query<{ edge_type_id: number }>('SELECT edge_type_id FROM edge_types ORDER BY edge_type_id LIMIT 1'),
      pool.query<{ user_id: string }>('SELECT user_id FROM users ORDER BY user_id LIMIT 1'),
    ]);

    if (
      clientRow.rowCount === 0 ||
      orderStatusRow.rowCount === 0 ||
      paymentStatusRow.rowCount === 0 ||
      sheetTypeRow.rowCount === 0 ||
      millingRow.rowCount === 0 ||
      edgeRow.rowCount === 0 ||
      userRow.rowCount === 0
    ) {
      throw new Error(
        'label-scan-image.integration.test.ts: erp_test is missing baseline reference rows (clients/order_statuses/' +
          'payment_statuses/sheet_material_types/milling_types/edge_types/users) required to seed a test order.',
      );
    }

    clientId = Number(clientRow.rows[0].client_id);
    orderStatusId = Number(orderStatusRow.rows[0].order_status_id);
    paymentStatusId = Number(paymentStatusRow.rows[0].payment_status_id);
    sheetMaterialTypeId = Number(sheetTypeRow.rows[0].sheet_material_type_id);
    millingTypeId = Number(millingRow.rows[0].milling_type_id);
    edgeTypeId = Number(edgeRow.rows[0].edge_type_id);
    actorUserId = Number(userRow.rows[0].user_id);
    user = currentUser(actorUserId);

    repo = new PgLabelsRepository(makeDatabase(pool));
    service = new LabelsService({ repo });

    // Order `Тест-ОCR-<ts> 548-16мм` + one detail (detail_number=27, width=902, height=596 —
    // matches the fake OCR label lines used in scenario 3 below).
    const orderRow = await pool.query<{ order_id: string }>(
      `INSERT INTO orders (order_name, client_id, order_status_id, payment_status_id, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING order_id`,
      [orderName, clientId, orderStatusId, paymentStatusId, actorUserId],
    );
    orderId = Number(orderRow.rows[0].order_id);

    const width = 902;
    const height = 596;
    const area = Math.round(((width * height) / 1_000_000) * 100) / 100;
    const detailRow = await pool.query<{ detail_id: string }>(
      `INSERT INTO order_details
         (order_id, detail_number, height, width, quantity, area, milling_type_id, edge_type_id, sheet_material_type_id, created_by)
       VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9)
       RETURNING detail_id`,
      [orderId, detailNumber, height, width, area, millingTypeId, edgeTypeId, sheetMaterialTypeId, actorUserId],
    );
    detailId = Number(detailRow.rows[0].detail_id);
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      if (orderId != null) {
        // Cascades to order_details (no other tables are written by this read-only flow).
        await pool.query('DELETE FROM orders WHERE order_id = $1', [orderId]);
      }
      const leftover = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM orders WHERE order_name LIKE 'Тест-ОCR-%'",
      );
      if (Number(leftover.rows[0]?.count ?? '0') !== 0) {
        throw new Error(
          `label-scan-image.integration.test.ts: cleanup left ${leftover.rows[0]?.count} orphaned 'Тест-ОCR-%' order(s).`,
        );
      }
    } finally {
      await pool.end();
    }
  }, 30_000);

  it(
    '1) scanResolveFields resolves the seeded detail by exact orderName + detailNumber match',
    async () => {
      const result = await service.scanResolveFields({
        currentUser: user,
        requestId: 'req-scan-image-int-1',
        fields: { orderName, detailNumber },
      });

      expect(result.candidates.length).toBeGreaterThan(0);
      const top = result.candidates[0];
      expect(top.detailId).toBe(detailId);
      expect(top.orderId).toBe(orderId);
      expect(top.matchedFields).toEqual(expect.arrayContaining(['order_name', 'detail_number']));
    },
    20_000,
  );

  it(
    '2) scanResolveFields returns zero candidates for nonexistent fields',
    async () => {
      const result = await service.scanResolveFields({
        currentUser: user,
        requestId: 'req-scan-image-int-2',
        fields: { orderName: `${namePrefix}-does-not-exist`, detailNumber: 30_000 },
      });
      expect(result.candidates).toHaveLength(0);
    },
    20_000,
  );

  it(
    '3) scanResolveImage: fake OcrPort returns real-label-shaped lines -> candidates found via extracted fields',
    async () => {
      const lines = [
        { text: ':N', score: 0.5 },
        { text: '2590', score: 0.6 },
        { text: `Заказ№: ${orderName}`, score: 0.95 },
        { text: 'Поз. 27', score: 0.92 },
        { text: 'МДФ 16 мм', score: 0.8 },
        { text: '902 X 596', score: 0.85 },
        { text: '24.06.2026', score: 0.7 },
      ];
      const ocr: OcrPort = { recognize: vi.fn().mockResolvedValue({ lines, durationMs: 55 }) };
      const serviceWithOcr = new LabelsService({ repo, ocr });

      const result = await serviceWithOcr.scanResolveImage({
        currentUser: user,
        requestId: 'req-scan-image-int-3',
        image: Buffer.from('fake-label-photo-bytes'),
        contentType: 'image/jpeg',
      });

      expect(ocr.recognize).toHaveBeenCalledWith(Buffer.from('fake-label-photo-bytes'), 'image/jpeg');
      expect(result.ocr.lineCount).toBeGreaterThan(0);
      expect(result.parsed?.orderName).toBe(orderName);
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates.some((c) => c.detailId === detailId)).toBe(true);
    },
    20_000,
  );

  it(
    '4) scanResolveImage propagates an OcrPort 503 as-is',
    async () => {
      const ocr: OcrPort = {
        recognize: vi.fn().mockRejectedValue(new ApiError(503, 'OCR_SERVICE_UNAVAILABLE', 'OCR service is unavailable')),
      };
      const serviceWithFailingOcr = new LabelsService({ repo, ocr });

      await expect(
        serviceWithFailingOcr.scanResolveImage({
          currentUser: user,
          requestId: 'req-scan-image-int-4',
          image: Buffer.from('x'),
          contentType: 'image/png',
        }),
      ).rejects.toMatchObject({ statusCode: 503, code: 'OCR_SERVICE_UNAVAILABLE' });
    },
    20_000,
  );
});
