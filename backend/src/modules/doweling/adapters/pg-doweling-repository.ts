import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type { CreateDowelingOrderResponseDto, DowelingOrderLinkDto, UpdateDowelingOrderResponseDto } from '../dto/doweling.dto';
import type {
  CreateDowelingOrderCommand,
  DowelingRepositoryPort,
  UpdateDowelingOrderCommand,
} from '../application/doweling.types';
import {
  DowelingIdempotencyFailedError,
  DowelingIdempotencyInProgressError,
  DowelingIdempotencyKeyReusedError,
} from '../errors/doweling.errors';
import { assertDowelingAccess, lockOrders, mapDowelingWriteError, requestIdOrFallback, setSessionUser, SOURCE } from './doweling-sql';
import { updateDowelingOrder } from './pg-doweling-update';

const COMMAND_NAME = 'doweling.create';

interface IdempotencyRow extends QueryResultRow {
  idempotency_key: string;
  request_hash: string;
  response_json: CreateDowelingOrderResponseDto | string | null;
  status: 'processing' | 'completed' | 'failed';
}

interface InsertedDowelingRow extends QueryResultRow {
  doweling_order_id: number;
  doweling_order_name: string;
  version: number;
}

export class PgDowelingRepository implements DowelingRepositoryPort {
  constructor(private readonly database: DatabaseService) {}

  updateDowelingOrder(command: UpdateDowelingOrderCommand): Promise<UpdateDowelingOrderResponseDto> {
    return updateDowelingOrder(this.database, command);
  }

  async createDowelingOrder(command: CreateDowelingOrderCommand): Promise<CreateDowelingOrderResponseDto> {
    const orderId = command.dto.orderId ?? null;
    try {
      return await this.createInTransaction(command, orderId);
    } catch (error) {
      throw mapDowelingWriteError(
        error,
        {
          designEngineerId: command.dto.designEngineerId,
          paymentStatusId: command.dto.paymentStatusId,
          productionStatusId: command.dto.productionStatusId ?? null,
          operatorId: command.dto.operatorId ?? null,
        },
        null,
      );
    }
  }

  private createInTransaction(command: CreateDowelingOrderCommand, orderId: number | null): Promise<CreateDowelingOrderResponseDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const requestId = requestIdOrFallback(command.requestId);

      const idempotency = await reconcileIdempotency(tx, {
        idempotencyKey: command.dto.idempotencyKey,
        currentUser: command.currentUser,
        // Hash EVERY persisted field so reusing a key with any changed input is a 409, not a false replay.
        requestShape: {
          actorUserId: command.currentUser.id,
          commandName: COMMAND_NAME,
          dowelingOrderName: command.dto.dowelingOrderName.trim(),
          designEngineerId: command.dto.designEngineerId,
          paymentStatusId: command.dto.paymentStatusId,
          dowelingOrderDate: command.dto.dowelingOrderDate ?? null,
          productionStatusId: command.dto.productionStatusId ?? null,
          operatorId: command.dto.operatorId ?? null,
          partsCount: command.dto.partsCount ?? null,
          linkCadFile: command.dto.linkCadFile ?? null,
          linkPdfFile: command.dto.linkPdfFile ?? null,
          // Only when linking: a standalone create keeps the hash shape of the earlier releases, so a key stored
          // before this release still replays its response.
          ...(orderId !== null ? { orderId } : {}),
        },
      });
      if (idempotency.completedResponse) {
        return idempotency.completedResponse;
      }

      // Quick-create from an order: the order must be one the user may update (same rule as the order save).
      if (orderId !== null) {
        await assertDowelingAccess({
          database: this.database,
          tx,
          currentUser: command.currentUser,
          requestId,
          action: 'doweling_create',
          dowelingOrderId: null,
          currentOrderIds: [],
          addedOrderIds: [orderId],
          orders: await lockOrders(tx, [orderId]),
        });
      }

      const result = await tx.query<InsertedDowelingRow>(
          `
          INSERT INTO doweling_orders
            (doweling_order_name, doweling_order_date, payment_status_id, production_status_id,
             design_engineer_id, operator_id, parts_count, link_cad_file, link_pdf_file)
          VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6, COALESCE($7, 0), $8, $9)
          RETURNING doweling_order_id, doweling_order_name, version
          `,
          [
            command.dto.dowelingOrderName.trim(),
            command.dto.dowelingOrderDate ?? null,
            command.dto.paymentStatusId,
            command.dto.productionStatusId ?? null,
            command.dto.designEngineerId,
            command.dto.operatorId ?? null,
            command.dto.partsCount ?? null,
            command.dto.linkCadFile ?? null,
            command.dto.linkPdfFile ?? null,
          ],
        );
      const inserted = result.rows[0];

      let link: DowelingOrderLinkDto | null = null;
      if (orderId !== null) {
        const linked = await tx.query<{ order_doweling_link_id: string | number }>(
          `
          INSERT INTO order_doweling_links (order_id, doweling_order_id)
          VALUES ($1, $2)
          RETURNING order_doweling_link_id
          `,
          [orderId, inserted.doweling_order_id],
        );
        // The «production orders only» link trigger is deferred; fire it now so a failure is this command's error.
        await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
        link = { orderDowelingLinkId: Number(linked.rows[0].order_doweling_link_id), orderId };
      }

      const auditId = await writeAudit(tx, {
        currentUser: command.currentUser,
        requestId,
        dowelingOrderId: inserted.doweling_order_id,
        dowelingOrderName: inserted.doweling_order_name,
        designEngineerId: command.dto.designEngineerId,
        paymentStatusId: command.dto.paymentStatusId,
        productionStatusId: command.dto.productionStatusId ?? null,
        link,
      });

      await enqueueOutbox(tx, {
        idempotencyKey: command.dto.idempotencyKey,
        payload: {
          eventType: 'doweling_order.created',
          actorUserId: command.currentUser.id,
          actorUsername: command.currentUser.username,
          actorRole: command.currentUser.role,
          requestId,
          source: SOURCE,
          entityType: 'doweling_order',
          entityId: String(inserted.doweling_order_id),
          dowelingOrderId: inserted.doweling_order_id,
          designEngineerId: command.dto.designEngineerId,
          paymentStatusId: command.dto.paymentStatusId,
          productionStatusId: command.dto.productionStatusId ?? null,
          orderIds: link ? [link.orderId] : [],
          orderDowelingLinkId: link?.orderDowelingLinkId ?? null,
          version: inserted.version,
          auditId,
          action: 'doweling_create',
          idempotencyKey: command.dto.idempotencyKey,
        },
        aggregateId: String(inserted.doweling_order_id),
      });

      const response: CreateDowelingOrderResponseDto = {
        dowelingOrder: {
          dowelingOrderId: inserted.doweling_order_id,
          dowelingOrderName: inserted.doweling_order_name,
          version: inserted.version,
        },
        link,
        auditId,
        requestId,
      };
      await completeIdempotency(tx, command.dto.idempotencyKey, response);
      return response;
    });
  }
}



async function reconcileIdempotency(
  tx: TransactionClient,
  input: {
    idempotencyKey: string;
    currentUser: CurrentUser;
    requestShape: Record<string, unknown>;
  },
): Promise<{ completedResponse?: CreateDowelingOrderResponseDto }> {
  const requestHash = hashRequest(input.requestShape);
  const inserted = await tx.query<IdempotencyRow>(
    `
    INSERT INTO command_idempotency_keys (
      idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status
    )
    VALUES ($1, $2, $3, $4, $5, $6, 'processing')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING idempotency_key, request_hash, response_json, status
    `,
    [input.idempotencyKey, COMMAND_NAME, numericUserId(input.currentUser), 'doweling_order', 'pending', requestHash],
  );

  if (inserted.rows[0]) {
    return {};
  }

  const existing = await tx.query<IdempotencyRow>(
    `
    SELECT idempotency_key, request_hash, response_json, status
    FROM command_idempotency_keys
    WHERE idempotency_key = $1
    FOR UPDATE
    `,
    [input.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) {
    throw new DowelingIdempotencyInProgressError(input.idempotencyKey);
  }
  if (row.request_hash !== requestHash) {
    throw new DowelingIdempotencyKeyReusedError(input.idempotencyKey);
  }
  if (row.status === 'completed' && row.response_json) {
    return { completedResponse: parseStoredResponse(row.response_json) };
  }
  if (row.status === 'failed') {
    throw new DowelingIdempotencyFailedError(input.idempotencyKey);
  }

  throw new DowelingIdempotencyInProgressError(input.idempotencyKey);
}

async function completeIdempotency(
  tx: TransactionClient,
  idempotencyKey: string,
  response: CreateDowelingOrderResponseDto,
): Promise<void> {
  await tx.query(
    `
    UPDATE command_idempotency_keys
    SET status = 'completed',
        response_json = $2::jsonb,
        completed_at = now()
    WHERE idempotency_key = $1
    `,
    [idempotencyKey, JSON.stringify(response)],
  );
}

async function writeAudit(
  tx: TransactionClient,
  input: {
    currentUser: CurrentUser;
    requestId: string;
    dowelingOrderId: number;
    dowelingOrderName: string;
    designEngineerId: number;
    paymentStatusId: number;
    productionStatusId: number | null;
    link: DowelingOrderLinkDto | null;
  },
): Promise<string> {
  const orderIds = input.link ? [input.link.orderId] : [];
  return auditService.record(tx, {
    event: 'doweling.created',
    entityType: 'doweling_order',
    entityId: String(input.dowelingOrderId),
    actorUserId: input.currentUser.id,
    actorUsername: input.currentUser.username,
    actorRole: input.currentUser.role,
    requestId: input.requestId,
    source: SOURCE,
    relatedOrderId: input.link?.orderId ?? null,
    statusField: input.productionStatusId === null ? null : 'production_status_id',
    statusId: input.productionStatusId,
    before: {},
    after: {
      dowelingOrderId: input.dowelingOrderId,
      dowelingOrderName: input.dowelingOrderName,
      designEngineerId: input.designEngineerId,
      paymentStatusId: input.paymentStatusId,
      productionStatusId: input.productionStatusId,
      orderIds,
    },
    diff: { created: { from: false, to: true }, ...(input.link ? { orderIds: { from: [], to: orderIds } } : {}) },
    metadata: {
      source: SOURCE,
      dowelingOrderId: input.dowelingOrderId,
      designEngineerId: input.designEngineerId,
      paymentStatusId: input.paymentStatusId,
      orderId: input.link?.orderId ?? null,
      orderDowelingLinkId: input.link?.orderDowelingLinkId ?? null,
      action: 'doweling_create',
      requestId: input.requestId,
    },
    relatedEntities: [
      { entityType: 'doweling_order', entityId: input.dowelingOrderId },
      ...orderIds.map((orderId) => ({ entityType: 'order', entityId: orderId })),
    ],
  });
}

async function enqueueOutbox(
  tx: TransactionClient,
  input: {
    idempotencyKey: string;
    payload: Record<string, unknown>;
    aggregateId: string;
  },
): Promise<void> {
  await tx.query(
    `
    INSERT INTO outbox_events (
      event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
    )
    VALUES ($1, $2, $3, $4::jsonb, $5)
    ON CONFLICT (idempotency_key) DO NOTHING
    `,
    ['doweling_order.created', 'doweling_order', input.aggregateId, JSON.stringify(input.payload), input.idempotencyKey],
  );
}


function hashRequest(value: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`;
}

function parseStoredResponse(
  responseJson: CreateDowelingOrderResponseDto | string,
): CreateDowelingOrderResponseDto {
  return typeof responseJson === 'string'
    ? (JSON.parse(responseJson) as CreateDowelingOrderResponseDto)
    : responseJson;
}

function numericUserId(currentUser: CurrentUser): number {
  const value = Number(currentUser.id);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ApiError(500, 'INVALID_CURRENT_USER', 'Current user id must be numeric');
  }
  return value;
}
