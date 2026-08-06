import { createHash } from 'crypto';
import { auditService } from '../../../common/audit/audit.service';
import { computeDiff } from '../../../common/audit/audit-diff';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { OrderAccessPolicy } from '../../../permissions/policies/order-access.policy';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { OrderRefreshMetadataDto } from '../dto/order.dto';
import { OrderNotFoundError, OrderVersionConflictError } from '../errors/order.errors';
import type { OrderPermissionCheckerPort } from './order-transaction.types';

const COMMAND_NAME = 'orders.refresh';
const AUDIT_EVENT = 'orders.details_doweling_auto_set';
const OUTBOX_EVENT = 'order.details_doweling_auto_set';
const SOURCE = 'backend-orders-command';
const TRIGGER_WORD = 'Присадка';
const DOWELING_NOTE_SQL_PATTERN = '(^|[^[:alnum:]_])присадка($|[^[:alnum:]_])';

interface LockedOrderRow {
  order_id: string | number;
  version: string | number;
  created_by: string | number | null;
  manager_id: string | number | null;
}

interface UpdatedDetailRow {
  detail_id: string | number;
  previous_doweling: boolean | null;
}

interface VersionRow {
  version: string | number;
}

interface IdempotencyRow {
  request_hash: string;
  response_json: OrderRefreshMetadataDto | string | null;
  status: string;
}

export interface RefreshOrderCommand {
  currentUser: CurrentUser;
  orderId: number;
  expectedVersion: number;
  idempotencyKey: string;
  requestId?: string;
}

export interface OrderRefreshServicePorts {
  database: DatabaseService;
  permissions?: OrderPermissionCheckerPort;
}

export class OrderRefreshService {
  private readonly permissions: OrderPermissionCheckerPort;
  private readonly orderAccessPolicy = new OrderAccessPolicy();

  constructor(private readonly ports: OrderRefreshServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async refresh(command: RefreshOrderCommand): Promise<OrderRefreshMetadataDto> {
    this.requirePermission(command.currentUser, 'orders.view');
    this.requirePermission(command.currentUser, 'orders.update');
    const requestId = command.requestId ?? 'orders-refresh';

    return this.ports.database.transaction(async (tx) => {
      await tx.query('SELECT set_session_user($1)', [command.currentUser.id]);
      const order = await lockOrder(tx, command.orderId);
      if (!order) throw new OrderNotFoundError(command.orderId);
      this.requireUpdateScope(command.currentUser, order);

      const replay = await reconcileIdempotency(tx, command);
      if (replay) return replay;

      const currentVersion = toNumber(order.version);
      if (currentVersion !== command.expectedVersion) {
        throw new OrderVersionConflictError(currentVersion, command.expectedVersion);
      }

      const updated = await forceDowelingFromNotes(tx, command.orderId, actorUserIdOf(command.currentUser));
      const updatedDowelingDetailIds = updated.map((row) => toNumber(row.detail_id));
      let version = currentVersion;
      let auditId: string | null = null;

      if (updated.length > 0) {
        const versionResult = await tx.query<VersionRow>(
          `
          UPDATE orders
          SET version = version + 1,
              edited_by = $3,
              updated_at = now()
          WHERE order_id = $1 AND version = $2 AND delete_flag = false
          RETURNING version
          `,
          [command.orderId, currentVersion, actorUserIdOf(command.currentUser)],
        );
        if (!versionResult.rows[0]) {
          throw new OrderVersionConflictError(currentVersion + 1, command.expectedVersion);
        }
        version = toNumber(versionResult.rows[0].version);

        const before = {
          version: currentVersion,
          details: updated.map((row) => ({
            detailId: toNumber(row.detail_id),
            doweling: row.previous_doweling,
          })),
        };
        const after = {
          version,
          details: updatedDowelingDetailIds.map((detailId) => ({ detailId, doweling: true })),
        };
        auditId = await auditService.record(tx, {
          event: AUDIT_EVENT,
          entityType: 'order',
          entityId: command.orderId,
          actorUserId: command.currentUser.id,
          actorUsername: command.currentUser.username,
          actorRole: command.currentUser.role,
          requestId,
          source: SOURCE,
          relatedOrderId: command.orderId,
          before,
          after,
          diff: computeDiff(before, after),
          metadata: {
            commandName: COMMAND_NAME,
            triggerWord: TRIGGER_WORD,
            updatedDowelingDetailIds,
            updatedCount: updatedDowelingDetailIds.length,
            previousVersion: currentVersion,
            currentVersion: version,
          },
          relatedEntities: [
            { entityType: 'order', entityId: command.orderId },
            ...updatedDowelingDetailIds.map((detailId) => ({ entityType: 'order_detail', entityId: detailId })),
          ],
        });
        await enqueueOutbox(tx, {
          command,
          requestId,
          auditId,
          updatedDowelingDetailIds,
          previousVersion: currentVersion,
          currentVersion: version,
        });
      }

      const metadata: OrderRefreshMetadataDto = {
        baseVersion: command.expectedVersion,
        version,
        updatedDowelingDetailIds,
        auditId,
        refreshedAt: new Date().toISOString(),
        requestId,
      };
      await completeIdempotency(tx, command.idempotencyKey, metadata);
      return metadata;
    });
  }

  private requirePermission(user: CurrentUser, permission: 'orders.view' | 'orders.update'): void {
    if (!this.permissions.canUser(user, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
      });
    }
  }

  private requireUpdateScope(user: CurrentUser, order: LockedOrderRow): void {
    if (!this.orderAccessPolicy.canUpdate(user, {
      orderId: toNumber(order.order_id),
      createdByUserId: toNullableString(order.created_by),
      managerUserId: toNullableString(order.manager_id),
    })) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: ['orders.update'],
      });
    }
  }
}

async function lockOrder(tx: TransactionClient, orderId: number): Promise<LockedOrderRow | null> {
  const result = await tx.query<LockedOrderRow>(
    `
    SELECT order_id, version, created_by, manager_id
    FROM orders
    WHERE order_id = $1 AND delete_flag = false
    FOR UPDATE
    `,
    [orderId],
  );
  return result.rows[0] ?? null;
}

async function forceDowelingFromNotes(
  tx: TransactionClient,
  orderId: number,
  actorUserId: number | null,
): Promise<UpdatedDetailRow[]> {
  const result = await tx.query<UpdatedDetailRow>(
    `
    WITH candidates AS (
      SELECT detail_id, doweling
      FROM order_details
      WHERE order_id = $1
        AND delete_flag = false
        AND doweling IS DISTINCT FROM true
        AND COALESCE(note, '') ~* $2
      FOR UPDATE
    )
    UPDATE order_details detail
    SET doweling = true,
        edited_by = $3,
        updated_at = now()
    FROM candidates
    WHERE detail.detail_id = candidates.detail_id
    RETURNING detail.detail_id, candidates.doweling AS previous_doweling
    `,
    [orderId, DOWELING_NOTE_SQL_PATTERN, actorUserId],
  );
  return result.rows;
}

async function reconcileIdempotency(
  tx: TransactionClient,
  command: RefreshOrderCommand,
): Promise<OrderRefreshMetadataDto | null> {
  const requestHash = createHash('sha256').update(JSON.stringify({
    actorUserId: command.currentUser.id,
    commandName: COMMAND_NAME,
    orderId: command.orderId,
    expectedVersion: command.expectedVersion,
  })).digest('hex');
  const inserted = await tx.query<IdempotencyRow>(
    `
    INSERT INTO command_idempotency_keys (
      idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status
    )
    VALUES ($1, $2, $3, 'order', $4, $5, 'processing')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING request_hash, response_json, status
    `,
    [command.idempotencyKey, COMMAND_NAME, actorUserIdOf(command.currentUser), String(command.orderId), requestHash],
  );
  if (inserted.rows[0]) return null;

  const existing = await tx.query<IdempotencyRow>(
    `
    SELECT request_hash, response_json, status
    FROM command_idempotency_keys
    WHERE idempotency_key = $1
    FOR UPDATE
    `,
    [command.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) {
    throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing', {
      idempotencyKey: command.idempotencyKey,
    });
  }
  if (row.request_hash !== requestHash) {
    throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with a different request', {
      idempotencyKey: command.idempotencyKey,
    });
  }
  if (row.status === 'processing') {
    throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing', {
      idempotencyKey: command.idempotencyKey,
    });
  }
  if (row.status === 'completed' && row.response_json) {
    return typeof row.response_json === 'string'
      ? JSON.parse(row.response_json) as OrderRefreshMetadataDto
      : row.response_json;
  }
  throw new ApiError(409, 'IDEMPOTENCY_FAILED', 'Idempotent command previously failed', {
    idempotencyKey: command.idempotencyKey,
  });
}

async function completeIdempotency(
  tx: TransactionClient,
  idempotencyKey: string,
  metadata: OrderRefreshMetadataDto,
): Promise<void> {
  await tx.query(
    `
    UPDATE command_idempotency_keys
    SET status = 'completed', response_json = $2::jsonb, completed_at = now()
    WHERE idempotency_key = $1 AND status = 'processing'
    `,
    [idempotencyKey, JSON.stringify(metadata)],
  );
}

async function enqueueOutbox(
  tx: TransactionClient,
  input: {
    command: RefreshOrderCommand;
    requestId: string;
    auditId: string;
    updatedDowelingDetailIds: number[];
    previousVersion: number;
    currentVersion: number;
  },
): Promise<void> {
  await tx.query(
    `
    INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
    VALUES ($1, 'order', $2, $3::jsonb, $4)
    ON CONFLICT (idempotency_key) DO NOTHING
    `,
    [
      OUTBOX_EVENT,
      String(input.command.orderId),
      JSON.stringify({
        eventType: OUTBOX_EVENT,
        actorUserId: input.command.currentUser.id,
        requestId: input.requestId,
        auditId: input.auditId,
        orderId: input.command.orderId,
        updatedDowelingDetailIds: input.updatedDowelingDetailIds,
        updatedCount: input.updatedDowelingDetailIds.length,
        previousVersion: input.previousVersion,
        currentVersion: input.currentVersion,
      }),
      `${input.command.idempotencyKey}:${OUTBOX_EVENT}`,
    ],
  );
}

function actorUserIdOf(user: CurrentUser): number | null {
  const parsed = Number(user.id);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ApiError(500, 'INVALID_DATABASE_NUMBER', 'Invalid numeric database value');
  }
  return parsed;
}

function toNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
