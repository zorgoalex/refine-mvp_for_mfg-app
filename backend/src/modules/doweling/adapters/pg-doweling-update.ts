import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import type { UpdateDowelingOrderCommand } from '../application/doweling.types';
import type { DowelingOrderLinkDto, UpdateDowelingOrderRequestDto, UpdateDowelingOrderResponseDto } from '../dto/doweling.dto';
import { DowelingLinksConflictError, DowelingOrderNotFoundError, DowelingVersionConflictError } from '../errors/doweling.errors';
import { assertDowelingAccess, lockOrders, mapDowelingWriteError, readOrders, requestIdOrFallback, setSessionUser, SOURCE } from './doweling-sql';

/** The editable state of a doweling order, compared field by field to decide what changed. */
export interface DowelingState {
  dowelingOrderName: string;
  dowelingOrderDate: string;
  paymentStatusId: number;
  productionStatusId: number | null;
  designEngineerId: number;
  operatorId: number | null;
  issueDate: string | null;
  paymentDate: string | null;
  partsCount: number | null;
  totalAmount: number | null;
  finalAmount: number | null;
  discount: number;
  surcharge: number;
  paidAmount: number | null;
  linkCadFile: string | null;
  linkPdfFile: string | null;
  refKey1c: string | null;
  isActive: boolean;
}

const STATUS_FIELDS: ReadonlyArray<{ field: 'productionStatusId' | 'paymentStatusId'; column: string }> = [
  { field: 'productionStatusId', column: 'production_status_id' },
  { field: 'paymentStatusId', column: 'payment_status_id' },
];

/**
 * Payload of the `doweling_order.updated` outbox event (aggregate doweling_order/<id>, idempotency key
 * `doweling_order.updated:<id>:v<version>` — one event per committed version, a repeated delivery is dropped).
 */
export interface DowelingOrderUpdatedEvent {
  eventType: 'doweling_order.updated';
  actorUserId: string;
  actorUsername: string;
  actorRole: string;
  requestId: string;
  source: string;
  entityType: 'doweling_order';
  entityId: string;
  dowelingOrderId: number;
  action: string;
  isActive: boolean;
  changedFields: Array<keyof DowelingState>;
  statusChanges: Array<{ field: string; from: number | null; to: number | null }>;
  orderIds: number[];
  addedOrderIds: number[];
  removedOrderIds: number[];
  previousVersion: number;
  version: number;
  auditId: string;
  idempotencyKey: string;
}

const STATE_FIELDS: ReadonlyArray<keyof DowelingState> = [
  'dowelingOrderName', 'dowelingOrderDate', 'paymentStatusId', 'productionStatusId', 'designEngineerId', 'operatorId',
  'issueDate', 'paymentDate', 'partsCount', 'totalAmount', 'finalAmount', 'discount', 'surcharge', 'paidAmount',
  'linkCadFile', 'linkPdfFile', 'refKey1c', 'isActive',
];

interface DowelingRow extends QueryResultRow {
  doweling_order_name: string;
  doweling_order_date: string;
  legacy_order_id: string | number | null;
  payment_status_id: number;
  production_status_id: number | null;
  design_engineer_id: string | number;
  operator_id: string | number | null;
  issue_date: string | null;
  payment_date: string | null;
  parts_count: number | null;
  total_amount: string | null;
  final_amount: string | null;
  discount: string;
  surcharge: string;
  paid_amount: string | null;
  link_cad_file: string | null;
  link_pdf_file: string | null;
  ref_key_1c: string | null;
  delete_flag: boolean;
  version: number;
}

interface LinkRow extends QueryResultRow {
  order_doweling_link_id: string | number;
  order_id: string | number;
  delete_flag: boolean;
}

const DOWELING_COLUMNS = `
  doweling_order_name,
  to_char(doweling_order_date, 'YYYY-MM-DD') AS doweling_order_date,
  order_id AS legacy_order_id,
  payment_status_id, production_status_id, design_engineer_id, operator_id,
  to_char(issue_date, 'YYYY-MM-DD') AS issue_date,
  to_char(payment_date, 'YYYY-MM-DD') AS payment_date,
  parts_count,
  total_amount::text AS total_amount, final_amount::text AS final_amount, discount::text AS discount,
  surcharge::text AS surcharge, paid_amount::text AS paid_amount,
  link_cad_file, link_pdf_file, ref_key_1c::text AS ref_key_1c, delete_flag, version`;

export async function updateDowelingOrder(
  database: DatabaseClient & { transaction<T>(handler: (tx: TransactionClient) => Promise<T>): Promise<T> },
  command: UpdateDowelingOrderCommand,
): Promise<UpdateDowelingOrderResponseDto> {
  const { dowelingOrderId, dto, currentUser } = command;
  const requestId = requestIdOrFallback(command.requestId);
  const wantedOrderIds = [...new Set(dto.orderIds)].sort((a, b) => a - b);

  try {
    return await database.transaction(async (tx) => {
      await setSessionUser(tx, currentUser.id);

      // 1. Which orders are involved — read without locks, then lock orders first (the order-save lock order).
      const preview = await tx.query<{ legacy_order_id: string | number | null; linked: Array<string | number> }>(
        `
        SELECT d.order_id AS legacy_order_id,
               ARRAY(SELECT l.order_id FROM order_doweling_links l
                     WHERE l.doweling_order_id = d.doweling_order_id AND l.delete_flag = false) AS linked
        FROM doweling_orders d
        WHERE d.doweling_order_id = $1
        `,
        [dowelingOrderId],
      );
      if (!preview.rows[0]) {
        throw new DowelingOrderNotFoundError(dowelingOrderId);
      }
      const orders = await lockOrders(tx, [
        ...previewOrderIds(preview.rows[0]),
        ...wantedOrderIds,
      ]);

      // 2. The doweling order and all its links, under lock.
      const locked = await tx.query<DowelingRow>(
        `SELECT ${DOWELING_COLUMNS} FROM doweling_orders WHERE doweling_order_id = $1 FOR UPDATE`,
        [dowelingOrderId],
      );
      const row = locked.rows[0];
      if (!row) {
        throw new DowelingOrderNotFoundError(dowelingOrderId);
      }
      const links = (
        await tx.query<LinkRow>(
          `
          SELECT order_doweling_link_id, order_id, delete_flag
          FROM order_doweling_links
          WHERE doweling_order_id = $1
          ORDER BY order_doweling_link_id
          FOR UPDATE
          `,
          [dowelingOrderId],
        )
      ).rows.map((link) => ({ id: Number(link.order_doweling_link_id), orderId: Number(link.order_id), deleted: link.delete_flag }));

      const activeOrderIds = links.filter((link) => !link.deleted).map((link) => link.orderId);
      const legacyOrderId = row.legacy_order_id === null ? null : Number(row.legacy_order_id);
      const currentOrderIds = [...new Set([...activeOrderIds, ...(legacyOrderId === null ? [] : [legacyOrderId])])].sort((a, b) => a - b);
      // A link committed between the preview and the lock: read its order WITHOUT a lock — locking an order after the
      // doweling order would invert the lock hierarchy (doweling-sql.ts). The link is already ours (row lock above).
      const unread = currentOrderIds.filter((orderId) => !orders.has(orderId));
      if (unread.length > 0) {
        for (const [orderId, order] of await readOrders(tx, unread, { lock: false })) orders.set(orderId, order);
      }

      // 3. Access before anything else is disclosed (the version included).
      // The orders of a doweling order = its active links ∪ the legacy order_id (a legacy-only order stays as it is).
      const addedOrderIds = wantedOrderIds.filter((orderId) => !currentOrderIds.includes(orderId));
      await assertDowelingAccess({
        database,
        tx,
        currentUser,
        requestId,
        action: 'doweling_update',
        dowelingOrderId,
        currentOrderIds,
        addedOrderIds,
        orders,
      });

      if (row.version !== dto.expectedVersion) {
        throw new DowelingVersionConflictError(dowelingOrderId, dto.expectedVersion, row.version);
      }
      // The orders the card showed must be the current ones: the card reads fields and links separately, so a
      // version from a newer read with links from an older one must not drop a link added meanwhile.
      const baseOrderIds = [...new Set(dto.baseOrderIds)].sort((a, b) => a - b);
      if (baseOrderIds.join(',') !== currentOrderIds.join(',')) {
        throw new DowelingLinksConflictError(dowelingOrderId, baseOrderIds, currentOrderIds);
      }

      // 4. What changes.
      const before = stateFromRow(row);
      const after = stateFromDto(dto);
      const changedFields = STATE_FIELDS.filter((field) => before[field] !== after[field]);
      const removedOrderIds = currentOrderIds.filter((orderId) => !wantedOrderIds.includes(orderId));
      const nextLegacyOrderId = legacyOrderId !== null && wantedOrderIds.includes(legacyOrderId) ? legacyOrderId : null;
      const legacyChanged = nextLegacyOrderId !== legacyOrderId;

      if (changedFields.length === 0 && addedOrderIds.length === 0 && removedOrderIds.length === 0) {
        return {
          dowelingOrder: { dowelingOrderId, dowelingOrderName: row.doweling_order_name, version: row.version, isActive: !row.delete_flag },
          links: activeLinks(links),
          changed: false,
          requestId,
        };
      }

      // 5. Write: the doweling order, then its links.
      const updated = await tx.query<{ version: number; doweling_order_name: string; delete_flag: boolean }>(
        `
        UPDATE doweling_orders
        SET doweling_order_name = $2, doweling_order_date = $3::date, payment_status_id = $4, production_status_id = $5,
            design_engineer_id = $6, operator_id = $7, issue_date = $8::date, payment_date = $9::date, parts_count = $10,
            total_amount = $11, final_amount = $12, discount = $13, surcharge = $14, paid_amount = $15,
            link_cad_file = $16, link_pdf_file = $17, ref_key_1c = $18::uuid, delete_flag = $19, order_id = $20,
            version = version + 1
        WHERE doweling_order_id = $1
        RETURNING version, doweling_order_name, delete_flag
        `,
        [
          dowelingOrderId, after.dowelingOrderName, after.dowelingOrderDate, after.paymentStatusId, after.productionStatusId,
          after.designEngineerId, after.operatorId, after.issueDate, after.paymentDate, after.partsCount,
          after.totalAmount, after.finalAmount, after.discount, after.surcharge, after.paidAmount,
          after.linkCadFile, after.linkPdfFile, after.refKey1c, !after.isActive, nextLegacyOrderId,
        ],
      );
      const result = updated.rows[0];

      const removedLinkIds = links.filter((link) => !link.deleted && removedOrderIds.includes(link.orderId)).map((link) => link.id);
      if (removedLinkIds.length > 0) {
        await tx.query(
          `UPDATE order_doweling_links SET delete_flag = true, version = version + 1 WHERE order_doweling_link_id = ANY($1::bigint[])`,
          [removedLinkIds],
        );
      }
      const revivedLinkIds = links.filter((link) => link.deleted && addedOrderIds.includes(link.orderId)).map((link) => link.id);
      if (revivedLinkIds.length > 0) {
        await tx.query(
          `UPDATE order_doweling_links SET delete_flag = false, version = version + 1 WHERE order_doweling_link_id = ANY($1::bigint[])`,
          [revivedLinkIds],
        );
      }
      const insertedOrderIds = addedOrderIds.filter((orderId) => !links.some((link) => link.orderId === orderId));
      if (insertedOrderIds.length > 0) {
        await tx.query(
          `
          INSERT INTO order_doweling_links (order_id, doweling_order_id)
          SELECT order_id, $2 FROM unnest($1::bigint[]) AS added(order_id)
          `,
          [insertedOrderIds, dowelingOrderId],
        );
      }
      // The «production orders only» link trigger is deferred; fire it now so a failure is this command's error.
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');

      const finalLinks = (
        await tx.query<LinkRow>(
          `
          SELECT order_doweling_link_id, order_id, delete_flag
          FROM order_doweling_links
          WHERE doweling_order_id = $1 AND delete_flag = false
          ORDER BY order_id
          `,
          [dowelingOrderId],
        )
      ).rows.map((link) => ({ id: Number(link.order_doweling_link_id), orderId: Number(link.order_id), deleted: false }));

      // 6. Audit and the domain event, in the same transaction.
      const event = before.isActive !== after.isActive ? (after.isActive ? 'doweling.activated' : 'doweling.deactivated') : 'doweling.updated';
      const action = event.replace('.', '_');
      const statusChanges = STATUS_FIELDS.filter(({ field }) => changedFields.includes(field)).map(({ field, column }) => ({
        field: column,
        from: before[field] as number | null,
        to: after[field] as number | null,
      }));
      // Normalized status dimension: the production status wins when both statuses change (both are in the diff).
      const primaryStatus = statusChanges.find((change) => change.field === 'production_status_id') ?? statusChanges[0] ?? null;
      const touchedOrderIds = [...new Set([...currentOrderIds, ...wantedOrderIds])].sort((a, b) => a - b);
      const diff: Record<string, unknown> = Object.fromEntries(
        changedFields.map((field) => [field, { from: before[field], to: after[field] }]),
      );
      if (addedOrderIds.length > 0 || removedOrderIds.length > 0) {
        diff.orderIds = { from: currentOrderIds, to: wantedOrderIds };
      }
      if (legacyChanged) {
        diff.legacyOrderId = { from: legacyOrderId, to: nextLegacyOrderId };
      }
      const auditId = await auditService.record(tx, {
        event,
        entityType: 'doweling_order',
        entityId: String(dowelingOrderId),
        actorUserId: currentUser.id,
        actorUsername: currentUser.username,
        actorRole: currentUser.role,
        requestId,
        source: SOURCE,
        relatedOrderId: touchedOrderIds.length === 1 ? touchedOrderIds[0] : null,
        statusField: primaryStatus?.field ?? null,
        statusId: primaryStatus?.to ?? null,
        statusCode: before.isActive !== after.isActive ? (after.isActive ? 'activated' : 'deactivated') : null,
        before: { ...pick(before, changedFields), orderIds: currentOrderIds, version: row.version },
        after: { ...pick(after, changedFields), orderIds: wantedOrderIds, version: result.version },
        diff,
        metadata: {
          source: SOURCE,
          action,
          dowelingOrderId,
          changedFields,
          statusChanges,
          addedOrderIds,
          removedOrderIds,
          previousVersion: row.version,
          version: result.version,
          requestId,
        },
        relatedEntities: [
          { entityType: 'doweling_order', entityId: dowelingOrderId },
          ...touchedOrderIds.map((orderId) => ({ entityType: 'order', entityId: orderId })),
        ],
      });

      const eventKey = `doweling_order.updated:${dowelingOrderId}:v${result.version}`;
      await tx.query(
        `
        INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
        VALUES ($1, $2, $3, $4::jsonb, $5)
        ON CONFLICT (idempotency_key) DO NOTHING
        `,
        [
          'doweling_order.updated',
          'doweling_order',
          String(dowelingOrderId),
          JSON.stringify({
            eventType: 'doweling_order.updated',
            actorUserId: currentUser.id,
            actorUsername: currentUser.username,
            actorRole: currentUser.role,
            requestId,
            source: SOURCE,
            entityType: 'doweling_order',
            entityId: String(dowelingOrderId),
            dowelingOrderId,
            action,
            isActive: after.isActive,
            changedFields,
            statusChanges,
            orderIds: wantedOrderIds,
            addedOrderIds,
            removedOrderIds,
            previousVersion: row.version,
            version: result.version,
            auditId,
            idempotencyKey: eventKey,
          } satisfies DowelingOrderUpdatedEvent),
          eventKey,
        ],
      );

      return {
        dowelingOrder: {
          dowelingOrderId,
          dowelingOrderName: result.doweling_order_name,
          version: result.version,
          isActive: !result.delete_flag,
        },
        links: activeLinks(finalLinks),
        changed: true,
        auditId,
        requestId,
      };
    });
  } catch (error) {
    throw mapDowelingWriteError(
      error,
      {
        paymentStatusId: dto.paymentStatusId,
        productionStatusId: dto.productionStatusId,
        designEngineerId: dto.designEngineerId,
        operatorId: dto.operatorId,
      },
      dowelingOrderId,
    );
  }
}

function previewOrderIds(row: { legacy_order_id: string | number | null; linked: Array<string | number> }): number[] {
  return [...row.linked.map(Number), ...(row.legacy_order_id === null ? [] : [Number(row.legacy_order_id)])];
}

function activeLinks(links: Array<{ id: number; orderId: number; deleted: boolean }>): DowelingOrderLinkDto[] {
  return links
    .filter((link) => !link.deleted)
    .sort((a, b) => a.orderId - b.orderId)
    .map((link) => ({ orderDowelingLinkId: link.id, orderId: link.orderId }));
}

function pick(state: DowelingState, fields: ReadonlyArray<keyof DowelingState>): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, state[field]]));
}

function amount(value: string | null): number | null {
  return value === null ? null : Number(value);
}

export function stateFromRow(row: DowelingRow): DowelingState {
  return {
    dowelingOrderName: row.doweling_order_name,
    dowelingOrderDate: row.doweling_order_date,
    paymentStatusId: Number(row.payment_status_id),
    productionStatusId: row.production_status_id === null ? null : Number(row.production_status_id),
    designEngineerId: Number(row.design_engineer_id),
    operatorId: row.operator_id === null ? null : Number(row.operator_id),
    issueDate: row.issue_date,
    paymentDate: row.payment_date,
    partsCount: row.parts_count === null ? null : Number(row.parts_count),
    totalAmount: amount(row.total_amount),
    finalAmount: amount(row.final_amount),
    discount: Number(row.discount),
    surcharge: Number(row.surcharge),
    paidAmount: amount(row.paid_amount),
    linkCadFile: row.link_cad_file,
    linkPdfFile: row.link_pdf_file,
    refKey1c: row.ref_key_1c === null ? null : row.ref_key_1c.toLowerCase(),
    isActive: row.delete_flag !== true,
  };
}

export function stateFromDto(dto: UpdateDowelingOrderRequestDto): DowelingState {
  return {
    dowelingOrderName: dto.dowelingOrderName,
    dowelingOrderDate: dto.dowelingOrderDate,
    paymentStatusId: dto.paymentStatusId,
    productionStatusId: dto.productionStatusId,
    designEngineerId: dto.designEngineerId,
    operatorId: dto.operatorId,
    issueDate: dto.issueDate,
    paymentDate: dto.paymentDate,
    partsCount: dto.partsCount,
    totalAmount: dto.totalAmount,
    finalAmount: dto.finalAmount,
    discount: dto.discount,
    surcharge: dto.surcharge,
    paidAmount: dto.paidAmount,
    linkCadFile: dto.linkCadFile,
    linkPdfFile: dto.linkPdfFile,
    refKey1c: dto.refKey1c === null ? null : dto.refKey1c.toLowerCase(),
    isActive: dto.isActive,
  };
}
