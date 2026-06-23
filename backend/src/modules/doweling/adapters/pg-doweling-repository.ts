import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type { CreateDowelingOrderResponseDto } from '../dto/doweling.dto';
import type { CreateDowelingOrderCommand, DowelingRepositoryPort } from '../application/doweling.types';
import {
  DowelingIdempotencyFailedError,
  DowelingIdempotencyInProgressError,
  DowelingIdempotencyKeyReusedError,
  DowelingReferenceNotFoundError,
} from '../errors/doweling.errors';

const SOURCE = 'backend-doweling-command';
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

  createDowelingOrder(command: CreateDowelingOrderCommand): Promise<CreateDowelingOrderResponseDto> {
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
        },
      });
      if (idempotency.completedResponse) {
        return idempotency.completedResponse;
      }

      let inserted: InsertedDowelingRow;
      try {
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
        inserted = result.rows[0];
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          throw new DowelingReferenceNotFoundError({
            designEngineerId: command.dto.designEngineerId,
            paymentStatusId: command.dto.paymentStatusId,
            productionStatusId: command.dto.productionStatusId ?? null,
            operatorId: command.dto.operatorId ?? null,
          });
        }
        throw error;
      }

      const auditId = await writeAudit(tx, {
        currentUser: command.currentUser,
        requestId,
        dowelingOrderId: inserted.doweling_order_id,
        dowelingOrderName: inserted.doweling_order_name,
        designEngineerId: command.dto.designEngineerId,
        paymentStatusId: command.dto.paymentStatusId,
        productionStatusId: command.dto.productionStatusId ?? null,
      });

      await enqueueOutbox(tx, {
        idempotencyKey: command.dto.idempotencyKey,
        payload: {
          eventType: 'doweling_order.created',
          actorUserId: command.currentUser.id,
          requestId,
          entityType: 'doweling_order',
          entityId: String(inserted.doweling_order_id),
          dowelingOrderId: inserted.doweling_order_id,
          designEngineerId: command.dto.designEngineerId,
          paymentStatusId: command.dto.paymentStatusId,
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
        auditId,
        requestId,
      };
      await completeIdempotency(tx, command.dto.idempotencyKey, response);
      return response;
    });
  }
}

async function setSessionUser(tx: TransactionClient, userId: string): Promise<void> {
  await tx.query('SELECT set_session_user($1)', [userId]);
}

function requestIdOrFallback(requestId: string | undefined): string {
  return requestId && requestId.length > 0 ? requestId : 'doweling-command';
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
  },
): Promise<string> {
  return auditService.record(tx, {
    event: 'doweling.created',
    entityType: 'doweling_order',
    entityId: String(input.dowelingOrderId),
    actorUserId: input.currentUser.id,
    actorUsername: input.currentUser.username,
    actorRole: input.currentUser.role,
    requestId: input.requestId,
    source: SOURCE,
    before: {},
    after: {
      dowelingOrderId: input.dowelingOrderId,
      dowelingOrderName: input.dowelingOrderName,
      designEngineerId: input.designEngineerId,
      paymentStatusId: input.paymentStatusId,
      productionStatusId: input.productionStatusId,
    },
    diff: { created: { from: false, to: true } },
    metadata: {
      source: SOURCE,
      dowelingOrderId: input.dowelingOrderId,
      designEngineerId: input.designEngineerId,
      paymentStatusId: input.paymentStatusId,
      action: 'doweling_create',
      requestId: input.requestId,
    },
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

function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23503'
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
