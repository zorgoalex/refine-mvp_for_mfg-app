import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { OrderAccessPolicy } from '../../../permissions/policies/order-access.policy';
import type {
  ExportedOrderSnapshotBatchFile,
  ExportedOrderSnapshotFile,
  ExportOrderSnapshotBatchCommand,
  ExportOrderSnapshotCommand,
  ImportOrderSnapshotBatchCommand,
  ImportOrderSnapshotCommand,
  OrderSnapshotPort,
} from '../application/order-snapshot.types';
import {
  ORDER_SNAPSHOT_FORMAT_VERSION,
  ORDER_SNAPSHOT_SCHEMA,
  ORDER_SNAPSHOT_SERVICE_NAME,
  ORDER_SNAPSHOT_SERVICE_VERSION,
  ORDER_SNAPSHOT_SUPPORTED_IMPORT_VERSIONS,
  type ClientPhoneSnapshotDto,
  type DowelingOrderSnapshotDto,
  type ImportOrderSnapshotBatchResponseDto,
  type ImportOrderSnapshotResponseDto,
  type OrderSnapshotDetailDto,
  type OrderSnapshotDto,
  type OrderSnapshotDowelingLinkDto,
  type OrderSnapshotPaymentDto,
  type OrderSnapshotRequirementDto,
  type OrderSnapshotWorkshopDto,
  type ProductionStatusEventSnapshotDto,
} from '../dto/order-snapshot.dto';
import type {
  CalculatedOrderDetailDto,
  NormalizedSaveOrderDowelingLinkDto,
  NormalizedSaveOrderHeaderDto,
  NormalizedSaveOrderPaymentDto,
  NormalizedSaveOrderRequirementDto,
  NormalizedSaveOrderWorkshopDto,
  OrderTotalsDto,
  SaveOrderDto,
} from '../dto/save-order.dto';
import { prepareOrderSave } from '../domain/order-save-preparer';
import { OrderNotFoundError } from '../errors/order.errors';
// Note: shadow-material helpers (resolveShadowMaterialId, buildShadowMaterialAuditEvent,
// ShadowContext) and SNAPSHOT_IMPORT_SOURCE removed in Variant B (Task 4): post-034 migration
// we no longer create/sync synthetic shadow materials during snapshot import.
import {
  assertSheetEligibilityAndNoClear,
  validateSheetReferences,
  type SheetValidationDetail,
  type SheetValidationHeader,
  type StoredSheetDetail,
} from '../domain/sheet-order-validation';

type AnyRow = QueryResultRow & Record<string, unknown>;
type ImportStatus = 'created' | 'updated' | 'noop';

const SOURCE = 'backend-orders-command';
// SNAPSHOT_IMPORT_SOURCE removed in Variant B (Task 4): no longer used after shadow material removal.

const SNAPSHOT_ENTITY_TYPES = {
  order: 'order',
  client: 'client',
  clientPhone: 'client_phone',
  detail: 'order_detail',
  payment: 'payment',
  workshop: 'order_workshop',
  requirement: 'order_resource_requirement',
  dowelingOrder: 'doweling_order',
  dowelingLink: 'order_doweling_link',
  productionEvent: 'production_status_event',
  deadlineInstance: 'deadline_instance',
  deadlineEvent: 'deadline_event',
} as const;

interface ImportMapRow extends QueryResultRow {
  local_entity_id: string;
  payload_hash: string | null;
}

interface IdRow extends QueryResultRow {
  id: string | number;
}

interface SourceInstanceRow extends QueryResultRow {
  source_instance_id: string;
}

interface OrderScopeRow extends QueryResultRow {
  manager_id: string | number | null;
  created_by: string | number | null;
}

interface ImportRunRow extends QueryResultRow {
  import_run_id: string;
}

export class PgOrderSnapshot implements OrderSnapshotPort {
  private readonly orderPolicy = new OrderAccessPolicy();

  constructor(private readonly database: DatabaseService) {}

  async exportOrderSnapshot(command: ExportOrderSnapshotCommand): Promise<ExportedOrderSnapshotFile> {
    const snapshot = await this.database.transaction(async (tx) => {
      await this.assertCanExport(tx, command);
      const built = await buildSnapshot(tx, command.orderId);
      await writeAudit(tx, 'orders.snapshot_export', command.currentUser, command.orderId, built.data.order.clientId, {
        requestId: command.requestId,
        formatVersion: ORDER_SNAPSHOT_FORMAT_VERSION,
        serviceVersion: ORDER_SNAPSHOT_SERVICE_VERSION,
      });
      return built;
    });

    return {
      fileName: snapshotFileName(snapshot),
      content: JSON.stringify(snapshot, null, 2),
    };
  }

  async exportOrderSnapshotBatch(
    command: ExportOrderSnapshotBatchCommand,
  ): Promise<ExportedOrderSnapshotBatchFile> {
    validateDateOnly(command.dateFrom, 'dateFrom');
    validateDateOnly(command.dateTo, 'dateTo');
    if (command.dateFrom > command.dateTo) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'dateFrom must be before or equal to dateTo');
    }

    const orderIds = await this.readBatchOrderIds(command);
    const zip = new JSZip();

    for (const orderId of orderIds) {
      const file = await this.exportOrderSnapshot({ ...command, orderId });
      zip.file(file.fileName, file.content);
    }

    const content = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

    return {
      fileName: batchSnapshotFileName(command.dateFrom, command.dateTo),
      content,
      orderCount: orderIds.length,
    };
  }

  async importOrderSnapshot(
    command: ImportOrderSnapshotCommand,
  ): Promise<ImportOrderSnapshotResponseDto> {
    const snapshot = assertSupportedSnapshot(command.snapshot);
    const payloadHash = calculateSnapshotHash(snapshot);

    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        snapshot.source.sourceInstanceId,
        snapshot.identity.order.sourceId,
      ]);

      const runId = await startImportRun(tx, snapshot, payloadHash, command);
      try {
        const result = await importSnapshotInTransaction(tx, snapshot, payloadHash, runId, command);
        await finishImportRun(tx, runId, result.status, result.orderId, result.summary);
        await writeAudit(
          tx,
          result.status === 'noop' ? 'orders.snapshot_import.noop' : 'orders.snapshot_import',
          command.currentUser,
          result.orderId,
          null, // relatedClientId unavailable before payload build; local clientId not returned from importSnapshotInTransaction
          {
            requestId: command.requestId,
            payloadHash,
            importRunId: runId,
            status: result.status,
            formatVersion: snapshot.formatVersion,
            serviceVersion: snapshot.exporterService.version,
          },
          collectSnapshotSheetIds(snapshot),
        );
        return { ...result, importRunId: runId };
      } catch (error) {
        await failImportRun(tx, runId, error);
        throw error;
      }
    });
  }

  async importOrderSnapshotBatch(
    command: ImportOrderSnapshotBatchCommand,
  ): Promise<ImportOrderSnapshotBatchResponseDto> {
    const zip = await JSZip.loadAsync(Buffer.from(command.zipBase64, 'base64'));
    const files = Object.values(zip.files).filter(
      (file) => !file.dir && file.name.toLowerCase().endsWith('.json'),
    );
    const results: ImportOrderSnapshotBatchResponseDto['results'] = [];

    for (const file of files) {
      try {
        const raw = await file.async('string');
        const snapshot = JSON.parse(raw) as OrderSnapshotDto;
        const result = await this.importOrderSnapshot({ ...command, snapshot });
        results.push({ fileName: file.name, ...result });
      } catch (error) {
        results.push({
          fileName: file.name,
          success: false,
          errorCode: error instanceof ApiError ? error.code : 'ORDER_SNAPSHOT_IMPORT_FAILED',
          message: error instanceof Error ? error.message : 'Order snapshot import failed',
        });
      }
    }

    const failed = results.filter((result) => result.success === false).length;

    return {
      success: true,
      total: results.length,
      imported: results.length - failed,
      failed,
      results,
    };
  }

  private async assertCanExport(
    tx: TransactionClient,
    command: ExportOrderSnapshotCommand,
  ): Promise<void> {
    const result = await tx.query<OrderScopeRow>(
      `
      SELECT manager_id, created_by
      FROM orders
      WHERE order_id = $1 AND delete_flag = false
      `,
      [command.orderId],
    );
    const row = result.rows[0];
    if (!row) throw new OrderNotFoundError(command.orderId);

    if (
      !this.orderPolicy.canExport(command.currentUser, {
        orderId: command.orderId,
        managerUserId: toNullableString(row.manager_id),
        createdByUserId: toNullableString(row.created_by),
      })
    ) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: ['orders.export'],
      });
    }
  }

  private async readBatchOrderIds(command: ExportOrderSnapshotBatchCommand): Promise<number[]> {
    const result = await this.database.query<IdRow>(
      `
      SELECT order_id AS id
      FROM orders
      WHERE delete_flag = false
        AND created_at::date >= $1::date
        AND created_at::date <= $2::date
      ORDER BY created_at ASC, order_id ASC
      `,
      [command.dateFrom, command.dateTo],
    );

    return result.rows.map((row) => Number(row.id));
  }
}

async function buildSnapshot(tx: TransactionClient, orderId: number): Promise<OrderSnapshotDto> {
  const sourceInstanceId = await readSourceInstanceId(tx);
  const header = await readRequiredRow(
    tx,
    `
    SELECT o.*, c.client_name, c.ref_key_1c AS client_ref_key_1c, c.notes AS client_notes,
           c.is_active AS client_is_active
    FROM orders o
    INNER JOIN clients c ON c.client_id = o.client_id
    WHERE o.order_id = $1 AND o.delete_flag = false
    `,
    [orderId],
    () => new OrderNotFoundError(orderId),
  );
  const details = await readRows(tx, 'SELECT * FROM order_details WHERE order_id = $1 AND delete_flag = false ORDER BY detail_number, detail_id', [orderId]);
  const payments = await readRows(tx, 'SELECT * FROM payments WHERE order_id = $1 AND delete_flag = false ORDER BY payment_date, payment_id', [orderId]);
  const workshops = await readRows(tx, 'SELECT * FROM order_workshops WHERE order_id = $1 AND delete_flag = false ORDER BY sequence_order NULLS LAST, order_workshop_id', [orderId]);
  const requirements = await readRows(tx, 'SELECT * FROM order_resource_requirements WHERE order_id = $1 AND is_active = true ORDER BY requirement_id', [orderId]);
  const dowelingLinks = await readRows(tx, 'SELECT * FROM order_doweling_links WHERE order_id = $1 AND delete_flag = false ORDER BY order_doweling_link_id', [orderId]);
  const dowelingOrders = dowelingLinks.length === 0
    ? []
    : await readRows(
        tx,
        `
        SELECT d.*
        FROM doweling_orders d
        WHERE d.doweling_order_id = ANY($1::bigint[]) AND d.delete_flag = false
        ORDER BY d.doweling_order_id
        `,
        [dowelingLinks.map((row) => toNumber(row.doweling_order_id))],
      );
  const clientPhones = await readRows(tx, 'SELECT * FROM client_phones WHERE client_id = $1 ORDER BY is_primary DESC, phone_id', [toNumber(header.client_id)]);
  const productionEvents = await readRows(
    tx,
    `
    SELECT pse.*, 'order'::text AS target_type, pse.order_id::text AS target_source_id
    FROM production_status_events pse
    WHERE pse.order_id = $1
    UNION ALL
    SELECT pse.*, 'detail'::text AS target_type, pse.detail_id::text AS target_source_id
    FROM production_status_events pse
    INNER JOIN order_details od ON od.detail_id = pse.detail_id
    WHERE od.order_id = $1
    ORDER BY event_at, event_id
    `,
    [orderId],
  );
  const deadlineInstances = await readOptionalTableRows(
    tx,
    'deadline_instances',
    'SELECT to_jsonb(d.*) AS data FROM deadline_instances d WHERE order_id = $1 ORDER BY created_at, deadline_id',
    [orderId],
  );
  const deadlineEvents = await readOptionalTableRows(
    tx,
    'deadline_events',
    'SELECT to_jsonb(d.*) AS data FROM deadline_events d WHERE order_id = $1 ORDER BY event_at, deadline_event_id',
    [orderId],
  );
  const exportedAt = new Date().toISOString();
  const snapshot: OrderSnapshotDto = {
    schema: ORDER_SNAPSHOT_SCHEMA,
    formatVersion: ORDER_SNAPSHOT_FORMAT_VERSION,
    exporterService: {
      name: ORDER_SNAPSHOT_SERVICE_NAME,
      version: ORDER_SNAPSHOT_SERVICE_VERSION,
      compatibleImportVersions: [...ORDER_SNAPSHOT_SUPPORTED_IMPORT_VERSIONS],
    },
    source: {
      sourceInstanceId,
      exportedAt,
      payloadHash: '',
    },
    identity: {
      order: {
        sourceId: String(orderId),
        refKey1c: toNullableString(header.ref_key_1c),
      },
      client: {
        sourceId: String(header.client_id),
        refKey1c: toNullableString(header.client_ref_key_1c),
      },
    },
    data: {
      client: {
        sourceId: String(header.client_id),
        clientName: toStringValue(header.client_name),
        refKey1c: toNullableString(header.client_ref_key_1c),
        notes: toNullableString(header.client_notes),
        isActive: toBoolean(header.client_is_active, true),
      },
      clientPhones: clientPhones.map(mapClientPhoneSnapshot),
      order: mapOrderHeaderSnapshot(header),
      details: details.map(mapDetailSnapshot),
      payments: payments.map(mapPaymentSnapshot),
      workshops: workshops.map(mapWorkshopSnapshot),
      requirements: requirements.map(mapRequirementSnapshot),
      dowelingOrders: dowelingOrders.map(mapDowelingOrderSnapshot),
      dowelingLinks: dowelingLinks.map(mapDowelingLinkSnapshot),
      productionStatusEvents: productionEvents.map(mapProductionEventSnapshot),
      deadlineInstances,
      deadlineEvents,
    },
    references: {},
  };
  snapshot.source.payloadHash = calculateSnapshotHash(snapshot);
  return snapshot;
}

async function importSnapshotInTransaction(
  tx: TransactionClient,
  snapshot: OrderSnapshotDto,
  payloadHash: string,
  importRunId: string,
  command: ImportOrderSnapshotCommand,
): Promise<Omit<ImportOrderSnapshotResponseDto, 'importRunId'>> {
  const source = snapshot.source.sourceInstanceId;
  const orderSourceId = snapshot.identity.order.sourceId;
  const existingOrderMap = await getMap(tx, source, SNAPSHOT_ENTITY_TYPES.order, orderSourceId);

  if (existingOrderMap?.payload_hash === payloadHash) {
    const orderId = Number(existingOrderMap.local_entity_id);
    const orderName = await readOrderName(tx, orderId);
    return response('noop', orderId, orderName, payloadHash, snapshot);
  }

  const clientId = await upsertClient(tx, snapshot, payloadHash);

  // SP3: pre-read stored sheet state BEFORE writing (same as order-transaction.service).
  // For brand-new orders (no localOrderId yet), stored state = empty + eligible=true.
  const existingOrderMapForSheet = await getMap(tx, source, SNAPSHOT_ENTITY_TYPES.order, orderSourceId);
  const localOrderIdForSheet = existingOrderMapForSheet
    ? Number(existingOrderMapForSheet.local_entity_id)
    : await findOrderForSnapshot(tx, snapshot, clientId);
  const storedSheet = await readStoredSheetState(tx, localOrderIdForSheet);

  // Build the validation header/details from incoming snapshot data.
  const snapshotHeader: SheetValidationHeader = {
    sheetMaterialTypeId: snapshot.data.order.sheetMaterialTypeId ?? null,
    materialId: snapshot.data.order.materialId ?? null,
  };
  // SP3 invariant 5 (no-flip / no-clear) on import: resolve each snapshot detail's LOCAL
  // detail_id through the import map (order_import_entity_map) — the same resolution
  // upsertOrderChildren uses — NOT by assuming source detail id == local detail id. With a
  // remapped/cross-instance sourceId the raw match left detailId undefined, so an existing
  // legacy detail was wrongly treated as new and could flip NULL→sheet on import.
  const detailLocalIds = await localIdsFor(
    tx,
    source,
    SNAPSHOT_ENTITY_TYPES.detail,
    snapshot.data.details,
  );
  const snapshotDetails = buildSheetValidationDetails(snapshot.data.details, detailLocalIds);

  // Validate sheet references + eligibility/no-clear guards (same invariants as command path).
  await validateSheetReferences(tx, snapshotHeader, snapshotDetails);
  assertSheetEligibilityAndNoClear({
    eligible: storedSheet.eligible,
    storedHeaderSheetId: storedSheet.headerSheetId,
    storedDetailSheetIds: storedSheet.detailSheetIds,
    header: snapshotHeader,
    details: snapshotDetails,
  });

  const orderId = await upsertOrderHeader(tx, snapshot, clientId, payloadHash);
  await upsertClientPhones(tx, snapshot, clientId, orderId, payloadHash);
  const dowelingOrderIds = await upsertDowelingOrders(tx, snapshot, orderId, payloadHash);
  await upsertOrderChildren(tx, snapshot, orderId, dowelingOrderIds, payloadHash, command);
  await upsertProductionEvents(tx, snapshot, orderId, payloadHash);
  await upsertDeadlines(tx, snapshot, orderId, payloadHash);
  await upsertMap(tx, {
    source,
    entityType: SNAPSHOT_ENTITY_TYPES.order,
    sourceId: orderSourceId,
    localId: String(orderId),
    localOrderId: orderId,
    payloadHash,
  });

  const status: ImportStatus = existingOrderMap ? 'updated' : 'created';
  const orderName = await readOrderName(tx, orderId);

  await tx.query(
    `
    UPDATE order_import_runs
    SET local_order_id = $2
    WHERE import_run_id = $1
    `,
    [importRunId, orderId],
  );

  return response(status, orderId, orderName, payloadHash, snapshot);
}

async function upsertClient(
  tx: TransactionClient,
  snapshot: OrderSnapshotDto,
  payloadHash: string,
): Promise<number> {
  const source = snapshot.source.sourceInstanceId;
  const client = snapshot.data.client;
  const mapped = await getMap(tx, source, SNAPSHOT_ENTITY_TYPES.client, client.sourceId);

  if (mapped) {
    const clientId = Number(mapped.local_entity_id);
    await tx.query(
      `
      UPDATE clients
      SET client_name = $2, ref_key_1c = COALESCE($3::uuid, ref_key_1c), notes = COALESCE($4, notes),
          is_active = $5
      WHERE client_id = $1
      `,
      [clientId, client.clientName, client.refKey1c, client.notes, client.isActive],
    );
    await upsertMap(tx, { source, entityType: SNAPSHOT_ENTITY_TYPES.client, sourceId: client.sourceId, localId: String(clientId), localOrderId: null, payloadHash });
    return clientId;
  }

  const byRef = client.refKey1c
    ? await readOptionalId(tx, 'SELECT client_id AS id FROM clients WHERE ref_key_1c = $1::uuid', [client.refKey1c])
    : null;
  const byName = byRef ?? await readOptionalId(tx, 'SELECT client_id AS id FROM clients WHERE client_name = $1', [client.clientName]);

  const clientId = byName ?? await insertClient(tx, client);
  await upsertMap(tx, { source, entityType: SNAPSHOT_ENTITY_TYPES.client, sourceId: client.sourceId, localId: String(clientId), localOrderId: null, payloadHash });
  return clientId;
}

async function upsertOrderHeader(
  tx: TransactionClient,
  snapshot: OrderSnapshotDto,
  clientId: number,
  payloadHash: string,
): Promise<number> {
  const source = snapshot.source.sourceInstanceId;
  const sourceId = snapshot.identity.order.sourceId;
  const mapped = await getMap(tx, source, SNAPSHOT_ENTITY_TYPES.order, sourceId);
  const localOrderId = mapped
    ? Number(mapped.local_entity_id)
    : await findOrderForSnapshot(tx, snapshot, clientId);
  const dto = snapshotToSaveOrderDto(snapshot, clientId, {
    details: [],
    payments: [],
    workshops: [],
    requirements: [],
    dowelingLinks: [],
  });
  const prepared = prepareOrderSave(dto, {
    mode: localOrderId ? 'update' : 'create',
    pathOrderId: localOrderId ?? undefined,
  });

  const orderId = localOrderId
    ? await updateOrderHeader(tx, localOrderId, prepared.order.header, prepared.totals)
    : await insertOrderHeader(tx, prepared.order.header, prepared.totals);
  await upsertMap(tx, { source, entityType: SNAPSHOT_ENTITY_TYPES.order, sourceId, localId: String(orderId), localOrderId: orderId, payloadHash });
  return orderId;
}

async function upsertOrderChildren(
  tx: TransactionClient,
  snapshot: OrderSnapshotDto,
  orderId: number,
  dowelingOrderIds: Map<string, number>,
  payloadHash: string,
  command: ImportOrderSnapshotCommand,
): Promise<void> {
  const source = snapshot.source.sourceInstanceId;
  const detailIds = await localIdsFor(tx, source, SNAPSHOT_ENTITY_TYPES.detail, snapshot.data.details);
  const paymentIds = await localIdsFor(tx, source, SNAPSHOT_ENTITY_TYPES.payment, snapshot.data.payments);
  const workshopIds = await localIdsFor(tx, source, SNAPSHOT_ENTITY_TYPES.workshop, snapshot.data.workshops);
  const requirementIds = await localIdsFor(tx, source, SNAPSHOT_ENTITY_TYPES.requirement, snapshot.data.requirements);
  const dowelingLinkIds = await localIdsFor(tx, source, SNAPSHOT_ENTITY_TYPES.dowelingLink, snapshot.data.dowelingLinks);
  const dto = snapshotToSaveOrderDto(snapshot, snapshot.data.order.clientId, {
    details: snapshot.data.details.map((item) => ({ ...item, id: detailIds.get(item.sourceId), clientKey: item.sourceId })),
    payments: snapshot.data.payments.map((item) => ({ ...item, id: paymentIds.get(item.sourceId), clientKey: item.sourceId })),
    workshops: snapshot.data.workshops.map((item) => ({ ...item, id: workshopIds.get(item.sourceId), clientKey: item.sourceId })),
    requirements: snapshot.data.requirements.map((item) => ({ ...item, id: requirementIds.get(item.sourceId), clientKey: item.sourceId })),
    dowelingLinks: snapshot.data.dowelingLinks.map((item) => ({
      ...item,
      id: dowelingLinkIds.get(item.sourceId),
      clientKey: item.sourceId,
      dowelingOrderId: requiredMapId(dowelingOrderIds, item.dowelingOrderSourceId, 'doweling order'),
    })),
  });
  const prepared = prepareOrderSave(
    {
      ...dto,
      header: { ...dto.header, orderId, clientId: await readOrderClientId(tx, orderId) },
      version: await readOrderVersion(tx, orderId),
    },
    { mode: 'update', pathOrderId: orderId },
  );

  const savedDetails = new Set<string>();
  for (const detail of prepared.details) {
    const sourceId = requiredString(detail.clientKey, 'detail clientKey');
    const id = await upsertDetail(tx, orderId, detail, command);
    savedDetails.add(sourceId);
    await upsertMap(tx, { source, entityType: SNAPSHOT_ENTITY_TYPES.detail, sourceId, localId: String(id), localOrderId: orderId, payloadHash });
  }
  await deleteMissingImportedRows(tx, source, SNAPSHOT_ENTITY_TYPES.detail, orderId, savedDetails, 'order_details', 'detail_id');

  const savedPayments = new Set<string>();
  for (const payment of prepared.order.payments) {
    const sourceId = requiredString(payment.clientKey, 'payment clientKey');
    const id = await upsertPayment(tx, orderId, payment);
    savedPayments.add(sourceId);
    await upsertMap(tx, { source, entityType: SNAPSHOT_ENTITY_TYPES.payment, sourceId, localId: String(id), localOrderId: orderId, payloadHash });
  }
  await deleteMissingImportedRows(tx, source, SNAPSHOT_ENTITY_TYPES.payment, orderId, savedPayments, 'payments', 'payment_id');

  const savedWorkshops = new Set<string>();
  for (const workshop of prepared.order.workshops) {
    const sourceId = requiredString(workshop.clientKey, 'workshop clientKey');
    const id = await upsertWorkshop(tx, orderId, workshop);
    savedWorkshops.add(sourceId);
    await upsertMap(tx, { source, entityType: SNAPSHOT_ENTITY_TYPES.workshop, sourceId, localId: String(id), localOrderId: orderId, payloadHash });
  }
  await deleteMissingImportedRows(tx, source, SNAPSHOT_ENTITY_TYPES.workshop, orderId, savedWorkshops, 'order_workshops', 'order_workshop_id');

  const savedRequirements = new Set<string>();
  for (const requirement of prepared.order.requirements) {
    const sourceId = requiredString(requirement.clientKey, 'requirement clientKey');
    const id = await upsertRequirement(tx, orderId, requirement);
    savedRequirements.add(sourceId);
    await upsertMap(tx, { source, entityType: SNAPSHOT_ENTITY_TYPES.requirement, sourceId, localId: String(id), localOrderId: orderId, payloadHash });
  }
  await deactivateMissingImportedRequirements(tx, source, orderId, savedRequirements);

  const savedLinks = new Set<string>();
  for (const link of prepared.order.dowelingLinks) {
    const sourceId = requiredString(link.clientKey, 'doweling link clientKey');
    const id = await upsertDowelingLink(tx, orderId, link);
    savedLinks.add(sourceId);
    await upsertMap(tx, { source, entityType: SNAPSHOT_ENTITY_TYPES.dowelingLink, sourceId, localId: String(id), localOrderId: orderId, payloadHash });
  }
  await deleteMissingImportedRows(tx, source, SNAPSHOT_ENTITY_TYPES.dowelingLink, orderId, savedLinks, 'order_doweling_links', 'order_doweling_link_id');

  await updateOrderTotals(tx, orderId, prepared.totals, await readOrderVersion(tx, orderId));
}

async function upsertClientPhones(
  tx: TransactionClient,
  snapshot: OrderSnapshotDto,
  clientId: number,
  orderId: number,
  payloadHash: string,
): Promise<void> {
  const source = snapshot.source.sourceInstanceId;
  for (const phone of snapshot.data.clientPhones) {
    const mapped = await getMap(tx, source, SNAPSHOT_ENTITY_TYPES.clientPhone, phone.sourceId);
    const phoneId = mapped
      ? await updateClientPhone(tx, Number(mapped.local_entity_id), clientId, phone)
      : await findOrInsertClientPhone(tx, clientId, phone);
    await upsertMap(tx, {
      source,
      entityType: SNAPSHOT_ENTITY_TYPES.clientPhone,
      sourceId: phone.sourceId,
      localId: String(phoneId),
      localOrderId: orderId,
      payloadHash,
    });
  }
}

async function upsertDowelingOrders(
  tx: TransactionClient,
  snapshot: OrderSnapshotDto,
  orderId: number,
  payloadHash: string,
): Promise<Map<string, number>> {
  const source = snapshot.source.sourceInstanceId;
  const result = new Map<string, number>();

  for (const item of snapshot.data.dowelingOrders) {
    const mapped = await getMap(tx, source, SNAPSHOT_ENTITY_TYPES.dowelingOrder, item.sourceId);
    const id = mapped
      ? await updateDowelingOrder(tx, Number(mapped.local_entity_id), orderId, item)
      : await findOrInsertDowelingOrder(tx, orderId, item);
    result.set(item.sourceId, id);
    await upsertMap(tx, { source, entityType: SNAPSHOT_ENTITY_TYPES.dowelingOrder, sourceId: item.sourceId, localId: String(id), localOrderId: orderId, payloadHash });
  }

  return result;
}

async function upsertProductionEvents(
  tx: TransactionClient,
  snapshot: OrderSnapshotDto,
  orderId: number,
  payloadHash: string,
): Promise<void> {
  const source = snapshot.source.sourceInstanceId;
  const detailIds = await localIdsFor(tx, source, SNAPSHOT_ENTITY_TYPES.detail, snapshot.data.details);
  const saved = new Set<string>();

  for (const event of snapshot.data.productionStatusEvents) {
    const targetId = event.targetType === 'order'
      ? orderId
      : requiredMapId(detailIds, event.targetSourceId, 'event detail');
    const id = await upsertProductionEvent(tx, event, targetId);
    saved.add(event.sourceId);
    await upsertMap(tx, { source, entityType: SNAPSHOT_ENTITY_TYPES.productionEvent, sourceId: event.sourceId, localId: String(id), localOrderId: orderId, payloadHash });
  }

  await deleteMissingImportedProductionEvents(tx, source, orderId, saved);
}

/**
 * Variant B (Task 4 — Critic R15 B1): strip legacy materialId from any header/detail
 * that carries a non-null sheetMaterialTypeId, BEFORE prepareOrderSave/validation.
 *
 * A Variant-A export snapshot carried a real shadow materialId alongside sheetMaterialTypeId.
 * Post-034, material_id is always NULL for sheet-bearing rows. The Task-5 validator will
 * reject a non-null materialId when sheetMaterialTypeId is set, so we sanitize it here.
 *
 * Anti-injection guard (validateNoShadowInjection) stays active only for rows where
 * sheetMaterialTypeId is null — those are legacy/non-sheet rows and the guard is benign.
 */
export function nullifyMaterialIdForSheetEntries<
  T extends { materialId?: number | null; sheetMaterialTypeId?: number | null },
>(entries: readonly T[]): T[] {
  return entries.map((e) =>
    e.sheetMaterialTypeId != null ? { ...e, materialId: null } : e,
  );
}

function snapshotToSaveOrderDto(
  snapshot: OrderSnapshotDto,
  clientId: number,
  children: {
    details: Array<OrderSnapshotDetailDto & { id?: number; clientKey?: string }>;
    payments: Array<OrderSnapshotPaymentDto & { id?: number; clientKey?: string }>;
    workshops: Array<OrderSnapshotWorkshopDto & { id?: number; clientKey?: string }>;
    requirements: Array<OrderSnapshotRequirementDto & { id?: number; clientKey?: string }>;
    dowelingLinks: Array<OrderSnapshotDowelingLinkDto & { id?: number; clientKey?: string; dowelingOrderId: number }>;
  },
): SaveOrderDto {
  // Variant B: null out materialId for any header/detail that carries sheetMaterialTypeId.
  // This sanitizes Variant-A legacy export payloads (which carried a shadow materialId alongside
  // sheetMaterialTypeId) before they reach prepareOrderSave / the Task-5 validator.
  const sanitizedOrder = snapshot.data.order.sheetMaterialTypeId != null
    ? { ...snapshot.data.order, materialId: null }
    : snapshot.data.order;
  const sanitizedDetails = nullifyMaterialIdForSheetEntries(children.details);

  return {
    header: {
      ...sanitizedOrder,
      orderId: undefined,
      clientId,
      paymentStatusId: sanitizedOrder.paymentStatusId ?? undefined,
    },
    details: sanitizedDetails.map(stripSourceFields),
    payments: children.payments.map(stripSourceFields),
    workshops: children.workshops.map(stripSourceFields),
    requirements: children.requirements.map(stripSourceFields),
    dowelingLinks: children.dowelingLinks.map(stripSourceFields),
    deleted: {
      detailIds: [],
      paymentIds: [],
      workshopIds: [],
      requirementIds: [],
      dowelingLinkIds: [],
    },
  };
}

function stripSourceFields<T extends { sourceId?: string; dowelingOrderSourceId?: string }>(value: T): Omit<T, 'sourceId' | 'dowelingOrderSourceId'> {
  const { sourceId: _sourceId, dowelingOrderSourceId: _dowelingOrderSourceId, ...rest } = value;
  return rest;
}

function mapOrderHeaderSnapshot(row: AnyRow) {
  return {
    sourceId: String(row.order_id),
    orderName: toStringValue(row.order_name),
    clientId: toNumber(row.client_id),
    orderDate: toDateOnly(row.order_date) ?? '',
    priority: toNumber(row.priority),
    managerId: toNullableNumber(row.manager_id),
    orderStatusId: toNumber(row.order_status_id),
    paymentStatusId: toNumber(row.payment_status_id),
    productionStatusId: toNullableNumber(row.production_status_id),
    productionStatusFromDetailsEnabled: toBoolean(row.production_status_from_details_enabled, true),
    plannedCompletionDate: toDateOnly(row.planned_completion_date),
    completionDate: toDateOnly(row.completion_date),
    issueDate: toDateOnly(row.issue_date),
    paymentDate: toDateOnly(row.payment_date),
    discount: toNumber(row.discount),
    surcharge: toNumber(row.surcharge),
    linkCuttingFile: toNullableString(row.link_cutting_file),
    linkCuttingImageFile: toNullableString(row.link_cutting_image_file),
    linkCadFile: toNullableString(row.link_cad_file),
    linkPdfFile: toNullableString(row.link_pdf_file),
    notes: toNullableString(row.notes),
    refKey1c: toNullableString(row.ref_key_1c),
    materialId: toNullableNumber(row.material_id),
    sheetMaterialTypeId: toNullableNumber(row.sheet_material_type_id),
    millingTypeId: toNullableNumber(row.milling_type_id),
    edgeTypeId: toNullableNumber(row.edge_type_id),
    filmId: toNullableNumber(row.film_id),
  };
}

function mapDetailSnapshot(row: AnyRow): OrderSnapshotDetailDto {
  return {
    sourceId: String(row.detail_id),
    detailNumber: toNumber(row.detail_number),
    detailName: toNullableString(row.detail_name),
    height: toNumber(row.height),
    width: toNumber(row.width),
    quantity: toNumber(row.quantity),
    materialId: toNullableNumber(row.material_id),
    millingTypeId: toNumber(row.milling_type_id),
    edgeTypeId: toNumber(row.edge_type_id),
    filmId: toNullableNumber(row.film_id),
    area: toNullableNumber(row.area),
    millingCostPerSqm: toNullableNumber(row.milling_cost_per_sqm),
    detailCost: toNullableNumber(row.detail_cost),
    priority: toNumber(row.priority),
    productionStatusId: toNullableNumber(row.production_status_id),
    jointOrderId: toNullableNumber(row.joint_order_id),
    note: toNullableString(row.note),
    linkCuttingFile: toNullableString(row.link_cutting_file),
    linkCuttingImageFile: toNullableString(row.link_cutting_image_file),
    linkCadFile: toNullableString(row.link_cad_file),
    linkPdfFile: toNullableString(row.link_pdf_file),
    sheetMaterialTypeId: toNullableNumber(row.sheet_material_type_id),
    refKey1c: toNullableString(row.ref_key_1c),
  };
}

function mapPaymentSnapshot(row: AnyRow): OrderSnapshotPaymentDto {
  return {
    sourceId: String(row.payment_id),
    typePaidId: toNumber(row.type_paid_id),
    amount: toNumber(row.amount),
    paymentDate: toDateOnly(row.payment_date) ?? '',
    notes: toNullableString(row.notes),
    refKey1c: toNullableString(row.ref_key_1c),
  };
}

function mapWorkshopSnapshot(row: AnyRow): OrderSnapshotWorkshopDto {
  return {
    sourceId: String(row.order_workshop_id),
    workshopId: toNumber(row.workshop_id),
    productionStatusId: toNumber(row.production_status_id),
    receivedDate: toIsoNullable(row.received_date),
    startedDate: toIsoNullable(row.started_date),
    completedDate: toIsoNullable(row.completed_date),
    plannedCompletionDate: toDateOnly(row.planned_completion_date),
    sequenceOrder: toNullableNumber(row.sequence_order),
    responsibleEmployeeId: toNullableNumber(row.responsible_employee_id),
    notes: toNullableString(row.notes),
    refKey1c: toNullableString(row.ref_key_1c),
  };
}

function mapRequirementSnapshot(row: AnyRow): OrderSnapshotRequirementDto {
  return {
    sourceId: String(row.requirement_id),
    resourceType: toStringValue(row.resource_type),
    materialId: toNullableNumber(row.material_id),
    filmId: toNullableNumber(row.film_id),
    edgeTypeId: toNullableNumber(row.edge_type_id),
    requiredQuantity: toNumber(row.required_quantity),
    unitId: toNumber(row.unit_id),
    wastePercentage: toNullableNumber(row.waste_percentage),
    finalQuantity: toNullableNumber(row.final_quantity),
    requirementStatusId: toNumber(row.requirement_status_id),
    supplierId: toNullableNumber(row.supplier_id),
    purchasePrice: toNullableNumber(row.purchase_price),
    requisitionId: toNullableNumber(row.requisition_id),
    warehouseId: toNullableNumber(row.warehouse_id),
    reservedAt: toIsoNullable(row.reserved_at),
    consumedAt: toIsoNullable(row.consumed_at),
    notes: toNullableString(row.notes),
    calculationDetails: row.calculation_details == null ? null : JSON.stringify(row.calculation_details),
    refKey1c: toNullableString(row.ref_key_1c),
  };
}

function mapDowelingOrderSnapshot(row: AnyRow): DowelingOrderSnapshotDto {
  return {
    sourceId: String(row.doweling_order_id),
    dowelingOrderName: toStringValue(row.doweling_order_name),
    dowelingOrderDate: toDateOnly(row.doweling_order_date) ?? '',
    orderSourceId: toNullableString(row.order_id),
    paymentStatusId: toNumber(row.payment_status_id),
    productionStatusId: toNullableNumber(row.production_status_id),
    issueDate: toDateOnly(row.issue_date),
    totalAmount: toNullableNumber(row.total_amount),
    finalAmount: toNullableNumber(row.final_amount),
    discount: toNumber(row.discount),
    surcharge: toNumber(row.surcharge),
    paidAmount: toNumber(row.paid_amount),
    paymentDate: toDateOnly(row.payment_date),
    partsCount: toNumber(row.parts_count),
    linkCadFile: toNullableString(row.link_cad_file),
    linkPdfFile: toNullableString(row.link_pdf_file),
    refKey1c: toNullableString(row.ref_key_1c),
    designEngineerId: toNullableNumber(row.design_engineer_id),
    operatorId: toNullableNumber(row.operator_id),
  };
}

function mapDowelingLinkSnapshot(row: AnyRow): OrderSnapshotDowelingLinkDto {
  return {
    sourceId: String(row.order_doweling_link_id),
    dowelingOrderSourceId: String(row.doweling_order_id),
    dowelingOrderId: toNumber(row.doweling_order_id),
    refKey1c: toNullableString(row.ref_key_1c),
  };
}

function mapClientPhoneSnapshot(row: AnyRow): ClientPhoneSnapshotDto {
  return {
    sourceId: String(row.phone_id),
    phoneNumber: toStringValue(row.phone_number),
    phoneType: phoneType(row.phone_type),
    isPrimary: toBoolean(row.is_primary, false),
    refKey1c: toNullableString(row.ref_key_1c),
  };
}

function mapProductionEventSnapshot(row: AnyRow): ProductionStatusEventSnapshotDto {
  return {
    sourceId: String(row.event_id),
    targetType: row.target_type === 'detail' ? 'detail' : 'order',
    targetSourceId: toStringValue(row.target_source_id),
    productionStatusId: toNumber(row.production_status_id),
    eventAt: toIsoString(row.event_at),
    eventBy: toNullableNumber(row.event_by),
    note: toNullableString(row.note),
    payload: isRecord(row.payload) ? row.payload : {},
  };
}

async function insertOrderHeader(
  tx: TransactionClient,
  header: NormalizedSaveOrderHeaderDto,
  totals: OrderTotalsDto,
): Promise<number> {
  const result = await tx.query<IdRow>(
    `
    INSERT INTO orders (
      order_name, client_id, order_date, priority, manager_id,
      order_status_id, payment_status_id, production_status_id,
      production_status_from_details_enabled,
      planned_completion_date, completion_date, issue_date, payment_date,
      discount, surcharge, total_amount, final_amount, paid_amount, parts_count, total_area,
      link_cutting_file, link_cutting_image_file, link_cad_file, link_pdf_file,
      notes, material_id, milling_type_id, edge_type_id, film_id, ref_key_1c,
      sheet_material_type_id, version
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9,
      $10, $11, $12, $13,
      $14, $15, $16, $17, $18, $19, $20,
      $21, $22, $23, $24,
      $25, $26, $27, $28, $29, $30,
      $31, 1
    )
    RETURNING order_id AS id
    `,
    orderHeaderParams(header, totals),
  );
  return Number(result.rows[0].id);
}

// production_status_from_details_enabled is intentionally NOT updated here — it is owned by the
// production-status-mode backend commands (audit/outbox/version). Creation still sets it (insertOrderHeader).
async function updateOrderHeader(
  tx: TransactionClient,
  orderId: number,
  header: NormalizedSaveOrderHeaderDto,
  totals: OrderTotalsDto,
): Promise<number> {
  await tx.query(
    `
    UPDATE orders
    SET order_name = $2,
        client_id = $3,
        order_date = $4,
        priority = $5,
        manager_id = $6,
        order_status_id = $7,
        payment_status_id = $8,
        production_status_id = $9,
        planned_completion_date = $10,
        completion_date = $11,
        issue_date = $12,
        payment_date = $13,
        discount = $14,
        surcharge = $15,
        total_amount = $16,
        final_amount = $17,
        paid_amount = $18,
        parts_count = $19,
        total_area = $20,
        link_cutting_file = $21,
        link_cutting_image_file = $22,
        link_cad_file = $23,
        link_pdf_file = $24,
        notes = $25,
        material_id = $26,
        milling_type_id = $27,
        edge_type_id = $28,
        film_id = $29,
        ref_key_1c = $30,
        sheet_material_type_id = $31
    WHERE order_id = $1 AND delete_flag = false
    `,
    [orderId, ...orderHeaderUpdateParams(header, totals)],
  );
  return orderId;
}

/** Params for INSERT — includes production_status_from_details_enabled ($9) and sheet_material_type_id ($31). */
function orderHeaderParams(header: NormalizedSaveOrderHeaderDto, totals: OrderTotalsDto) {
  return [
    header.orderName,
    header.clientId,
    header.orderDate,
    header.priority,
    header.managerId,
    header.orderStatusId,
    totals.paymentStatusId,
    header.productionStatusId,
    header.productionStatusFromDetailsEnabled,
    header.plannedCompletionDate,
    header.completionDate,
    header.issueDate,
    totals.paymentDate,
    totals.discount,
    totals.surcharge,
    totals.totalAmount,
    totals.finalAmount,
    totals.paidAmount,
    totals.partsCount,
    totals.totalArea,
    header.linkCuttingFile,
    header.linkCuttingImageFile,
    header.linkCadFile,
    header.linkPdfFile,
    header.notes,
    // Header invariant (§13): a sheet header forces material_id NULL so legacy
    // material_id consumers never read a material that disagrees with the sheet.
    // keep in sync with pg-order-transaction-manager.ts createOrderHeader.
    header.sheetMaterialTypeId != null ? null : (header.materialId ?? null),
    header.millingTypeId,
    header.edgeTypeId,
    header.filmId,
    header.refKey1c,
    header.sheetMaterialTypeId ?? null,
  ];
}

/**
 * Params for UPDATE — same as orderHeaderParams but WITHOUT production_status_from_details_enabled.
 * The flag is owned exclusively by the production-status-mode backend commands (audit/outbox/version).
 * Includes sheet_material_type_id ($31 in UPDATE, $30 without orderId prefix removed by caller).
 * NOTE: pg-order-transaction-manager.ts has its own equivalent inline order UPDATE (different column
 * subset) that also omits this flag — keep both in sync if order header columns change.
 */
function orderHeaderUpdateParams(header: NormalizedSaveOrderHeaderDto, totals: OrderTotalsDto) {
  return [
    header.orderName,
    header.clientId,
    header.orderDate,
    header.priority,
    header.managerId,
    header.orderStatusId,
    totals.paymentStatusId,
    header.productionStatusId,
    header.plannedCompletionDate,
    header.completionDate,
    header.issueDate,
    totals.paymentDate,
    totals.discount,
    totals.surcharge,
    totals.totalAmount,
    totals.finalAmount,
    totals.paidAmount,
    totals.partsCount,
    totals.totalArea,
    header.linkCuttingFile,
    header.linkCuttingImageFile,
    header.linkCadFile,
    header.linkPdfFile,
    header.notes,
    // Header invariant (§13): a sheet header forces material_id NULL.
    // keep in sync with pg-order-transaction-manager.ts updateOrderHeader.
    header.sheetMaterialTypeId != null ? null : (header.materialId ?? null),
    header.millingTypeId,
    header.edgeTypeId,
    header.filmId,
    header.refKey1c,
    header.sheetMaterialTypeId ?? null,
  ];
}

async function upsertDetail(
  tx: TransactionClient,
  orderId: number,
  detail: CalculatedOrderDetailDto,
  command: ImportOrderSnapshotCommand,
): Promise<number> {
  // Variant B (migration 034): order_details.material_id is always NULL for sheet-bearing rows.
  // Variant-A shadow material resolution is removed — we no longer create/sync shadow materials.
  // Any legacy materialId arriving from an older snapshot export is discarded here (the
  // sanitisation in nullifyMaterialIdForSheetEntries already cleared it before prepareOrderSave,
  // but we enforce null at the DB-write level too for defence-in-depth).
  const effective: CalculatedOrderDetailDto =
    detail.sheetMaterialTypeId != null ? { ...detail, materialId: null } : detail;

  if (effective.id) {
    await tx.query(
      `
      UPDATE order_details
      SET detail_number = $3, detail_name = $4, height = $5, width = $6, quantity = $7,
          area = $8, material_id = $9, milling_type_id = $10, edge_type_id = $11,
          film_id = $12, milling_cost_per_sqm = $13, detail_cost = $14, priority = $15,
          production_status_id = $16, joint_order_id = $17, note = $18,
          link_cutting_file = $19, link_cutting_image_file = $20, link_cad_file = $21,
          link_pdf_file = $22, ref_key_1c = $23, sheet_material_type_id = $24, delete_flag = false
      WHERE detail_id = $1 AND order_id = $2
      `,
      [effective.id, orderId, ...detailValues(effective)],
    );
    return effective.id;
  }

  const result = await tx.query<IdRow>(
    `
    INSERT INTO order_details (
      order_id, detail_number, detail_name, height, width, quantity, area,
      material_id, milling_type_id, edge_type_id, film_id, milling_cost_per_sqm,
      detail_cost, priority, production_status_id, joint_order_id, note,
      link_cutting_file, link_cutting_image_file, link_cad_file, link_pdf_file, ref_key_1c,
      sheet_material_type_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
    RETURNING detail_id AS id
    `,
    [orderId, ...detailValues(effective)],
  );
  return Number(result.rows[0].id);
}

function detailValues(detail: CalculatedOrderDetailDto) {
  return [
    detail.detailNumber,
    detail.detailName,
    detail.height,
    detail.width,
    detail.quantity,
    detail.area,
    detail.materialId,
    detail.millingTypeId,
    detail.edgeTypeId,
    detail.filmId,
    detail.millingCostPerSqm,
    detail.detailCost,
    detail.priority,
    detail.productionStatusId,
    detail.jointOrderId,
    detail.note,
    detail.linkCuttingFile,
    detail.linkCuttingImageFile,
    detail.linkCadFile,
    detail.linkPdfFile,
    detail.refKey1c,
    detail.sheetMaterialTypeId ?? null,
  ];
}

async function upsertPayment(
  tx: TransactionClient,
  orderId: number,
  payment: NormalizedSaveOrderPaymentDto,
): Promise<number> {
  if (payment.id) {
    await tx.query(
      `
      UPDATE payments
      SET amount = $3, payment_date = $4, type_paid_id = $5, notes = $6, ref_key_1c = $7, delete_flag = false
      WHERE payment_id = $1 AND order_id = $2
      `,
      [payment.id, orderId, payment.amount, payment.paymentDate, payment.typePaidId, payment.notes, payment.refKey1c],
    );
    return payment.id;
  }

  const result = await tx.query<IdRow>(
    `
    INSERT INTO payments (order_id, amount, payment_date, type_paid_id, notes, ref_key_1c)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING payment_id AS id
    `,
    [orderId, payment.amount, payment.paymentDate, payment.typePaidId, payment.notes, payment.refKey1c],
  );
  return Number(result.rows[0].id);
}

async function upsertWorkshop(
  tx: TransactionClient,
  orderId: number,
  workshop: NormalizedSaveOrderWorkshopDto,
): Promise<number> {
  if (workshop.id) {
    await tx.query(
      `
      UPDATE order_workshops
      SET workshop_id = $3, production_status_id = $4, received_date = $5,
          started_date = $6, completed_date = $7, planned_completion_date = $8,
          sequence_order = $9, responsible_employee_id = $10, notes = $11, ref_key_1c = $12,
          delete_flag = false
      WHERE order_workshop_id = $1 AND order_id = $2
      `,
      [workshop.id, orderId, ...workshopValues(workshop)],
    );
    return workshop.id;
  }

  const result = await tx.query<IdRow>(
    `
    INSERT INTO order_workshops (
      order_id, workshop_id, production_status_id, received_date, started_date,
      completed_date, planned_completion_date, sequence_order,
      responsible_employee_id, notes, ref_key_1c
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (order_id, workshop_id, production_status_id)
    DO UPDATE SET delete_flag = false,
                  received_date = EXCLUDED.received_date,
                  started_date = EXCLUDED.started_date,
                  completed_date = EXCLUDED.completed_date,
                  planned_completion_date = EXCLUDED.planned_completion_date,
                  sequence_order = EXCLUDED.sequence_order,
                  responsible_employee_id = EXCLUDED.responsible_employee_id,
                  notes = EXCLUDED.notes,
                  ref_key_1c = EXCLUDED.ref_key_1c
    RETURNING order_workshop_id AS id
    `,
    [orderId, ...workshopValues(workshop)],
  );
  return Number(result.rows[0].id);
}

function workshopValues(workshop: NormalizedSaveOrderWorkshopDto) {
  return [
    workshop.workshopId,
    workshop.productionStatusId,
    workshop.receivedDate,
    workshop.startedDate,
    workshop.completedDate,
    workshop.plannedCompletionDate,
    workshop.sequenceOrder,
    workshop.responsibleEmployeeId,
    workshop.notes,
    workshop.refKey1c,
  ];
}

async function upsertRequirement(
  tx: TransactionClient,
  orderId: number,
  requirement: NormalizedSaveOrderRequirementDto,
): Promise<number> {
  if (requirement.id) {
    await tx.query(
      `
      UPDATE order_resource_requirements
      SET resource_type = $3, material_id = $4, film_id = $5, edge_type_id = $6,
          required_quantity = $7, unit_id = $8, waste_percentage = $9,
          requirement_status_id = $10, supplier_id = $11, purchase_price = $12,
          requisition_id = $13, warehouse_id = $14, reserved_at = $15, consumed_at = $16,
          notes = $17, calculation_details = $18, ref_key_1c = $19, is_active = true
      WHERE requirement_id = $1 AND order_id = $2
      `,
      [requirement.id, orderId, ...requirementValues(requirement)],
    );
    return requirement.id;
  }

  const result = await tx.query<IdRow>(
    `
    INSERT INTO order_resource_requirements (
      order_id, resource_type, material_id, film_id, edge_type_id, required_quantity,
      unit_id, waste_percentage, requirement_status_id, supplier_id, purchase_price,
      requisition_id, warehouse_id, reserved_at, consumed_at, notes, calculation_details, ref_key_1c
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
    RETURNING requirement_id AS id
    `,
    [orderId, ...requirementValues(requirement)],
  );
  return Number(result.rows[0].id);
}

function requirementValues(requirement: NormalizedSaveOrderRequirementDto) {
  return [
    requirement.resourceType,
    requirement.materialId,
    requirement.filmId,
    requirement.edgeTypeId,
    requirement.requiredQuantity,
    requirement.unitId,
    requirement.wastePercentage,
    requirement.requirementStatusId,
    requirement.supplierId,
    requirement.purchasePrice,
    requirement.requisitionId,
    requirement.warehouseId,
    requirement.reservedAt,
    requirement.consumedAt,
    requirement.notes,
    requirement.calculationDetails,
    requirement.refKey1c,
  ];
}

async function upsertDowelingLink(
  tx: TransactionClient,
  orderId: number,
  link: NormalizedSaveOrderDowelingLinkDto,
): Promise<number> {
  if (link.id) {
    await tx.query(
      `
      UPDATE order_doweling_links
      SET doweling_order_id = $3, ref_key_1c = $4, delete_flag = false
      WHERE order_doweling_link_id = $1 AND order_id = $2
      `,
      [link.id, orderId, link.dowelingOrderId, link.refKey1c],
    );
    return link.id;
  }

  const result = await tx.query<IdRow>(
    `
    INSERT INTO order_doweling_links (order_id, doweling_order_id, ref_key_1c)
    VALUES ($1, $2, $3)
    ON CONFLICT (order_id, doweling_order_id)
    DO UPDATE SET delete_flag = false, ref_key_1c = EXCLUDED.ref_key_1c
    RETURNING order_doweling_link_id AS id
    `,
    [orderId, link.dowelingOrderId, link.refKey1c],
  );
  return Number(result.rows[0].id);
}

async function updateOrderTotals(
  tx: TransactionClient,
  orderId: number,
  totals: OrderTotalsDto,
  previousVersion: number,
): Promise<void> {
  await tx.query(
    `
    UPDATE orders
    SET total_amount = $2,
        final_amount = $3,
        paid_amount = $4,
        payment_date = $5,
        payment_status_id = $6,
        parts_count = $7,
        total_area = $8,
        version = $9
    WHERE order_id = $1
    `,
    [
      orderId,
      totals.totalAmount,
      totals.finalAmount,
      totals.paidAmount,
      totals.paymentDate,
      totals.paymentStatusId,
      totals.partsCount,
      totals.totalArea,
      previousVersion + 1,
    ],
  );
}

async function insertDeadlineInstance(
  tx: TransactionClient,
  orderId: number,
  raw: Record<string, unknown>,
): Promise<string> {
  const result = await tx.query<{ id: string }>(
    `
    INSERT INTO deadline_instances (
      policy_id, policy_version_id, entity_type, entity_id, parent_entity_type,
      parent_entity_id, order_id, order_workshop_id, client_id, responsible_user_id,
      deadline_at, status, source, is_manually_overridden, policy_snapshot_json,
      metadata_json, started_at, completed_at, expired_at, cancelled_at,
      created_by_user_id, updated_by_user_id, created_at, updated_at
    )
    VALUES (
      $1::uuid, $2::uuid, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15::jsonb,
      $16::jsonb, $17, $18, $19, $20,
      $21, $22, COALESCE($23::timestamptz, now()), COALESCE($24::timestamptz, now())
    )
    RETURNING deadline_id::text AS id
    `,
    deadlineInstanceValues(orderId, raw),
  );
  return result.rows[0].id;
}

async function updateDeadlineInstance(
  tx: TransactionClient,
  deadlineId: string,
  orderId: number,
  raw: Record<string, unknown>,
): Promise<string> {
  await tx.query(
    `
    UPDATE deadline_instances
    SET policy_id = $2::uuid,
        policy_version_id = $3::uuid,
        entity_type = $4,
        entity_id = $5,
        parent_entity_type = $6,
        parent_entity_id = $7,
        order_id = $8,
        order_workshop_id = $9,
        client_id = $10,
        responsible_user_id = $11,
        deadline_at = $12,
        status = $13,
        source = $14,
        is_manually_overridden = $15,
        policy_snapshot_json = $16::jsonb,
        metadata_json = $17::jsonb,
        started_at = $18,
        completed_at = $19,
        expired_at = $20,
        cancelled_at = $21,
        created_by_user_id = $22,
        updated_by_user_id = $23,
        updated_at = COALESCE($25::timestamptz, now())
    WHERE deadline_id = $1::uuid
    `,
    [deadlineId, ...deadlineInstanceValues(orderId, raw)],
  );
  return deadlineId;
}

function deadlineInstanceValues(orderId: number, raw: Record<string, unknown>) {
  return [
    nullableUuid(raw.policy_id),
    nullableUuid(raw.policy_version_id),
    toStringValue(raw.entity_type || 'order'),
    raw.entity_type === 'order' ? String(orderId) : toNullableString(raw.entity_id),
    toNullableString(raw.parent_entity_type),
    raw.parent_entity_type === 'order' ? String(orderId) : toNullableString(raw.parent_entity_id),
    orderId,
    toNullableNumber(raw.order_workshop_id),
    toNullableNumber(raw.client_id),
    toNullableNumber(raw.responsible_user_id),
    toIsoString(raw.deadline_at),
    toStringValue(raw.status || 'active'),
    toStringValue(raw.source || 'imported'),
    toBoolean(raw.is_manually_overridden, false),
    jsonOrNull(raw.policy_snapshot_json),
    jsonOrNull(raw.metadata_json),
    toIsoNullable(raw.started_at),
    toIsoNullable(raw.completed_at),
    toIsoNullable(raw.expired_at),
    toIsoNullable(raw.cancelled_at),
    toNullableNumber(raw.created_by_user_id),
    toNullableNumber(raw.updated_by_user_id),
    toIsoNullable(raw.created_at),
    toIsoNullable(raw.updated_at),
  ];
}

async function insertDeadlineEvent(
  tx: TransactionClient,
  deadlineId: string,
  orderId: number,
  raw: Record<string, unknown>,
): Promise<string> {
  const result = await tx.query<{ id: string }>(
    `
    INSERT INTO deadline_events (
      deadline_id, event_type, severity, entity_type, entity_id, order_id,
      order_workshop_id, client_id, deadline_at, event_at, delay_minutes,
      payload_json, created_at
    )
    VALUES (
      $1::uuid, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11,
      $12::jsonb, COALESCE($13::timestamptz, now())
    )
    RETURNING deadline_event_id::text AS id
    `,
    [deadlineId, ...deadlineEventValues(orderId, raw)],
  );
  return result.rows[0].id;
}

async function updateDeadlineEvent(
  tx: TransactionClient,
  eventId: string,
  deadlineId: string,
  orderId: number,
  raw: Record<string, unknown>,
): Promise<string> {
  await tx.query(
    `
    UPDATE deadline_events
    SET deadline_id = $2::uuid,
        event_type = $3,
        severity = $4,
        entity_type = $5,
        entity_id = $6,
        order_id = $7,
        order_workshop_id = $8,
        client_id = $9,
        deadline_at = $10,
        event_at = $11,
        delay_minutes = $12,
        payload_json = $13::jsonb,
        created_at = COALESCE($14::timestamptz, created_at)
    WHERE deadline_event_id = $1::uuid
    `,
    [eventId, deadlineId, ...deadlineEventValues(orderId, raw)],
  );
  return eventId;
}

function deadlineEventValues(orderId: number, raw: Record<string, unknown>) {
  return [
    toStringValue(raw.event_type),
    toStringValue(raw.severity || 'info'),
    toStringValue(raw.entity_type || 'order'),
    raw.entity_type === 'order' ? String(orderId) : toNullableString(raw.entity_id),
    orderId,
    toNullableNumber(raw.order_workshop_id),
    toNullableNumber(raw.client_id),
    toIsoNullable(raw.deadline_at),
    toIsoString(raw.event_at),
    toNullableNumber(raw.delay_minutes),
    jsonOrNull(raw.payload_json),
    toIsoNullable(raw.created_at),
  ];
}

async function deleteMissingImportedDeadlineRows(
  tx: TransactionClient,
  source: string,
  entityType: string,
  orderId: number,
  keptSourceIds: Set<string>,
  table: string,
  pk: string,
): Promise<void> {
  const existing = await readRows(
    tx,
    `
    SELECT source_entity_id, local_entity_id
    FROM order_import_entity_map
    WHERE source_instance_id = $1 AND entity_type = $2 AND local_order_id = $3
    `,
    [source, entityType, orderId],
  );
  const deletedIds = existing
    .filter((row) => !keptSourceIds.has(toStringValue(row.source_entity_id)))
    .map((row) => toStringValue(row.local_entity_id));
  if (deletedIds.length === 0) return;

  await tx.query(`DELETE FROM ${table} WHERE ${pk} = ANY($1::uuid[]) AND order_id = $2`, [
    deletedIds,
    orderId,
  ]);
  await tx.query(
    `
    DELETE FROM order_import_entity_map
    WHERE source_instance_id = $1 AND entity_type = $2 AND local_order_id = $3
      AND local_entity_id = ANY($4::text[])
    `,
    [source, entityType, orderId, deletedIds],
  );
}

async function insertClient(tx: TransactionClient, client: OrderSnapshotDto['data']['client']): Promise<number> {
  const result = await tx.query<IdRow>(
    `
    INSERT INTO clients (client_name, ref_key_1c, notes, is_active)
    VALUES ($1, $2::uuid, $3, $4)
    RETURNING client_id AS id
    `,
    [client.clientName, client.refKey1c, client.notes, client.isActive],
  );
  return Number(result.rows[0].id);
}

async function findOrInsertClientPhone(
  tx: TransactionClient,
  clientId: number,
  phone: ClientPhoneSnapshotDto,
): Promise<number> {
  const byRef = phone.refKey1c
    ? await readOptionalId(tx, 'SELECT phone_id AS id FROM client_phones WHERE ref_key_1c = $1::uuid', [phone.refKey1c])
    : null;
  const byPhone = byRef ?? await readOptionalId(
    tx,
    'SELECT phone_id AS id FROM client_phones WHERE client_id = $1 AND phone_number = $2',
    [clientId, phone.phoneNumber],
  );

  if (byPhone) return updateClientPhone(tx, byPhone, clientId, phone);

  if (phone.isPrimary) {
    await tx.query('UPDATE client_phones SET is_primary = false WHERE client_id = $1', [clientId]);
  }
  const result = await tx.query<IdRow>(
    `
    INSERT INTO client_phones (client_id, phone_number, phone_type, is_primary, ref_key_1c)
    VALUES ($1, $2, $3, $4, $5::uuid)
    RETURNING phone_id AS id
    `,
    [clientId, phone.phoneNumber, phone.phoneType, phone.isPrimary, phone.refKey1c],
  );
  return Number(result.rows[0].id);
}

async function updateClientPhone(
  tx: TransactionClient,
  phoneId: number,
  clientId: number,
  phone: ClientPhoneSnapshotDto,
): Promise<number> {
  if (phone.isPrimary) {
    await tx.query('UPDATE client_phones SET is_primary = false WHERE client_id = $1 AND phone_id <> $2', [clientId, phoneId]);
  }
  await tx.query(
    `
    UPDATE client_phones
    SET phone_number = $2, phone_type = $3, is_primary = $4, ref_key_1c = COALESCE($5::uuid, ref_key_1c)
    WHERE phone_id = $1 AND client_id = $6
    `,
    [phoneId, phone.phoneNumber, phone.phoneType, phone.isPrimary, phone.refKey1c, clientId],
  );
  return phoneId;
}

async function findOrInsertDowelingOrder(
  tx: TransactionClient,
  orderId: number,
  item: DowelingOrderSnapshotDto,
): Promise<number> {
  const byRef = item.refKey1c
    ? await readOptionalId(tx, 'SELECT doweling_order_id AS id FROM doweling_orders WHERE ref_key_1c = $1::uuid', [item.refKey1c])
    : null;
  const byName = byRef ?? await readOptionalId(
    tx,
    'SELECT doweling_order_id AS id FROM doweling_orders WHERE order_id = $1 AND doweling_order_name = $2 AND delete_flag = false',
    [orderId, item.dowelingOrderName],
  );
  if (byName) return updateDowelingOrder(tx, byName, orderId, item);

  const result = await tx.query<IdRow>(
    `
    INSERT INTO doweling_orders (
      doweling_order_name, doweling_order_date, order_id, payment_status_id,
      production_status_id, issue_date, total_amount, final_amount, discount,
      surcharge, paid_amount, payment_date, parts_count, link_cad_file, link_pdf_file,
      ref_key_1c, design_engineer_id, operator_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::uuid, $17, $18)
    RETURNING doweling_order_id AS id
    `,
    dowelingOrderValues(orderId, item),
  );
  return Number(result.rows[0].id);
}

async function updateDowelingOrder(
  tx: TransactionClient,
  dowelingOrderId: number,
  orderId: number,
  item: DowelingOrderSnapshotDto,
): Promise<number> {
  await tx.query(
    `
    UPDATE doweling_orders
    SET doweling_order_name = $2, doweling_order_date = $3, order_id = $4,
        payment_status_id = $5, production_status_id = $6, issue_date = $7,
        total_amount = $8, final_amount = $9, discount = $10, surcharge = $11,
        paid_amount = $12, payment_date = $13, parts_count = $14,
        link_cad_file = $15, link_pdf_file = $16, ref_key_1c = COALESCE($17::uuid, ref_key_1c),
        design_engineer_id = $18, operator_id = $19, delete_flag = false
    WHERE doweling_order_id = $1
    `,
    [dowelingOrderId, ...dowelingOrderValues(orderId, item)],
  );
  return dowelingOrderId;
}

function dowelingOrderValues(orderId: number, item: DowelingOrderSnapshotDto) {
  if (!item.designEngineerId) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Doweling order designEngineerId is required');
  }

  return [
    item.dowelingOrderName,
    item.dowelingOrderDate,
    orderId,
    item.paymentStatusId,
    item.productionStatusId,
    item.issueDate,
    item.totalAmount,
    item.finalAmount,
    item.discount,
    item.surcharge,
    item.paidAmount,
    item.paymentDate,
    item.partsCount,
    item.linkCadFile,
    item.linkPdfFile,
    item.refKey1c,
    item.designEngineerId,
    item.operatorId,
  ];
}

async function upsertProductionEvent(
  tx: TransactionClient,
  event: ProductionStatusEventSnapshotDto,
  targetId: number,
): Promise<number> {
  const result = event.targetType === 'order'
    ? await tx.query<IdRow>(
        `
        INSERT INTO production_status_events (order_id, production_status_id, event_at, event_by, note, payload)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        ON CONFLICT (order_id, production_status_id) WHERE order_id IS NOT NULL
        DO UPDATE SET event_at = EXCLUDED.event_at,
                      event_by = EXCLUDED.event_by,
                      note = EXCLUDED.note,
                      payload = EXCLUDED.payload
        RETURNING event_id AS id
        `,
        [targetId, event.productionStatusId, event.eventAt, event.eventBy, event.note, JSON.stringify(event.payload)],
      )
    : await tx.query<IdRow>(
        `
        INSERT INTO production_status_events (detail_id, production_status_id, event_at, event_by, note, payload)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        ON CONFLICT (detail_id, production_status_id) WHERE detail_id IS NOT NULL
        DO UPDATE SET event_at = EXCLUDED.event_at,
                      event_by = EXCLUDED.event_by,
                      note = EXCLUDED.note,
                      payload = EXCLUDED.payload
        RETURNING event_id AS id
        `,
        [targetId, event.productionStatusId, event.eventAt, event.eventBy, event.note, JSON.stringify(event.payload)],
      );
  return Number(result.rows[0].id);
}

async function findOrderForSnapshot(
  tx: TransactionClient,
  snapshot: OrderSnapshotDto,
  clientId: number,
): Promise<number | null> {
  const refKey = snapshot.identity.order.refKey1c ?? snapshot.data.order.refKey1c ?? null;
  if (refKey) {
    const byRef = await readOptionalId(tx, 'SELECT order_id AS id FROM orders WHERE ref_key_1c = $1::uuid AND delete_flag = false', [refKey]);
    if (byRef) return byRef;
  }

  return readOptionalId(
    tx,
    'SELECT order_id AS id FROM orders WHERE client_id = $1 AND order_name = $2 AND delete_flag = false',
    [clientId, snapshot.data.order.orderName],
  );
}

async function getMap(
  tx: TransactionClient,
  source: string,
  entityType: string,
  sourceId: string,
): Promise<ImportMapRow | null> {
  const result = await tx.query<ImportMapRow>(
    `
    SELECT local_entity_id, payload_hash
    FROM order_import_entity_map
    WHERE source_instance_id = $1 AND entity_type = $2 AND source_entity_id = $3
    `,
    [source, entityType, sourceId],
  );
  return result.rows[0] ?? null;
}

async function upsertMap(
  tx: TransactionClient,
  input: {
    source: string;
    entityType: string;
    sourceId: string;
    localId: string;
    localOrderId: number | null;
    payloadHash: string;
  },
): Promise<void> {
  await tx.query(
    `
    INSERT INTO order_import_entity_map (
      source_instance_id, entity_type, source_entity_id, local_entity_id, local_order_id, payload_hash
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (source_instance_id, entity_type, source_entity_id)
    DO UPDATE SET local_entity_id = EXCLUDED.local_entity_id,
                  local_order_id = EXCLUDED.local_order_id,
                  payload_hash = EXCLUDED.payload_hash,
                  updated_at = now()
    `,
    [input.source, input.entityType, input.sourceId, input.localId, input.localOrderId, input.payloadHash],
  );
}

/**
 * SP3: build the {@link SheetValidationDetail} list for the snapshot import guards. Each
 * detail's existing LOCAL detail_id is resolved through the import map (sourceId → localId),
 * NOT by assuming the source detail id equals the local detail id. A remapped/cross-instance
 * sourceId that has no local mapping yields detailId=undefined (treated as a new row).
 */
export function buildSheetValidationDetails(
  details: ReadonlyArray<{
    sourceId: string;
    sheetMaterialTypeId?: number | null;
    materialId?: number | null;
    height: number;
    width: number;
  }>,
  detailLocalIds: Map<string, number>,
): SheetValidationDetail[] {
  return details.map((d, i) => ({
    label: `details[${i}]`,
    detailId: detailLocalIds.get(d.sourceId),
    sheetMaterialTypeId: d.sheetMaterialTypeId ?? null,
    materialId: d.materialId ?? null,
    height: d.height,
    width: d.width,
  }));
}

async function localIdsFor<T extends { sourceId: string }>(
  tx: TransactionClient,
  source: string,
  entityType: string,
  rows: T[],
): Promise<Map<string, number>> {
  const ids = new Map<string, number>();

  for (const row of rows) {
    const mapped = await getMap(tx, source, entityType, row.sourceId);
    if (mapped) ids.set(row.sourceId, Number(mapped.local_entity_id));
  }

  return ids;
}

async function deleteMissingImportedRows(
  tx: TransactionClient,
  source: string,
  entityType: string,
  orderId: number,
  keptSourceIds: Set<string>,
  table: string,
  pk: string,
): Promise<void> {
  const existing = await readRows(
    tx,
    `
    SELECT source_entity_id, local_entity_id
    FROM order_import_entity_map
    WHERE source_instance_id = $1 AND entity_type = $2 AND local_order_id = $3
    `,
    [source, entityType, orderId],
  );
  const deletedIds = existing
    .filter((row) => !keptSourceIds.has(toStringValue(row.source_entity_id)))
    .map((row) => toNumber(row.local_entity_id));
  if (deletedIds.length === 0) return;

  await tx.query(`DELETE FROM ${table} WHERE ${pk} = ANY($1::bigint[]) AND order_id = $2`, [
    deletedIds,
    orderId,
  ]);
  await tx.query(
    `
    DELETE FROM order_import_entity_map
    WHERE source_instance_id = $1 AND entity_type = $2 AND local_order_id = $3
      AND local_entity_id = ANY($4::text[])
    `,
    [source, entityType, orderId, deletedIds.map(String)],
  );
}

async function deactivateMissingImportedRequirements(
  tx: TransactionClient,
  source: string,
  orderId: number,
  keptSourceIds: Set<string>,
): Promise<void> {
  const existing = await readRows(
    tx,
    `
    SELECT source_entity_id, local_entity_id
    FROM order_import_entity_map
    WHERE source_instance_id = $1 AND entity_type = $2 AND local_order_id = $3
    `,
    [source, SNAPSHOT_ENTITY_TYPES.requirement, orderId],
  );
  const ids = existing
    .filter((row) => !keptSourceIds.has(toStringValue(row.source_entity_id)))
    .map((row) => toNumber(row.local_entity_id));
  if (ids.length === 0) return;

  await tx.query(
    'UPDATE order_resource_requirements SET is_active = false WHERE requirement_id = ANY($1::bigint[]) AND order_id = $2',
    [ids, orderId],
  );
}

async function deleteMissingImportedProductionEvents(
  tx: TransactionClient,
  source: string,
  orderId: number,
  keptSourceIds: Set<string>,
): Promise<void> {
  const existing = await readRows(
    tx,
    `
    SELECT source_entity_id, local_entity_id
    FROM order_import_entity_map
    WHERE source_instance_id = $1 AND entity_type = $2 AND local_order_id = $3
    `,
    [source, SNAPSHOT_ENTITY_TYPES.productionEvent, orderId],
  );
  const ids = existing
    .filter((row) => !keptSourceIds.has(toStringValue(row.source_entity_id)))
    .map((row) => toNumber(row.local_entity_id));
  if (ids.length === 0) return;

  await tx.query('DELETE FROM production_status_events WHERE event_id = ANY($1::bigint[])', [ids]);
}

async function startImportRun(
  tx: TransactionClient,
  snapshot: OrderSnapshotDto,
  payloadHash: string,
  command: ImportOrderSnapshotCommand,
): Promise<string> {
  const result = await tx.query<ImportRunRow>(
    `
    INSERT INTO order_import_runs (
      source_instance_id, source_order_id, payload_hash, mode, status, imported_by, request_id, summary_json
    )
    VALUES ($1, $2, $3, 'apply', 'processing', $4, $5, $6::jsonb)
    RETURNING import_run_id
    `,
    [
      snapshot.source.sourceInstanceId,
      snapshot.identity.order.sourceId,
      payloadHash,
      toNullableUserId(command.currentUser.id),
      command.requestId ?? null,
      JSON.stringify({ formatVersion: snapshot.formatVersion, serviceVersion: snapshot.exporterService.version }),
    ],
  );
  return result.rows[0].import_run_id;
}

async function finishImportRun(
  tx: TransactionClient,
  runId: string,
  status: ImportStatus,
  orderId: number,
  summary: ImportOrderSnapshotResponseDto['summary'],
): Promise<void> {
  await tx.query(
    `
    UPDATE order_import_runs
    SET status = $2, local_order_id = $3, summary_json = $4::jsonb, completed_at = now()
    WHERE import_run_id = $1
    `,
    [runId, status === 'noop' ? 'noop' : 'completed', orderId, JSON.stringify(summary)],
  );
}

async function failImportRun(tx: TransactionClient, runId: string, error: unknown): Promise<void> {
  await tx.query(
    `
    UPDATE order_import_runs
    SET status = 'failed', error_code = $2, error_message = $3, completed_at = now()
    WHERE import_run_id = $1
    `,
    [
      runId,
      error instanceof ApiError ? error.code : 'ORDER_SNAPSHOT_IMPORT_FAILED',
      error instanceof Error ? error.message : 'Order snapshot import failed',
    ],
  );
}

function response(
  status: ImportStatus,
  orderId: number,
  orderName: string,
  payloadHash: string,
  snapshot: OrderSnapshotDto,
): Omit<ImportOrderSnapshotResponseDto, 'importRunId'> {
  return {
    success: true,
    status,
    orderId,
    orderName,
    payloadHash,
    summary: {
      details: snapshot.data.details.length,
      payments: snapshot.data.payments.length,
      workshops: snapshot.data.workshops.length,
      requirements: snapshot.data.requirements.length,
      dowelingLinks: snapshot.data.dowelingLinks.length,
      productionStatusEvents: snapshot.data.productionStatusEvents.length,
      clientPhones: snapshot.data.clientPhones.length,
      deadlineInstances: snapshot.data.deadlineInstances.length,
      deadlineEvents: snapshot.data.deadlineEvents.length,
    },
  };
}

async function upsertDeadlines(
  tx: TransactionClient,
  snapshot: OrderSnapshotDto,
  orderId: number,
  payloadHash: string,
): Promise<void> {
  if (snapshot.data.deadlineInstances.length === 0 && snapshot.data.deadlineEvents.length === 0) {
    return;
  }

  if (!(await tableExists(tx, 'deadline_instances')) || !(await tableExists(tx, 'deadline_events'))) {
    throw new ApiError(422, 'SNAPSHOT_TARGET_UNSUPPORTED', 'Target database has no deadline tables');
  }

  const source = snapshot.source.sourceInstanceId;
  const deadlineIds = new Map<string, string>();
  const savedInstances = new Set<string>();

  for (const raw of snapshot.data.deadlineInstances) {
    const sourceId = requiredString(raw.deadline_id, 'deadline_id');
    const mapped = await getMap(tx, source, SNAPSHOT_ENTITY_TYPES.deadlineInstance, sourceId);
    const localId = mapped
      ? await updateDeadlineInstance(tx, mapped.local_entity_id, orderId, raw)
      : await insertDeadlineInstance(tx, orderId, raw);
    deadlineIds.set(sourceId, localId);
    savedInstances.add(sourceId);
    await upsertMap(tx, {
      source,
      entityType: SNAPSHOT_ENTITY_TYPES.deadlineInstance,
      sourceId,
      localId,
      localOrderId: orderId,
      payloadHash,
    });
  }

  await deleteMissingImportedDeadlineRows(
    tx,
    source,
    SNAPSHOT_ENTITY_TYPES.deadlineInstance,
    orderId,
    savedInstances,
    'deadline_instances',
    'deadline_id',
  );

  const savedEvents = new Set<string>();
  for (const raw of snapshot.data.deadlineEvents) {
    const sourceId = requiredString(raw.deadline_event_id, 'deadline_event_id');
    const sourceDeadlineId = requiredString(raw.deadline_id, 'deadline_id');
    const localDeadlineId = requiredString(deadlineIds.get(sourceDeadlineId), 'deadline mapping');
    const mapped = await getMap(tx, source, SNAPSHOT_ENTITY_TYPES.deadlineEvent, sourceId);
    const localId = mapped
      ? await updateDeadlineEvent(tx, mapped.local_entity_id, localDeadlineId, orderId, raw)
      : await insertDeadlineEvent(tx, localDeadlineId, orderId, raw);
    savedEvents.add(sourceId);
    await upsertMap(tx, {
      source,
      entityType: SNAPSHOT_ENTITY_TYPES.deadlineEvent,
      sourceId,
      localId,
      localOrderId: orderId,
      payloadHash,
    });
  }

  await deleteMissingImportedDeadlineRows(
    tx,
    source,
    SNAPSHOT_ENTITY_TYPES.deadlineEvent,
    orderId,
    savedEvents,
    'deadline_events',
    'deadline_event_id',
  );
}

function assertSupportedSnapshot(snapshot: OrderSnapshotDto): OrderSnapshotDto {
  if (!snapshot || snapshot.schema !== ORDER_SNAPSHOT_SCHEMA) {
    throw new ApiError(422, 'INVALID_SNAPSHOT_SCHEMA', 'Unsupported order snapshot schema');
  }

  if (!ORDER_SNAPSHOT_SUPPORTED_IMPORT_VERSIONS.includes(snapshot.formatVersion)) {
    throw new ApiError(422, 'UNSUPPORTED_SNAPSHOT_VERSION', 'Unsupported order snapshot version', {
      formatVersion: snapshot.formatVersion,
      supportedVersions: [...ORDER_SNAPSHOT_SUPPORTED_IMPORT_VERSIONS],
    });
  }

  const expected = calculateSnapshotHash(snapshot);
  if (snapshot.source.payloadHash && snapshot.source.payloadHash !== expected) {
    throw new ApiError(422, 'SNAPSHOT_HASH_MISMATCH', 'Order snapshot payload hash does not match');
  }

  return snapshot;
}

export function calculateSnapshotHash(snapshot: OrderSnapshotDto): string {
  const normalized = {
    ...snapshot,
    source: {
      ...snapshot.source,
      exportedAt: null,
      payloadHash: null,
    },
  };
  return createHash('sha256').update(stableStringify(normalized)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function snapshotFileName(snapshot: OrderSnapshotDto): string {
  return `order-${sanitizeFilePart(snapshot.data.order.orderName || snapshot.identity.order.sourceId)}-snapshot-svc-v${ORDER_SNAPSHOT_SERVICE_VERSION}.erp-order.json`;
}

function batchSnapshotFileName(dateFrom: string, dateTo: string): string {
  return `orders-created-${dateFrom}_${dateTo}-snapshot-svc-v${ORDER_SNAPSHOT_SERVICE_VERSION}.erp-order-batch.zip`;
}

function sanitizeFilePart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9а-яА-ЯёЁ._-]+/g, '_').slice(0, 80) || 'order';
}

interface StoredSheetStateResult {
  eligible: boolean;
  headerSheetId: number | null;
  detailSheetIds: StoredSheetDetail[];
}

/**
 * Read the stored sheet state for a local order (for validation pre-read before import writes).
 * If orderId is null (brand-new order, not yet in the DB), returns eligible=true + empty stored ids,
 * matching the snapshot path for new orders (SP3-era → eligible by default).
 */
async function readStoredSheetState(
  tx: TransactionClient,
  orderId: number | null,
): Promise<StoredSheetStateResult> {
  if (orderId === null) {
    return { eligible: true, headerSheetId: null, detailSheetIds: [] };
  }
  const headerRow = await tx.query<{
    sheet_material_type_id: number | string | null;
    sheet_eligible: boolean | null;
  }>(
    `SELECT sheet_material_type_id, sheet_eligible FROM orders WHERE order_id = $1`,
    [orderId],
  );
  const detailRows = await tx.query<{
    detail_id: number | string;
    sheet_material_type_id: number | string | null;
  }>(
    `SELECT detail_id, sheet_material_type_id FROM order_details WHERE order_id = $1 AND delete_flag = false`,
    [orderId],
  );
  // sheet_eligible=NULL (pre-SP3) → treat as false (legacy order, not eligible)
  const eligible = headerRow.rows[0]?.sheet_eligible === true;
  const headerSheetId =
    headerRow.rows[0]?.sheet_material_type_id == null
      ? null
      : Number(headerRow.rows[0].sheet_material_type_id);
  const detailSheetIds: StoredSheetDetail[] = detailRows.rows.map((row) => ({
    detailId: Number(row.detail_id),
    sheetMaterialTypeId:
      row.sheet_material_type_id == null ? null : Number(row.sheet_material_type_id),
  }));
  return { eligible, headerSheetId, detailSheetIds };
}

async function readSourceInstanceId(tx: TransactionClient): Promise<string> {
  const result = await tx.query<SourceInstanceRow>(
    "SELECT 'erp-backend:' || current_database() AS source_instance_id",
  );
  return result.rows[0]?.source_instance_id ?? 'erp-backend:unknown';
}

async function readRows(
  tx: DatabaseClient,
  sql: string,
  params: readonly unknown[] = [],
): Promise<AnyRow[]> {
  const result = await tx.query<AnyRow>(sql, params);
  return result.rows;
}

async function readRequiredRow(
  tx: DatabaseClient,
  sql: string,
  params: readonly unknown[],
  errorFactory: () => Error,
): Promise<AnyRow> {
  const result = await tx.query<AnyRow>(sql, params);
  const row = result.rows[0];
  if (!row) throw errorFactory();
  return row;
}

async function readOptionalTableRows(
  tx: TransactionClient,
  tableName: string,
  sql: string,
  params: readonly unknown[],
): Promise<Record<string, unknown>[]> {
  if (!(await tableExists(tx, tableName))) return [];

  const result = await tx.query<{ data: Record<string, unknown> }>(sql, params);
  return result.rows.map((row) => row.data);
}

async function tableExists(tx: TransactionClient, tableName: string): Promise<boolean> {
  const exists = await tx.query<{ exists: string | null }>('SELECT to_regclass($1) AS exists', [tableName]);
  return Boolean(exists.rows[0]?.exists);
}

async function readOptionalId(
  tx: TransactionClient,
  sql: string,
  params: readonly unknown[],
): Promise<number | null> {
  const result = await tx.query<IdRow>(sql, params);
  return result.rows[0] ? Number(result.rows[0].id) : null;
}

async function readOrderVersion(tx: TransactionClient, orderId: number): Promise<number> {
  return Number((await readRequiredRow(tx, 'SELECT version FROM orders WHERE order_id = $1', [orderId], () => new OrderNotFoundError(orderId))).version);
}

async function readOrderClientId(tx: TransactionClient, orderId: number): Promise<number> {
  return Number((await readRequiredRow(tx, 'SELECT client_id FROM orders WHERE order_id = $1', [orderId], () => new OrderNotFoundError(orderId))).client_id);
}

async function readOrderName(tx: TransactionClient, orderId: number): Promise<string> {
  return toStringValue((await readRequiredRow(tx, 'SELECT order_name FROM orders WHERE order_id = $1', [orderId], () => new OrderNotFoundError(orderId))).order_name);
}

async function setSessionUser(tx: TransactionClient, userId: string): Promise<void> {
  await tx.query('SELECT set_session_user($1)', [userId]);
}

function collectSnapshotSheetIds(snapshot: OrderSnapshotDto): number[] {
  const ids = new Set<number>();
  const headerSheetId = (snapshot.data.order as unknown as Record<string, unknown>).sheetMaterialTypeId;
  if (typeof headerSheetId === 'number' && Number.isFinite(headerSheetId)) {
    ids.add(headerSheetId);
  }
  for (const detail of snapshot.data.details) {
    const detailSheetId = (detail as unknown as Record<string, unknown>).sheetMaterialTypeId;
    if (typeof detailSheetId === 'number' && Number.isFinite(detailSheetId)) {
      ids.add(detailSheetId);
    }
  }
  return [...ids];
}

export async function writeAudit(
  tx: TransactionClient,
  event: string,
  currentUser: CurrentUser,
  orderId: number,
  clientId: number | null,
  metadata: Record<string, unknown>,
  relatedSheetMaterialTypeIds?: number[],
): Promise<void> {
  const sheetIds = relatedSheetMaterialTypeIds ?? [];
  await auditService.record(tx, {
    event,
    entityType: 'order',
    entityId: orderId,
    actorUserId: toNullableUserId(currentUser.id),
    actorUsername: currentUser.username,
    actorRole: currentUser.role,
    requestId: (metadata.requestId as string | undefined) ?? 'order-snapshot',
    source: SOURCE,
    relatedOrderId: orderId,
    relatedClientId: clientId ?? null,
    metadata,
    relatedEntities: sheetIds.map((entityId) => ({ entityType: 'sheet_material_type', entityId })),
  });
}

function validateDateOnly(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(422, 'VALIDATION_ERROR', `${field} must use YYYY-MM-DD format`);
  }
}

function requiredMapId(map: Map<string, number>, key: string, label: string): number {
  const value = map.get(key);
  if (!value) {
    throw new ApiError(422, 'SNAPSHOT_REFERENCE_NOT_FOUND', `${label} mapping not found`, { key });
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new ApiError(422, 'VALIDATION_ERROR', `${label} is required`);
  }
  return normalized;
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  return Number(value);
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  return Number(value);
}

function toStringValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function toDateOnly(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function toIsoNullable(value: unknown): string | null {
  if (!value) return null;
  return toIsoString(value);
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  return Boolean(value);
}

function phoneType(value: unknown): ClientPhoneSnapshotDto['phoneType'] {
  return value === 'work' || value === 'home' || value === 'fax' ? value : 'mobile';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toNullableUserId(value: string): number | null {
  const userId = Number(value);
  return Number.isInteger(userId) ? userId : null;
}

function nullableUuid(value: unknown): string | null {
  const normalized = toNullableString(value);
  return normalized && /^[0-9a-fA-F-]{36}$/.test(normalized) ? normalized : null;
}

function jsonOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Test-only exports — do not use outside tests
// ---------------------------------------------------------------------------
export {
  orderHeaderParams as _testOnlyOrderHeaderInsertParams,
  orderHeaderUpdateParams as _testOnlyOrderHeaderUpdateParams,
  mapOrderHeaderSnapshot as _testOnlyMapOrderHeaderSnapshot,
  mapDetailSnapshot as _testOnlyMapDetailSnapshot,
  detailValues as _testOnlyDetailValues,
  nullifyMaterialIdForSheetEntries as _testOnlyNullifyMaterialIdForSheetEntries,
};
