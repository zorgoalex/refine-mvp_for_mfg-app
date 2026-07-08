import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { OrderAccessPolicy } from '../../../permissions/policies/order-access.policy';
import { insertAutoRoot } from '../../orders/adapters/pg-order-transaction-manager';
import type {
  ListProjectsQuery,
  MergeCommand,
  MergeResult,
  MoveOrderCommand,
  MoveOrderResult,
  ProjectCard,
  ProjectDto,
  ProjectOrderRow,
  ProjectsRepositoryPort,
  UpdateProjectCommand,
} from '../application/projects.types';
import {
  ProjectArchivedError,
  ProjectCodeTakenError,
  ProjectClientMismatchError,
  ProjectNotFoundError,
  ProjectVersionConflictError,
} from '../errors/projects.errors';

const SOURCE = 'backend-projects-command';
const MOVE_ORDER_COMMAND = 'projects.move_order';
const MERGE_COMMAND = 'projects.merge';

interface ProjectRow extends QueryResultRow {
  project_id: number | string;
  code: string;
  name: string;
  client_id: number | string;
  client_name?: string | null;
  notes: string | null;
  version: number | string;
  orders_count?: number | string | null;
  total_final_amount?: string | null;
  total_paid_amount?: string | null;
  delete_flag?: boolean;
}

interface ProjectOrderRowDb extends QueryResultRow {
  order_id: number | string;
  order_name: string;
  order_full_number: string;
  final_amount: string | null;
  paid_amount: string | null;
  order_status_name: string | null;
  delete_flag: boolean;
}

interface LockedOrderRow extends QueryResultRow {
  order_id: number | string;
  order_name: string;
  client_id: number | string;
  project_id: number | string;
  created_by: string | number | null;
  manager_id: string | number | null;
}

interface MoveTargetProjectRow extends QueryResultRow {
  project_id: number | string;
  client_id: number | string;
  delete_flag: boolean;
  code: string;
}

interface IdempotencyRow extends QueryResultRow {
  idempotency_key: string;
  request_hash: string;
  response_json: CommandResponse | string | null;
  status: 'processing' | 'completed' | 'failed';
}

type CommandResponse = MoveOrderResult | MergeResult;

export class PgProjectsRepository implements ProjectsRepositoryPort {
  constructor(private readonly database: DatabaseService) {}

  async list(query: ListProjectsQuery): Promise<ProjectDto[]> {
    const result = await this.database.query<ProjectRow>(
      `
      SELECT
        project_id,
        code,
        name,
        client_id,
        client_name,
        notes,
        version,
        orders_count,
        total_final_amount,
        total_paid_amount
      FROM projects_view
      WHERE ($1::text IS NULL OR code ILIKE '%' || $1 || '%' OR name ILIKE '%' || $1 || '%' OR client_name ILIKE '%' || $1 || '%')
        AND ($2::bigint IS NULL OR client_id = $2)
        AND ($3::boolean = true OR delete_flag = false)
      ORDER BY delete_flag ASC, code ASC, project_id ASC
      `,
      [query.search ?? null, query.clientId ?? null, query.includeArchived ?? false],
    );

    return result.rows.map(mapProjectRow);
  }

  async getById(projectId: number): Promise<ProjectCard> {
    const project = await this.database.query<ProjectRow>(
      `
      SELECT
        project_id,
        code,
        name,
        client_id,
        client_name,
        notes,
        version,
        orders_count,
        total_final_amount,
        total_paid_amount
      FROM projects_view
      WHERE project_id = $1
      `,
      [projectId],
    );
    const row = project.rows[0];
    if (!row) {
      throw new ProjectNotFoundError(projectId);
    }

    const orders = await this.database.query<ProjectOrderRowDb>(
      `
      SELECT
        order_id,
        order_name,
        order_full_number,
        final_amount,
        paid_amount,
        order_status_name,
        delete_flag
      FROM orders_view
      WHERE project_id = $1
      ORDER BY order_id ASC
      `,
      [projectId],
    );

    return {
      ...mapProjectRow(row),
      orders: orders.rows.map(mapProjectOrderRow),
    };
  }

  async update(command: UpdateProjectCommand): Promise<ProjectDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);

      const existing = await tx.query<ProjectRow>(
        `
        SELECT project_id, code, name, client_id, notes, version, delete_flag
        FROM projects
        WHERE project_id = $1
        FOR UPDATE
        `,
        [command.projectId],
      );
      const before = existing.rows[0];
      if (!before) {
        throw new ProjectNotFoundError(command.projectId);
      }
      if (before.delete_flag) {
        throw new ProjectArchivedError(command.projectId);
      }
      if (Number(before.version) !== command.expectedVersion) {
        throw new ProjectVersionConflictError();
      }

      try {
        const updated = await tx.query<ProjectRow>(
          `
          UPDATE projects
          SET
            code = COALESCE($2, code),
            name = COALESCE($3, name),
            notes = CASE WHEN $4::boolean THEN $5 ELSE notes END,
            version = version + 1,
            edited_by = $6,
            updated_at = now()
          WHERE project_id = $1
          RETURNING project_id, code, name, client_id, notes, version
          `,
          [
            command.projectId,
            command.dto.code ?? null,
            command.dto.name ?? null,
            command.dto.notes !== undefined,
            command.dto.notes ?? null,
            command.currentUser.id,
          ],
        );

        const row = updated.rows[0];
        await writeAudit(tx, {
          currentUser: command.currentUser,
          requestId: requestIdOrFallback(command.requestId),
          projectId: command.projectId,
          clientId: Number(before.client_id),
          before: {
            code: before.code,
            name: before.name,
            notes: before.notes,
          },
          after: {
            code: row.code,
            name: row.name,
            notes: row.notes,
          },
        });

        return mapProjectRow(row);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ProjectCodeTakenError(command.dto.code ?? '');
        }
        throw error;
      }
    });
  }

  moveOrder(command: MoveOrderCommand): Promise<MoveOrderResult> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const requestId = requestIdOrFallback(command.requestId);
      const idempotency = await reconcileIdempotency<MoveOrderResult>(tx, {
        idempotencyKey: command.idempotencyKey,
        commandName: MOVE_ORDER_COMMAND,
        currentUser: command.currentUser,
        entityType: 'order',
        entityId: String(command.orderId),
        requestShape: { ...command },
      });
      if (idempotency.completedResponse) {
        return idempotency.completedResponse;
      }

      // Global lock order across move/merge: project rows (ascending) first,
      // order rows after. Read the order's current project without a lock,
      // lock the projects, then lock the order and re-verify its project —
      // taking the order lock first would invert merge's order and deadlock.
      const preReadResult = await tx.query<{ project_id: number | string }>(
        `
        SELECT project_id
        FROM orders
        WHERE order_id = $1 AND delete_flag = false
        `,
        [command.orderId],
      );
      const preRead = preReadResult.rows[0];
      if (!preRead) {
        throw new ApiError(404, 'ORDER_NOT_FOUND', `Заказ ${command.orderId} не найден`);
      }
      const fromProjectId = Number(preRead.project_id);

      if (!command.createNew && command.targetProjectId === fromProjectId) {
        throw new ApiError(422, 'PROJECT_SAME', 'Заказ уже в этом проекте');
      }

      // The source lock also serialises the "last order leaves -> archive"
      // decision against concurrent moves.
      const projectIdsToLock = command.createNew
        ? [fromProjectId]
        : [...new Set([fromProjectId, command.targetProjectId!])].sort((left, right) => left - right);
      const lockedProjects = new Map<number, MoveTargetProjectRow | undefined>();
      for (const projectId of projectIdsToLock) {
        lockedProjects.set(projectId, await lockProject(tx, projectId));
      }

      const orderResult = await tx.query<LockedOrderRow>(
        `
        SELECT o.order_id, o.order_name, o.client_id, o.project_id, o.created_by, o.manager_id
        FROM orders o
        WHERE o.order_id = $1 AND o.delete_flag = false
        FOR UPDATE
        `,
        [command.orderId],
      );
      const order = orderResult.rows[0];
      if (!order) {
        throw new ApiError(404, 'ORDER_NOT_FOUND', `Заказ ${command.orderId} не найден`);
      }
      if (Number(order.project_id) !== fromProjectId) {
        // A concurrent move/merge re-parented the order between our unlocked
        // pre-read and the lock — the project locks we hold are the wrong
        // ones. Client retries with a fresh read.
        throw new ApiError(409, 'ORDER_PROJECT_CONFLICT', 'Заказ перемещён параллельной операцией, повторите');
      }
      assertOrdersUpdateScope(command.currentUser, [order]);

      const clientId = Number(order.client_id);

      let target: { id: number; code: string };
      if (command.createNew) {
        const created = await insertAutoRoot(tx, {
          orderName: order.order_name,
          clientId,
          currentUser: command.currentUser,
          requestId,
        });
        target = {
          id: created.projectId,
          code: created.code,
        };
      } else {
        const row = lockedProjects.get(command.targetProjectId!);
        if (!row) {
          throw new ProjectNotFoundError(command.targetProjectId!);
        }
        if (row.delete_flag) {
          throw new ProjectArchivedError(command.targetProjectId!);
        }
        if (Number(row.client_id) !== clientId) {
          throw new ProjectClientMismatchError();
        }
        target = {
          id: Number(row.project_id),
          code: row.code,
        };
      }

      if (target.id === fromProjectId) {
        throw new ApiError(422, 'PROJECT_SAME', 'Заказ уже в этом проекте');
      }

      await tx.query(
        `
        UPDATE orders
        SET project_id = $2, version = version + 1, edited_by = $3, updated_at = now()
        WHERE order_id = $1
        `,
        [command.orderId, target.id, command.currentUser.id],
      );

      const remainingResult = await tx.query<{ c: number | string }>(
        `
        SELECT COUNT(*) AS c
        FROM orders
        WHERE project_id = $1
        `,
        [fromProjectId],
      );
      const remaining = Number(remainingResult.rows[0]?.c ?? 0);

      let archivedSourceProjectId: number | null = null;
      if (remaining === 0) {
        await tx.query(
          `
          UPDATE projects
          SET delete_flag = true, version = version + 1, edited_by = $2, updated_at = now()
          WHERE project_id = $1
          `,
          [fromProjectId, command.currentUser.id],
        );
        archivedSourceProjectId = fromProjectId;

        await writeProjectArchivedAudit(tx, {
          currentUser: command.currentUser,
          requestId,
          projectId: fromProjectId,
          clientId,
        });
        await enqueueOutbox(tx, {
          eventType: 'project.archived',
          aggregateType: 'project',
          aggregateId: String(fromProjectId),
          payload: {
            eventType: 'project.archived',
            projectId: fromProjectId,
            reason: 'emptied_by_move',
            actorUserId: command.currentUser.id,
            requestId,
          },
          idempotencyKey: `${command.idempotencyKey}:archived`,
        });
      }

      const auditId = await writeMoveOrderAudit(tx, {
        currentUser: command.currentUser,
        requestId,
        orderId: command.orderId,
        clientId,
        fromProjectId,
        toProjectId: target.id,
        archivedSourceProjectId,
      });

      await enqueueOutbox(tx, {
        eventType: 'project.order_moved',
        aggregateType: 'project',
        aggregateId: String(target.id),
        payload: {
          eventType: 'project.order_moved',
          orderId: command.orderId,
          fromProjectId,
          toProjectId: target.id,
          actorUserId: command.currentUser.id,
          requestId,
        },
        idempotencyKey: command.idempotencyKey,
      });

      const response: MoveOrderResult = {
        orderId: command.orderId,
        projectId: target.id,
        code: target.code,
        archivedSourceProjectId,
        auditId: Number(auditId),
        requestId,
      };
      await completeIdempotency(tx, command.idempotencyKey, response);
      return response;
    });
  }

  merge(command: MergeCommand): Promise<MergeResult> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const requestId = requestIdOrFallback(command.requestId);
      const idempotency = await reconcileIdempotency<MergeResult>(tx, {
        idempotencyKey: command.idempotencyKey,
        commandName: MERGE_COMMAND,
        currentUser: command.currentUser,
        entityType: 'project',
        entityId: String(command.targetProjectId),
        requestShape: { ...command },
      });
      if (idempotency.completedResponse) {
        return idempotency.completedResponse;
      }

      const orderedIds = [command.sourceProjectId, command.targetProjectId].sort((left, right) => left - right);
      const lockedProjects = new Map<number, MoveTargetProjectRow | undefined>();
      for (const projectId of orderedIds) {
        const project = await lockProject(tx, projectId);
        lockedProjects.set(projectId, project);
      }

      if (command.sourceProjectId === command.targetProjectId) {
        throw new ApiError(422, 'PROJECT_SAME', 'Нельзя объединить проект с самим собой');
      }

      const sourceProject = lockedProjects.get(command.sourceProjectId);
      const targetProject = lockedProjects.get(command.targetProjectId);
      if (!sourceProject) {
        throw new ProjectNotFoundError(command.sourceProjectId);
      }
      if (!targetProject) {
        throw new ProjectNotFoundError(command.targetProjectId);
      }
      if (targetProject.delete_flag) {
        throw new ProjectArchivedError(command.targetProjectId);
      }

      const clientId = Number(targetProject.client_id);
      if (Number(sourceProject.client_id) !== clientId) {
        throw new ApiError(422, 'PROJECT_CLIENT_MISMATCH', 'Клиенты проектов не совпадают');
      }

      const sourceOrders = await tx.query<LockedOrderRow>(
        `
        SELECT order_id, order_name, client_id, project_id, created_by, manager_id
        FROM orders
        WHERE project_id = $1 AND delete_flag = false
        ORDER BY order_id
        FOR UPDATE
        `,
        [command.sourceProjectId],
      );
      assertOrdersUpdateScope(command.currentUser, sourceOrders.rows);

      const movedOrders = await tx.query(
        `
        UPDATE orders
        SET project_id = $1, version = version + 1, edited_by = $3, updated_at = now()
        WHERE project_id = $2 AND delete_flag = false
        `,
        [command.targetProjectId, command.sourceProjectId, command.currentUser.id],
      );
      const movedOrdersCount = movedOrders.rowCount ?? 0;

      await tx.query(
        `
        UPDATE projects
        SET delete_flag = true, version = version + 1, edited_by = $2, updated_at = now()
        WHERE project_id = $1
        `,
        [command.sourceProjectId, command.currentUser.id],
      );

      const remainingDeletedOrdersResult = await tx.query<{ c: number | string }>(
        `
        SELECT COUNT(*) AS c
        FROM orders
        WHERE project_id = $1 AND delete_flag = true
        `,
        [command.sourceProjectId],
      );
      const remainingDeletedOrders = Number(remainingDeletedOrdersResult.rows[0]?.c ?? 0);

      const auditId = await writeMergeAudit(tx, {
        currentUser: command.currentUser,
        requestId,
        sourceProjectId: command.sourceProjectId,
        targetProjectId: command.targetProjectId,
        clientId,
        movedOrdersCount,
        remainingDeletedOrders,
      });
      await writeMergedProjectArchivedAudit(tx, {
        currentUser: command.currentUser,
        requestId,
        sourceProjectId: command.sourceProjectId,
        targetProjectId: command.targetProjectId,
        clientId,
      });

      await enqueueOutbox(tx, {
        eventType: 'project.merged',
        aggregateType: 'project',
        aggregateId: String(command.targetProjectId),
        payload: {
          eventType: 'project.merged',
          sourceProjectId: command.sourceProjectId,
          targetProjectId: command.targetProjectId,
          movedOrdersCount,
          remainingDeletedOrders,
          actorUserId: command.currentUser.id,
          requestId,
        },
        idempotencyKey: command.idempotencyKey,
      });
      await enqueueOutbox(tx, {
        eventType: 'project.archived',
        aggregateType: 'project',
        aggregateId: String(command.sourceProjectId),
        payload: {
          eventType: 'project.archived',
          projectId: command.sourceProjectId,
          reason: 'merged_into',
          targetProjectId: command.targetProjectId,
          actorUserId: command.currentUser.id,
          requestId,
        },
        idempotencyKey: `${command.idempotencyKey}:archived`,
      });

      const response: MergeResult = {
        targetProjectId: command.targetProjectId,
        sourceProjectId: command.sourceProjectId,
        movedOrdersCount,
        auditId: Number(auditId),
        requestId,
      };
      await completeIdempotency(tx, command.idempotencyKey, response);
      return response;
    });
  }
}

async function setSessionUser(tx: TransactionClient, userId: string): Promise<void> {
  await tx.query('SELECT set_session_user($1)', [userId]);
}

const orderAccessPolicy = new OrderAccessPolicy();

// Move/merge mutate orders.project_id, so they must honour the same per-order
// update scope as the regular order edit path (manager/operator = 'own').
function assertOrdersUpdateScope(currentUser: CurrentUser, orders: readonly LockedOrderRow[]): void {
  for (const order of orders) {
    const allowed = orderAccessPolicy.canUpdate(currentUser, {
      orderId: Number(order.order_id),
      createdByUserId: order.created_by == null ? null : String(order.created_by),
      managerUserId: order.manager_id == null ? null : String(order.manager_id),
    });
    if (!allowed) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: ['orders.update'],
        orderId: Number(order.order_id),
      });
    }
  }
}

async function writeAudit(
  tx: TransactionClient,
  input: {
    currentUser: UpdateProjectCommand['currentUser'];
    requestId: string;
    projectId: number;
    clientId: number;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  },
): Promise<string> {
  return auditService.record(tx, {
    event: 'project.updated',
    entityType: 'project',
    entityId: String(input.projectId),
    actorUserId: input.currentUser.id,
    actorUsername: input.currentUser.username,
    actorRole: input.currentUser.role,
    requestId: input.requestId,
    source: SOURCE,
    relatedClientId: input.clientId,
    before: input.before,
    after: input.after,
    metadata: {
      projectId: input.projectId,
      action: 'project_update',
    },
    relatedEntities: [
      { entityType: 'project', entityId: input.projectId },
      { entityType: 'client', entityId: input.clientId },
    ],
  });
}

async function writeProjectArchivedAudit(
  tx: TransactionClient,
  input: {
    currentUser: CurrentUser;
    requestId: string;
    projectId: number;
    clientId: number;
  },
): Promise<string> {
  return auditService.record(tx, {
    event: 'project.archived',
    entityType: 'project',
    entityId: String(input.projectId),
    actorUserId: input.currentUser.id,
    actorUsername: input.currentUser.username,
    actorRole: input.currentUser.role,
    requestId: input.requestId,
    source: SOURCE,
    relatedClientId: input.clientId,
    before: { deleteFlag: false },
    after: { deleteFlag: true },
    metadata: {
      projectId: input.projectId,
      reason: 'emptied_by_move',
      action: 'project_archive',
    },
    relatedEntities: [
      { entityType: 'project', entityId: input.projectId },
      { entityType: 'client', entityId: input.clientId },
    ],
  });
}

async function writeMoveOrderAudit(
  tx: TransactionClient,
  input: {
    currentUser: CurrentUser;
    requestId: string;
    orderId: number;
    clientId: number;
    fromProjectId: number;
    toProjectId: number;
    archivedSourceProjectId: number | null;
  },
): Promise<string> {
  return auditService.record(tx, {
    event: 'project.order_moved',
    entityType: 'order',
    entityId: String(input.orderId),
    actorUserId: input.currentUser.id,
    actorUsername: input.currentUser.username,
    actorRole: input.currentUser.role,
    requestId: input.requestId,
    source: SOURCE,
    relatedOrderId: input.orderId,
    relatedClientId: input.clientId,
    before: { projectId: input.fromProjectId },
    after: { projectId: input.toProjectId },
    metadata: {
      fromProjectId: input.fromProjectId,
      toProjectId: input.toProjectId,
      archivedSourceProjectId: input.archivedSourceProjectId,
      action: 'project_move_order',
    },
    relatedEntities: [
      { entityType: 'project', entityId: input.fromProjectId },
      { entityType: 'project', entityId: input.toProjectId },
      { entityType: 'order', entityId: input.orderId },
      { entityType: 'client', entityId: input.clientId },
    ],
  });
}

async function lockProject(tx: TransactionClient, projectId: number): Promise<MoveTargetProjectRow | undefined> {
  const result = await tx.query<MoveTargetProjectRow>(
    `
    SELECT project_id, client_id, delete_flag, code
    FROM projects
    WHERE project_id = $1
    FOR UPDATE
    `,
    [projectId],
  );
  return result.rows[0];
}

async function writeMergeAudit(
  tx: TransactionClient,
  input: {
    currentUser: CurrentUser;
    requestId: string;
    sourceProjectId: number;
    targetProjectId: number;
    clientId: number;
    movedOrdersCount: number;
    remainingDeletedOrders: number;
  },
): Promise<string> {
  return auditService.record(tx, {
    event: 'project.merged',
    entityType: 'project',
    entityId: String(input.targetProjectId),
    actorUserId: input.currentUser.id,
    actorUsername: input.currentUser.username,
    actorRole: input.currentUser.role,
    requestId: input.requestId,
    source: SOURCE,
    relatedClientId: input.clientId,
    before: { sourceProjectId: input.sourceProjectId },
    after: { targetProjectId: input.targetProjectId },
    metadata: {
      sourceProjectId: input.sourceProjectId,
      targetProjectId: input.targetProjectId,
      movedOrdersCount: input.movedOrdersCount,
      remainingDeletedOrders: input.remainingDeletedOrders,
      action: 'project_merge',
    },
    relatedEntities: [
      { entityType: 'project', entityId: input.sourceProjectId },
      { entityType: 'project', entityId: input.targetProjectId },
      { entityType: 'client', entityId: input.clientId },
    ],
  });
}

async function writeMergedProjectArchivedAudit(
  tx: TransactionClient,
  input: {
    currentUser: CurrentUser;
    requestId: string;
    sourceProjectId: number;
    targetProjectId: number;
    clientId: number;
  },
): Promise<string> {
  return auditService.record(tx, {
    event: 'project.archived',
    entityType: 'project',
    entityId: String(input.sourceProjectId),
    actorUserId: input.currentUser.id,
    actorUsername: input.currentUser.username,
    actorRole: input.currentUser.role,
    requestId: input.requestId,
    source: SOURCE,
    relatedClientId: input.clientId,
    before: { deleteFlag: false },
    after: { deleteFlag: true },
    metadata: {
      projectId: input.sourceProjectId,
      reason: 'merged_into',
      targetProjectId: input.targetProjectId,
      action: 'project_archive',
    },
    relatedEntities: [
      { entityType: 'project', entityId: input.sourceProjectId },
      { entityType: 'client', entityId: input.clientId },
    ],
  });
}

async function enqueueOutbox(
  tx: TransactionClient,
  input: {
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
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
    [input.eventType, input.aggregateType, input.aggregateId, JSON.stringify(input.payload), input.idempotencyKey],
  );
}

async function reconcileIdempotency<T extends CommandResponse>(
  tx: TransactionClient,
  input: {
    idempotencyKey: string;
    commandName: string;
    currentUser: CurrentUser;
    entityType: string;
    entityId: string;
    requestShape: Record<string, unknown>;
  },
): Promise<{ completedResponse?: T }> {
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
    [input.idempotencyKey, input.commandName, numericUserId(input.currentUser), input.entityType, input.entityId, requestHash],
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
    throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing', {
      idempotencyKey: input.idempotencyKey,
    });
  }
  if (row.request_hash !== requestHash) {
    throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with a different request', {
      idempotencyKey: input.idempotencyKey,
    });
  }
  if (row.status === 'completed' && row.response_json) {
    return { completedResponse: parseStoredResponse(row.response_json) as T };
  }
  if (row.status === 'failed') {
    throw new ApiError(409, 'IDEMPOTENCY_FAILED', 'Idempotent command previously failed', {
      idempotencyKey: input.idempotencyKey,
    });
  }

  throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing', {
    idempotencyKey: input.idempotencyKey,
  });
}

async function completeIdempotency<T extends CommandResponse>(
  tx: TransactionClient,
  idempotencyKey: string,
  response: T,
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

function requestIdOrFallback(requestId: string | undefined): string {
  return requestId && requestId.length > 0 ? requestId : 'projects-command';
}

function mapProjectRow(row: ProjectRow): ProjectDto {
  return {
    projectId: Number(row.project_id),
    code: row.code,
    name: row.name,
    clientId: Number(row.client_id),
    clientName: row.client_name ?? undefined,
    notes: row.notes ?? null,
    version: Number(row.version),
    ordersCount: row.orders_count === undefined || row.orders_count === null ? undefined : Number(row.orders_count),
    totalFinalAmount: row.total_final_amount ?? undefined,
    totalPaidAmount: row.total_paid_amount ?? undefined,
  };
}

function mapProjectOrderRow(row: ProjectOrderRowDb): ProjectOrderRow {
  return {
    orderId: Number(row.order_id),
    orderName: row.order_name,
    fullNumber: row.order_full_number,
    finalAmount: row.final_amount ?? null,
    paidAmount: row.paid_amount ?? null,
    orderStatusName: row.order_status_name ?? null,
    deleteFlag: row.delete_flag,
  };
}

function isUniqueViolation(error: unknown): error is { code: string } {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === '23505');
}

function hashRequest(value: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(toStableValue(value));
}

function toStableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => toStableValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((accumulator, key) => {
        const next = (value as Record<string, unknown>)[key];
        if (next !== undefined) {
          accumulator[key] = toStableValue(next);
        }
        return accumulator;
      }, {});
  }
  return value;
}

function numericUserId(currentUser: CurrentUser): number | null {
  const parsed = Number(currentUser.id);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseStoredResponse(value: CommandResponse | string): CommandResponse {
  if (typeof value === 'string') {
    return JSON.parse(value) as CommandResponse;
  }
  return value;
}
