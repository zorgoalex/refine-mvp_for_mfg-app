import { createHash } from 'crypto';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import { computeDiff } from '../../../common/audit/audit-diff';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { OrderAccessPolicy } from '../../../permissions/policies/order-access.policy';
import { PermissionsService } from '../../../permissions/permissions.service';
import { evaluateStatusAutomation } from '../../status-automation/application/status-automation-runtime';
import { calculateOrderTotals } from '../domain/order-calculations';
import type { OrderDto } from '../dto/order.dto';
import type { CalculatedOrderDetailDto, NormalizedSaveOrderPaymentDto, OrderTotalsDto } from '../dto/save-order.dto';
import { OrderNameDuplicateError, OrderNotFoundError, OrderVersionConflictError } from '../errors/order.errors';
import { PgOrderReadRepository } from '../adapters/pg-order-read-repository';
import type { OrderDeadlineSyncPort, OrderPermissionCheckerPort } from './order-transaction.types';

const SOURCE = 'backend-orders-command';
const IDEMPOTENCY_STALE_MS = 10 * 60 * 1000;

export type OrderDetailTransferTarget =
  | { mode: 'existing'; orderId: number; version: number }
  | { mode: 'new'; orderName: string; projectId?: number | null };

export interface TransferOrderDetailsDto {
  detailIds: number[];
  target: OrderDetailTransferTarget;
  note?: string | null;
}

export interface TransferOrderDetailsCommand {
  currentUser: CurrentUser;
  sourceOrderId: number;
  sourceVersion: number;
  idempotencyKey: string;
  dto: TransferOrderDetailsDto;
  requestId?: string;
}

export interface OrderTransferTargetDto {
  orderId: number;
  orderName: string;
  clientId: number;
  clientName: string | null;
  orderDate: string;
  projectId: number;
  projectCode: string | null;
  projectName: string | null;
  orderStatusId: number;
  orderStatusName: string | null;
  productionStatusId: number | null;
  productionStatusName: string | null;
  version: number;
}

export interface OrderTransferTargetsResponseDto {
  data: OrderTransferTargetDto[];
  requestId: string;
}

export interface ListOrderTransferTargetsCommand {
  currentUser: CurrentUser;
  sourceOrderId: number;
  search?: string;
  limit: number;
  requestId?: string;
}

export interface TransferOrderDetailsResponseDto {
  sourceOrder: OrderDto;
  targetOrder: OrderDto;
  movedDetailIds: number[];
  sourceVersion: number;
  targetVersion: number;
  targetCreated: boolean;
  auditId: string;
  requestId: string;
}

export interface OrderDetailTransferServicePorts {
  database: DatabaseService;
  sheetOrdersReads: boolean;
  permissions?: OrderPermissionCheckerPort;
  deadlineSync?: OrderDeadlineSyncPort;
}

interface IdempotencyRow {
  idempotency_key: string;
  request_hash: string;
  response_json: TransferOrderDetailsResponseDto | string | null;
  status: string;
  created_at: string | Date | null;
}

interface LockedOrderRow {
  order_id: string | number;
  order_name: string;
  client_id: string | number;
  project_id: string | number;
  order_date: string | Date;
  priority: string | number | null;
  manager_id: string | number | null;
  order_status_id: string | number;
  payment_status_id: string | number | null;
  production_status_id: string | number | null;
  production_status_from_details_enabled: boolean | string | number | null;
  planned_completion_date: string | Date | null;
  discount: string | number | null;
  surcharge: string | number | null;
  version: string | number;
  created_by: string | number | null;
}

interface LockedProjectRow {
  project_id: string | number;
  client_id: string | number | null;
  code: string | null;
  delete_flag: boolean | null;
}

interface LockedDetailRow {
  detail_id: string | number;
  order_id: string | number;
  detail_number: string | number | null;
  height: string | number;
  width: string | number;
  quantity: string | number;
  detail_cost: string | number | null;
}

interface TransferAuditDetail {
  detailId: number;
  sourceDetailNumber: number | null;
  targetDetailNumber: number | null;
  height: number;
  width: number;
  quantity: number;
}

interface PaymentRow {
  amount: string | number;
  payment_date: string | Date;
}

interface SnapshotRow {
  snapshot: Record<string, unknown> | string | null;
}

interface VersionRow {
  version: string | number;
}

interface TargetSearchRow {
  order_id: string | number;
  order_name: string;
  client_id: string | number;
  client_name: string | null;
  order_date: string | Date;
  project_id: string | number;
  project_code: string | null;
  project_name: string | null;
  order_status_id: string | number;
  order_status_name: string | null;
  production_status_id: string | number | null;
  production_status_name: string | null;
  version: string | number;
  created_by: string | number | null;
  manager_id: string | number | null;
}

export class OrderDetailTransferService {
  private readonly permissions: OrderPermissionCheckerPort;
  private readonly orderAccessPolicy = new OrderAccessPolicy();

  constructor(private readonly ports: OrderDetailTransferServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async listTransferTargets(
    command: ListOrderTransferTargetsCommand,
  ): Promise<OrderTransferTargetsResponseDto> {
    this.requirePermission(command.currentUser, 'orders.view');
    this.requirePermission(command.currentUser, 'orders.update');

    const source = await this.ports.database.query<TargetSearchRow>(
      `
      SELECT o.order_id, o.order_name, o.client_id, c.client_name, o.order_date,
             o.project_id, p.code AS project_code, p.name AS project_name,
             o.order_status_id, os.order_status_name,
             o.production_status_id, ps.production_status_name,
             o.version, o.created_by, o.manager_id
      FROM orders o
      LEFT JOIN clients c ON c.client_id = o.client_id
      LEFT JOIN projects p ON p.project_id = o.project_id
      LEFT JOIN order_statuses os ON os.order_status_id = o.order_status_id
      LEFT JOIN production_statuses ps ON ps.production_status_id = o.production_status_id
      WHERE o.order_id = $1 AND o.delete_flag = false
      `,
      [command.sourceOrderId],
    );
    const sourceRow = source.rows[0];
    if (!sourceRow) {
      throw new OrderNotFoundError(command.sourceOrderId);
    }
    if (!this.canUpdateOrder(command.currentUser, sourceRow)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: ['orders.update'],
      });
    }

    const clientId = toNumber(sourceRow.client_id);
    const search = command.search?.trim() ?? '';
    const queryLimit = Math.min(Math.max(command.limit * 5, command.limit), 100);
    const rows = await this.ports.database.query<TargetSearchRow>(
      `
      SELECT o.order_id, o.order_name, o.client_id, c.client_name, o.order_date,
             o.project_id, p.code AS project_code, p.name AS project_name,
             o.order_status_id, os.order_status_name,
             o.production_status_id, ps.production_status_name,
             o.version, o.created_by, o.manager_id
      FROM orders o
      LEFT JOIN clients c ON c.client_id = o.client_id
      LEFT JOIN projects p ON p.project_id = o.project_id
      LEFT JOIN order_statuses os ON os.order_status_id = o.order_status_id
      LEFT JOIN production_statuses ps ON ps.production_status_id = o.production_status_id
      WHERE o.delete_flag = false
        AND o.order_id <> $1
        AND o.order_date >= (CURRENT_DATE - INTERVAL '1 month')
        AND (
          $2::text = ''
          OR o.order_name ILIKE '%' || $2 || '%'
          OR c.client_name::text ILIKE '%' || $2 || '%'
          OR p.code ILIKE '%' || $2 || '%'
          OR p.name ILIKE '%' || $2 || '%'
          OR os.order_status_name::text ILIKE '%' || $2 || '%'
        )
      ORDER BY
        CASE WHEN o.client_id = $3 THEN 0 ELSE 1 END,
        o.order_date DESC NULLS LAST,
        o.updated_at DESC,
        o.order_id DESC
      LIMIT $4
      `,
      [command.sourceOrderId, search, clientId, queryLimit],
    );

    const data = rows.rows
      .filter((row) => this.canViewOrder(command.currentUser, row))
      .filter((row) => this.canUpdateOrder(command.currentUser, row))
      .slice(0, command.limit)
      .map(mapTransferTarget);

    return { data, requestId: command.requestId ?? 'orders-transfer-targets' };
  }

  async transfer(command: TransferOrderDetailsCommand): Promise<TransferOrderDetailsResponseDto> {
    const requestId = command.requestId ?? 'orders-detail-transfer';
    this.validateTransferCommand(command);
    this.requirePermission(command.currentUser, 'orders.update');
    this.requirePermission(command.currentUser, 'orders.view_financials');
    if (command.dto.target.mode === 'new') {
      this.requirePermission(command.currentUser, 'orders.create');
    }

    const deadlineJobs: Array<{ orderId: number; eventType: 'ORDER_CREATED' | 'ORDER_UPDATED' }> = [];
    const response = await this.ports.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const idempotency = await reconcileTransferIdempotency(tx, command);
      if (idempotency.completedResponse) {
        return idempotency.completedResponse;
      }

      if (command.dto.target.mode === 'new') {
        await lockOrderName(tx, command.dto.target.orderName);
        await assertOrderNameAvailable(tx, command.dto.target.orderName);
      }

      const preSource = await readLiveOrderHeader(tx, command.sourceOrderId);
      if (!preSource) {
        throw new OrderNotFoundError(command.sourceOrderId);
      }
      const targetProjectId =
        command.dto.target.mode === 'new'
          ? command.dto.target.projectId ?? toNumber(preSource.project_id)
          : null;
      const projectIds = new Set<number>([toNumber(preSource.project_id)]);
      if (targetProjectId !== null) {
        projectIds.add(targetProjectId);
      }
      if (command.dto.target.mode === 'existing') {
        const preTarget = await readLiveOrderHeader(tx, command.dto.target.orderId);
        if (!preTarget) {
          throw new OrderNotFoundError(command.dto.target.orderId);
        }
        projectIds.add(toNumber(preTarget.project_id));
      }
      const lockedProjects = await lockProjects(tx, [...projectIds].sort((a, b) => a - b));
      const ordersToLock =
        command.dto.target.mode === 'existing'
          ? [command.sourceOrderId, command.dto.target.orderId].sort((a, b) => a - b)
          : [command.sourceOrderId];
      const lockedOrders = await lockOrders(tx, ordersToLock);
      const source = lockedOrders.get(command.sourceOrderId);
      if (!source) {
        throw new OrderNotFoundError(command.sourceOrderId);
      }
      if (!this.canUpdateOrder(command.currentUser, source)) {
        throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
          requiredPermissions: ['orders.update'],
        });
      }
      const sourceVersion = toNumber(source.version);
      if (sourceVersion !== command.sourceVersion) {
        throw new OrderVersionConflictError(sourceVersion, command.sourceVersion);
      }

      let target: LockedOrderRow | null = null;
      let targetOrderId: number;
      let targetCreated = false;
      if (command.dto.target.mode === 'existing') {
        target = lockedOrders.get(command.dto.target.orderId) ?? null;
        if (!target) {
          throw new OrderNotFoundError(command.dto.target.orderId);
        }
        targetOrderId = toNumber(target.order_id);
        if (targetOrderId === command.sourceOrderId) {
          throw new ApiError(422, 'ORDER_DETAIL_TRANSFER_SAME_ORDER', 'Нельзя перенести детали в тот же заказ', {
            orderId: targetOrderId,
          });
        }
        if (!this.canUpdateOrder(command.currentUser, target)) {
          throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
            requiredPermissions: ['orders.update'],
          });
        }
        const targetVersion = toNumber(target.version);
        if (targetVersion !== command.dto.target.version) {
          throw new OrderVersionConflictError(targetVersion, command.dto.target.version);
        }
        if (toNumber(target.client_id) !== toNumber(source.client_id)) {
          throw new ApiError(422, 'ORDER_DETAIL_TRANSFER_CLIENT_MISMATCH', 'Целевой заказ принадлежит другому клиенту', {
            sourceOrderId: command.sourceOrderId,
            targetOrderId,
          });
        }
      } else {
        const project = lockedProjects.get(targetProjectId!);
        if (!project || project.delete_flag === true) {
          throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Проект не найден', { projectId: targetProjectId });
        }
        if (toNullableNumber(project.client_id) !== toNumber(source.client_id)) {
          throw new ApiError(422, 'ORDER_DETAIL_TRANSFER_CLIENT_MISMATCH', 'Проект принадлежит другому клиенту', {
            projectId: targetProjectId,
            clientId: toNumber(source.client_id),
          });
        }
        targetCreated = true;
        targetOrderId = -1;
      }

      const detailOrderIds = command.dto.target.mode === 'existing'
        ? [command.sourceOrderId, targetOrderId]
        : [command.sourceOrderId];
      const lockedDetails = await lockLiveDetails(tx, detailOrderIds);
      const sourceDetails = lockedDetails.filter((detail) => toNumber(detail.order_id) === command.sourceOrderId);
      const targetExistingDetails = lockedDetails.filter((detail) => toNumber(detail.order_id) === targetOrderId);
      const selectedSet = new Set(command.dto.detailIds);
      const movedDetails = sourceDetails.filter((detail) => selectedSet.has(toNumber(detail.detail_id)));
      if (movedDetails.length !== selectedSet.size) {
        throw new ApiError(404, 'ORDER_DETAIL_NOT_FOUND', 'Часть выбранных деталей не найдена в исходном заказе', {
          sourceOrderId: command.sourceOrderId,
          detailIds: command.dto.detailIds,
        });
      }
      const remainingSourceDetails = sourceDetails.filter((detail) => !selectedSet.has(toNumber(detail.detail_id)));
      if (remainingSourceDetails.length === 0) {
        throw new ApiError(409, 'ORDER_DETAIL_TRANSFER_SOURCE_EMPTY', 'В исходном заказе должна остаться хотя бы одна деталь', {
          sourceOrderId: command.sourceOrderId,
        });
      }
      const movedDetailsInSourceOrder = [...movedDetails].sort(compareDetailOrder);
      const movedDetailIds = movedDetailsInSourceOrder.map((detail) => toNumber(detail.detail_id));

      const sourceBefore = await loadOrderSnapshot(tx, command.sourceOrderId);
      const targetBefore = command.dto.target.mode === 'existing'
        ? await loadOrderSnapshot(tx, targetOrderId)
        : null;

      if (command.dto.target.mode === 'new') {
        const targetTotals = calculateTotalsForRows(movedDetails, [], { discount: 0, surcharge: 0, paymentStatusId: null });
        targetOrderId = await createSplitTargetOrder(tx, {
          source,
          orderName: command.dto.target.orderName,
          projectId: targetProjectId!,
          currentUser: command.currentUser,
          totals: targetTotals,
          note: command.dto.note,
        });
      }
      const sourceRenumbering = buildRenumbering(remainingSourceDetails);
      const targetRenumbering = buildRenumbering([...targetExistingDetails, ...movedDetailsInSourceOrder]);
      const targetDetailNumbers = new Map(targetRenumbering.map((row) => [row.detailId, row.detailNumber]));
      const movedDetailAuditItems = buildTransferAuditDetails(movedDetailsInSourceOrder, targetDetailNumbers);
      const sourceOrderName = source.order_name;
      const targetOrderName =
        command.dto.target.mode === 'existing'
          ? target?.order_name ?? String(targetOrderId)
          : command.dto.target.orderName.trim();

      await assertBazisTransferDoesNotConflict(tx, {
        sourceOrderId: command.sourceOrderId,
        targetOrderId,
        movedDetailIds,
      });
      await moveDetails(tx, {
        targetOrderId,
        movedDetailIds,
        actorUserId: actorUserIdOf(command.currentUser),
      });
      await renumberDetails(tx, [...sourceRenumbering, ...targetRenumbering]);
      await updateDenormalizedReferences(tx, {
        sourceOrderId: command.sourceOrderId,
        targetOrderId,
        movedDetailIds,
      });

      if (toBoolean(source.production_status_from_details_enabled)) {
        await recalcOrderProductionStatus(tx, command.sourceOrderId);
      }
      if (command.dto.target.mode === 'existing') {
        if (target && toBoolean(target.production_status_from_details_enabled)) {
          await recalcOrderProductionStatus(tx, targetOrderId);
        }
      } else {
        await recalcOrderProductionStatus(tx, targetOrderId);
      }

      const sourceTotals = await calculateTotalsFromDb(tx, command.sourceOrderId, source);
      const persistedSourceVersion = await updateOrderTotals(tx, {
          orderId: command.sourceOrderId,
          totals: sourceTotals,
          actorUserId: actorUserIdOf(command.currentUser),
          bumpVersion: true,
        });
      let persistedTargetVersion: number;
      if (command.dto.target.mode === 'existing') {
        const targetTotals = await calculateTotalsFromDb(tx, targetOrderId, target!);
        persistedTargetVersion = await updateOrderTotals(tx, {
          orderId: targetOrderId,
          totals: targetTotals,
          actorUserId: actorUserIdOf(command.currentUser),
          bumpVersion: true,
        });
      } else {
        persistedTargetVersion = await readOrderVersion(tx, targetOrderId);
      }

      const sourceAfter = await loadOrderSnapshot(tx, command.sourceOrderId);
      let targetAfter = await loadOrderSnapshot(tx, targetOrderId);
      let createAuditId: string | null = null;
      if (targetCreated) {
        createAuditId = await auditService.record(tx, {
          event: 'orders.create',
          entityType: 'order',
          entityId: targetOrderId,
          actorUserId: command.currentUser.id,
          actorUsername: command.currentUser.username,
          actorRole: command.currentUser.role,
          requestId,
          source: SOURCE,
          relatedOrderId: command.sourceOrderId,
          relatedClientId: toNumber(source.client_id),
          before: null,
          after: targetAfter,
          diff: computeDiff(null, targetAfter),
          metadata: {
            commandName: 'orders.create',
            source: 'order_detail_transfer',
            sourceOrderId: command.sourceOrderId,
            sourceOrderName,
            targetOrderId,
            targetOrderName,
            splitFromOrderId: command.sourceOrderId,
            movedDetails: movedDetailAuditItems,
            movedDetailIds,
            movedCount: movedDetailIds.length,
          },
          relatedEntities: [
            { entityType: 'order', entityId: targetOrderId },
            { entityType: 'order', entityId: command.sourceOrderId },
            ...movedDetailIds.map((detailId) => ({ entityType: 'order_detail', entityId: detailId })),
          ],
        });
        await evaluateStatusAutomation(tx, {
          eventType: 'order.created',
          origin: 'user',
          orderId: targetOrderId,
          actor: command.currentUser,
          requestId,
          sourceIdempotencyKey: command.idempotencyKey,
        });
        persistedTargetVersion = await readOrderVersion(tx, targetOrderId);
        targetAfter = await loadOrderSnapshot(tx, targetOrderId);
      }

      const transferAuditId = await auditService.record(tx, {
        event: 'orders.detail_transfer',
        entityType: 'order',
        entityId: command.sourceOrderId,
        actorUserId: command.currentUser.id,
        actorUsername: command.currentUser.username,
        actorRole: command.currentUser.role,
        requestId,
        source: SOURCE,
        relatedOrderId: targetOrderId,
        relatedClientId: toNumber(source.client_id),
        before: { source: sourceBefore, target: targetBefore },
        after: { source: sourceAfter, target: targetAfter },
        diff: computeDiff({ source: sourceBefore, target: targetBefore }, { source: sourceAfter, target: targetAfter }),
        metadata: {
          commandName: 'orders.detail_transfer',
          sourceOrderId: command.sourceOrderId,
          sourceOrderName,
          targetOrderId,
          targetOrderName,
          targetMode: command.dto.target.mode,
          targetCreated,
          createAuditId,
          movedDetails: movedDetailAuditItems,
          movedDetailIds,
          movedCount: movedDetailIds.length,
          note: command.dto.note ?? null,
          sourceVersion: persistedSourceVersion,
          targetVersion: persistedTargetVersion,
        },
        relatedEntities: [
          { entityType: 'order', entityId: command.sourceOrderId },
          { entityType: 'order', entityId: targetOrderId },
          ...movedDetailIds.map((detailId) => ({ entityType: 'order_detail', entityId: detailId })),
        ],
      });
      await enqueueTransferOutbox(tx, {
        idempotencyKey: `${command.idempotencyKey}:details_transferred`,
        requestId,
        sourceOrderId: command.sourceOrderId,
        targetOrderId,
        targetCreated,
        clientId: toNumber(source.client_id),
        movedDetailIds,
        sourceVersion: persistedSourceVersion,
        targetVersion: persistedTargetVersion,
        actorUserId: command.currentUser.id,
      });

      const reader = new PgOrderReadRepository(tx, this.ports.sheetOrdersReads);
      const sourceOrder = await readOrderOrThrow(reader, command.sourceOrderId);
      const targetOrder = await readOrderOrThrow(reader, targetOrderId);
      const completed: TransferOrderDetailsResponseDto = {
        sourceOrder,
        targetOrder,
        movedDetailIds,
        sourceVersion: sourceOrder.version,
        targetVersion: targetOrder.version,
        targetCreated,
        auditId: transferAuditId,
        requestId,
      };
      await completeTransferIdempotency(tx, command.idempotencyKey, completed);
      deadlineJobs.push({ orderId: command.sourceOrderId, eventType: 'ORDER_UPDATED' });
      if (targetCreated) {
        deadlineJobs.push({ orderId: targetOrderId, eventType: 'ORDER_CREATED' });
      } else {
        deadlineJobs.push({ orderId: targetOrderId, eventType: 'ORDER_UPDATED' });
      }
      return completed;
    });

    for (const job of deadlineJobs) {
      await this.ports.deadlineSync?.syncOrderDeadlinesAfterSave({
        orderId: job.orderId,
        currentUser: command.currentUser,
        eventType: job.eventType,
        requestId,
      });
    }

    return response;
  }

  private validateTransferCommand(command: TransferOrderDetailsCommand): void {
    const ids = command.dto.detailIds;
    if (ids.length === 0 || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
      throw new ApiError(422, 'INVALID_ORDER_DETAIL_TRANSFER_PAYLOAD', 'Некорректный список деталей', {
        field: 'detailIds',
      });
    }
    if (new Set(ids).size !== ids.length) {
      throw new ApiError(422, 'INVALID_ORDER_DETAIL_TRANSFER_PAYLOAD', 'Список деталей содержит дубли', {
        field: 'detailIds',
      });
    }
    const target = command.dto.target;
    if (target.mode === 'existing') {
      if (!Number.isInteger(target.orderId) || target.orderId <= 0 || !Number.isInteger(target.version) || target.version < 0) {
        throw new ApiError(422, 'INVALID_ORDER_DETAIL_TRANSFER_PAYLOAD', 'Некорректный целевой заказ', {
          field: 'target',
        });
      }
    } else if (target.mode === 'new') {
      if (target.orderName.trim().length === 0 || target.orderName.trim().length > 200) {
        throw new ApiError(422, 'INVALID_ORDER_DETAIL_TRANSFER_PAYLOAD', 'Некорректное имя нового заказа', {
          field: 'target.orderName',
        });
      }
      if (target.projectId !== undefined && target.projectId !== null && (!Number.isInteger(target.projectId) || target.projectId <= 0)) {
        throw new ApiError(422, 'INVALID_ORDER_DETAIL_TRANSFER_PAYLOAD', 'Некорректный проект нового заказа', {
          field: 'target.projectId',
        });
      }
    } else {
      throw new ApiError(422, 'INVALID_ORDER_DETAIL_TRANSFER_PAYLOAD', 'Некорректная цель переноса', {
        field: 'target.mode',
      });
    }
  }

  private requirePermission(currentUser: CurrentUser, permission: 'orders.view' | 'orders.update' | 'orders.create' | 'orders.view_financials'): void {
    if (!this.permissions.canUser(currentUser, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
      });
    }
  }

  private canViewOrder(currentUser: CurrentUser, order: { order_id: string | number; created_by: string | number | null; manager_id: string | number | null }): boolean {
    return this.orderAccessPolicy.canView(currentUser, {
      orderId: toNumber(order.order_id),
      createdByUserId: toNullableString(order.created_by),
      managerUserId: toNullableString(order.manager_id),
    });
  }

  private canUpdateOrder(currentUser: CurrentUser, order: { order_id: string | number; created_by: string | number | null; manager_id: string | number | null }): boolean {
    return this.orderAccessPolicy.canUpdate(currentUser, {
      orderId: toNumber(order.order_id),
      createdByUserId: toNullableString(order.created_by),
      managerUserId: toNullableString(order.manager_id),
    });
  }
}

async function setSessionUser(tx: TransactionClient, userId: string): Promise<void> {
  await tx.query('SELECT set_session_user($1)', [userId]);
}

async function readLiveOrderHeader(tx: TransactionClient, orderId: number): Promise<LockedOrderRow | null> {
  const result = await tx.query<LockedOrderRow>(
    `
    SELECT order_id, order_name, client_id, project_id, order_date, priority, manager_id,
           order_status_id, payment_status_id, production_status_id,
           production_status_from_details_enabled, planned_completion_date,
           discount, surcharge, version, created_by
    FROM orders
    WHERE order_id = $1 AND delete_flag = false
    `,
    [orderId],
  );
  return result.rows[0] ?? null;
}

async function lockOrders(tx: TransactionClient, orderIds: readonly number[]): Promise<Map<number, LockedOrderRow>> {
  const result = await tx.query<LockedOrderRow>(
    `
    SELECT order_id, order_name, client_id, project_id, order_date, priority, manager_id,
           order_status_id, payment_status_id, production_status_id,
           production_status_from_details_enabled, planned_completion_date,
           discount, surcharge, version, created_by
    FROM orders
    WHERE order_id = ANY($1::bigint[]) AND delete_flag = false
    ORDER BY order_id
    FOR UPDATE
    `,
    [[...orderIds]],
  );
  return new Map(result.rows.map((row) => [toNumber(row.order_id), row]));
}

async function lockProjects(tx: TransactionClient, projectIds: readonly number[]): Promise<Map<number, LockedProjectRow>> {
  if (projectIds.length === 0) {
    return new Map();
  }
  const result = await tx.query<LockedProjectRow>(
    `
    SELECT project_id, client_id, code, delete_flag
    FROM projects
    WHERE project_id = ANY($1::bigint[])
    ORDER BY project_id
    FOR UPDATE
    `,
    [[...projectIds]],
  );
  return new Map(result.rows.map((row) => [toNumber(row.project_id), row]));
}

async function lockLiveDetails(tx: TransactionClient, orderIds: readonly number[]): Promise<LockedDetailRow[]> {
  const result = await tx.query<LockedDetailRow>(
    `
    SELECT detail_id, order_id, detail_number, height, width, quantity, detail_cost
    FROM order_details
    WHERE order_id = ANY($1::bigint[]) AND COALESCE(delete_flag, false) = false
    ORDER BY detail_id
    FOR UPDATE
    `,
    [[...orderIds]],
  );
  return result.rows;
}

async function lockOrderName(tx: TransactionClient, orderName: string): Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('order_name:' || $1, 0))`, [
    orderName.trim().toLowerCase(),
  ]);
}

async function assertOrderNameAvailable(tx: TransactionClient, orderName: string): Promise<void> {
  const normalized = orderName.trim().toLowerCase();
  const duplicate = await tx.query<{ order_id: string | number }>(
    `
    SELECT order_id
    FROM orders
    WHERE lower(trim(order_name)) = $1
      AND delete_flag = false
    ORDER BY order_id
    LIMIT 1
    `,
    [normalized],
  );
  const row = duplicate.rows[0];
  if (!row) {
    return;
  }
  const suggestion = await tx.query<{ next: string | null }>(
    `
    SELECT (COALESCE(MAX(order_name::bigint), 0) + 1)::text AS next
    FROM orders
    WHERE order_name ~ '^\\d{1,15}$'
      AND delete_flag = false
      AND order_date >= DATE '2025-12-01'
    `,
  );
  throw new OrderNameDuplicateError({
    existingOrderId: toNumber(row.order_id),
    orderName: orderName.trim(),
    suggestedOrderName: suggestion.rows[0]?.next ?? null,
  });
}

async function createSplitTargetOrder(
  tx: TransactionClient,
  input: {
    source: LockedOrderRow;
    orderName: string;
    projectId: number;
    currentUser: CurrentUser;
    totals: OrderTotalsDto;
    note?: string | null;
  },
): Promise<number> {
  const result = await tx.query<{ order_id: string | number }>(
    `
    INSERT INTO orders (
      order_name, client_id, order_date, priority, manager_id,
      order_status_id, payment_status_id, production_status_id,
      production_status_from_details_enabled,
      planned_completion_date, completion_date, issue_date, payment_date,
      discount, surcharge, total_amount, final_amount, paid_amount, parts_count, total_area,
      link_cutting_file, link_cutting_image_file, link_cad_file, link_pdf_file,
      notes, material_id, milling_type_id, edge_type_id, film_id, ref_key_1c,
      sheet_material_type_id, project_id, version
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8,
      $9,
      $10, NULL, NULL, $11,
      $12, $13, $14, $15, $16, $17, $18,
      NULL, NULL, NULL, NULL,
      $19, NULL, NULL, NULL, NULL, NULL,
      NULL, $20, 1
    )
    RETURNING order_id
    `,
    [
      input.orderName.trim(),
      toNumber(input.source.client_id),
      dateOnly(input.source.order_date),
      toNullableNumber(input.source.priority) ?? 0,
      toNullableNumber(input.source.manager_id) ?? actorUserIdOf(input.currentUser),
      toNumber(input.source.order_status_id),
      input.totals.paymentStatusId,
      toBoolean(input.source.production_status_from_details_enabled)
        ? null
        : toNullableNumber(input.source.production_status_id),
      toBoolean(input.source.production_status_from_details_enabled),
      dateOnlyOrNull(input.source.planned_completion_date),
      input.totals.paymentDate,
      input.totals.discount,
      input.totals.surcharge,
      input.totals.totalAmount,
      input.totals.finalAmount,
      input.totals.paidAmount,
      input.totals.partsCount,
      input.totals.totalArea,
      input.note?.trim() ? input.note.trim() : `Создан переносом из заказа ${input.source.order_name}`,
      input.projectId,
    ],
  );
  return toNumber(result.rows[0].order_id);
}

async function assertBazisTransferDoesNotConflict(
  tx: TransactionClient,
  input: { sourceOrderId: number; targetOrderId: number; movedDetailIds: readonly number[] },
): Promise<void> {
  const conflicts = await tx.query<{ node_id: string | number }>(
    `
    SELECT source_map.node_id
    FROM bazis_node_order_detail_map source_map
    JOIN bazis_node_order_detail_map target_map
      ON target_map.node_id = source_map.node_id
     AND target_map.order_id = $2
    WHERE source_map.order_id = $1
      AND source_map.order_detail_id = ANY($3::bigint[])
    LIMIT 1
    `,
    [input.sourceOrderId, input.targetOrderId, [...input.movedDetailIds]],
  );
  if (conflicts.rows[0]) {
    throw new ApiError(409, 'ORDER_DETAIL_TRANSFER_BAZIS_CONFLICT', 'Перенос конфликтует с привязками Bazis', {
      sourceOrderId: input.sourceOrderId,
      targetOrderId: input.targetOrderId,
      nodeId: toNumber(conflicts.rows[0].node_id),
    });
  }
}

async function moveDetails(
  tx: TransactionClient,
  input: { targetOrderId: number; movedDetailIds: readonly number[]; actorUserId: number | null },
): Promise<void> {
  await tx.query(
    `
    UPDATE order_details
    SET order_id = $1,
        edited_by = $3,
        updated_at = now()
    WHERE detail_id = ANY($2::bigint[])
    `,
    [input.targetOrderId, [...input.movedDetailIds], input.actorUserId],
  );
}

function buildRenumbering(details: readonly LockedDetailRow[]): Array<{ detailId: number; detailNumber: number }> {
  return [...details].sort(compareDetailOrder).map((detail, index) => ({
    detailId: toNumber(detail.detail_id),
    detailNumber: index + 1,
  }));
}

async function renumberDetails(
  tx: TransactionClient,
  renumbering: Array<{ detailId: number; detailNumber: number }>,
): Promise<void> {
  if (renumbering.length === 0) {
    return;
  }
  await tx.query(
    `
    UPDATE order_details AS od
    SET detail_number = v.detail_number,
        updated_at = now()
    FROM unnest($1::bigint[], $2::integer[]) AS v(detail_id, detail_number)
    WHERE od.detail_id = v.detail_id
    `,
    [renumbering.map((row) => row.detailId), renumbering.map((row) => row.detailNumber)],
  );
}

async function updateDenormalizedReferences(
  tx: TransactionClient,
  input: { sourceOrderId: number; targetOrderId: number; movedDetailIds: readonly number[] },
): Promise<void> {
  const detailIds = [...input.movedDetailIds];
  await tx.query(
    `
    WITH affected_jobs AS (
      SELECT DISTINCT cut_job_id
      FROM cut_job_item
      WHERE order_detail_id = ANY($1::bigint[])
        AND is_active = true
    )
    UPDATE cut_job
    SET last_calc_basis = NULL,
        version = version + 1,
        pdf_prewarm_state = 'pending',
        updated_at = now()
    WHERE cut_job_id IN (SELECT cut_job_id FROM affected_jobs)
      AND status = 'ready'
      AND last_calc_basis IS NOT NULL
    `,
    [detailIds],
  );
  await tx.query(
    `
    UPDATE cut_job_item
    SET order_id = $2,
        updated_at = now()
    WHERE order_detail_id = ANY($1::bigint[])
      AND is_active = true
    `,
    [detailIds, input.targetOrderId],
  );
  await tx.query(
    `
    UPDATE order_label_detail_data
    SET order_id = $2,
        updated_at = now()
    WHERE order_id = $1
      AND detail_id = ANY($3::bigint[])
    `,
    [input.sourceOrderId, input.targetOrderId, detailIds],
  );
  await tx.query(
    `
    UPDATE bazis_node_order_detail_map
    SET order_id = $2
    WHERE order_id = $1
      AND order_detail_id = ANY($3::bigint[])
    `,
    [input.sourceOrderId, input.targetOrderId, detailIds],
  );
  await tx.query(
    `
    UPDATE cnc_telegram_packet_items
    SET match_order_id = $2
    WHERE match_order_id = $1
      AND match_detail_id = ANY($3::bigint[])
    `,
    [input.sourceOrderId, input.targetOrderId, detailIds],
  );
}

async function recalcOrderProductionStatus(tx: TransactionClient, orderId: number): Promise<void> {
  await tx.query('SELECT recalc_order_production_status($1)', [orderId]);
}

async function calculateTotalsFromDb(
  tx: TransactionClient,
  orderId: number,
  order: Pick<LockedOrderRow, 'discount' | 'surcharge' | 'payment_status_id'>,
): Promise<OrderTotalsDto> {
  const details = await tx.query<LockedDetailRow>(
    `
    SELECT detail_id, order_id, detail_number, height, width, quantity, detail_cost
    FROM order_details
    WHERE order_id = $1 AND COALESCE(delete_flag, false) = false
    ORDER BY detail_number, detail_id
    `,
    [orderId],
  );
  const payments = await tx.query<PaymentRow>(
    `
    SELECT amount, payment_date
    FROM payments
    WHERE order_id = $1 AND COALESCE(delete_flag, false) = false
    ORDER BY payment_id
    `,
    [orderId],
  );
  return calculateTotalsForRows(details.rows, payments.rows, {
    discount: toNullableNumber(order.discount) ?? 0,
    surcharge: toNullableNumber(order.surcharge) ?? 0,
    paymentStatusId: toNullableNumber(order.payment_status_id),
  });
}

function calculateTotalsForRows(
  details: readonly LockedDetailRow[],
  payments: readonly PaymentRow[],
  header: { discount: number; surcharge: number; paymentStatusId: number | null },
): OrderTotalsDto {
  return calculateOrderTotals({
    header,
    details: details.map((detail) => ({
      height: Number(detail.height),
      width: Number(detail.width),
      quantity: Number(detail.quantity),
      detailCost: toNullableNumber(detail.detail_cost) ?? 0,
    })) as CalculatedOrderDetailDto[],
    payments: payments.map((payment) => ({
      amount: Number(payment.amount),
      paymentDate: dateOnly(payment.payment_date),
    })) as NormalizedSaveOrderPaymentDto[],
  });
}

async function updateOrderTotals(
  tx: TransactionClient,
  input: { orderId: number; totals: OrderTotalsDto; actorUserId: number | null; bumpVersion: boolean },
): Promise<number> {
  const result = await tx.query<VersionRow>(
    `
    UPDATE orders
    SET payment_status_id = $2,
        payment_date = $3,
        total_amount = $4,
        final_amount = $5,
        paid_amount = $6,
        parts_count = $7,
        total_area = $8,
        edited_by = $9,
        updated_at = now(),
        version = CASE WHEN $10::boolean THEN version + 1 ELSE version END
    WHERE order_id = $1
    RETURNING version
    `,
    [
      input.orderId,
      input.totals.paymentStatusId,
      input.totals.paymentDate,
      input.totals.totalAmount,
      input.totals.finalAmount,
      input.totals.paidAmount,
      input.totals.partsCount,
      input.totals.totalArea,
      input.actorUserId,
      input.bumpVersion,
    ],
  );
  return toNumber(result.rows[0].version);
}

async function readOrderVersion(tx: TransactionClient, orderId: number): Promise<number> {
  const result = await tx.query<VersionRow>('SELECT version FROM orders WHERE order_id = $1', [orderId]);
  return toNumber(result.rows[0].version);
}

async function loadOrderSnapshot(tx: TransactionClient, orderId: number): Promise<Record<string, unknown> | null> {
  const result = await tx.query<SnapshotRow>(
    'SELECT to_jsonb(o) AS snapshot FROM orders o WHERE o.order_id = $1',
    [orderId],
  );
  return parseJsonObject(result.rows[0]?.snapshot ?? null);
}

async function readOrderOrThrow(reader: PgOrderReadRepository, orderId: number): Promise<OrderDto> {
  const order = await reader.getOrderById({
    orderId,
    currentUser: {
      id: '0',
      username: 'system',
      role: 'admin',
      roleId: 1,
      permissions: [],
    },
  });
  if (!order) {
    throw new ApiError(500, 'ORDER_TRANSFER_READ_FAILED', 'Не удалось прочитать заказ после переноса', {
      orderId,
    });
  }
  return order;
}

async function enqueueTransferOutbox(
  tx: TransactionClient,
  input: {
    idempotencyKey: string;
    requestId: string;
    sourceOrderId: number;
    targetOrderId: number;
    targetCreated: boolean;
    clientId: number;
    movedDetailIds: readonly number[];
    sourceVersion: number;
    targetVersion: number;
    actorUserId: string;
  },
): Promise<void> {
  await tx.query(
    `
    INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
    VALUES ($1, 'order', $2, $3::jsonb, $4)
    ON CONFLICT (idempotency_key) DO NOTHING
    `,
    [
      'order.details_transferred',
      String(input.sourceOrderId),
      JSON.stringify({
        eventType: 'order.details_transferred',
        requestId: input.requestId,
        sourceOrderId: input.sourceOrderId,
        targetOrderId: input.targetOrderId,
        targetCreated: input.targetCreated,
        clientId: input.clientId,
        movedDetailIds: input.movedDetailIds,
        sourceVersion: input.sourceVersion,
        targetVersion: input.targetVersion,
        actorUserId: input.actorUserId,
      }),
      input.idempotencyKey,
    ],
  );
}

async function reconcileTransferIdempotency(
  tx: TransactionClient,
  command: TransferOrderDetailsCommand,
): Promise<{ completedResponse?: TransferOrderDetailsResponseDto }> {
  const requestHash = hashRequest({
    actorUserId: command.currentUser.id,
    commandName: 'orders.detail_transfer',
    sourceOrderId: command.sourceOrderId,
    sourceVersion: command.sourceVersion,
    target: command.dto.target,
    detailIds: [...command.dto.detailIds].sort((a, b) => a - b),
    note: command.dto.note ?? null,
  });
  const inserted = await tx.query<IdempotencyRow>(
    `
    INSERT INTO command_idempotency_keys (
      idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status
    )
    VALUES ($1, 'orders.detail_transfer', $2, 'order', $3, $4, 'processing')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING idempotency_key, request_hash, response_json, status, created_at
    `,
    [command.idempotencyKey, actorUserIdOf(command.currentUser), String(command.sourceOrderId), requestHash],
  );
  if (inserted.rows[0]) {
    return {};
  }
  const existing = await tx.query<IdempotencyRow>(
    `
    SELECT idempotency_key, request_hash, response_json, status, created_at
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
  if (row.status === 'completed' && row.response_json) {
    return { completedResponse: parseTransferResponse(row.response_json) };
  }
  if (row.status === 'failed') {
    throw new ApiError(409, 'IDEMPOTENCY_FAILED', 'Idempotent command previously failed', {
      idempotencyKey: command.idempotencyKey,
    });
  }
  if (isStaleProcessing(row.created_at)) {
    await tx.query(
      `UPDATE command_idempotency_keys SET status = 'failed' WHERE idempotency_key = $1 AND status = 'processing'`,
      [command.idempotencyKey],
    );
    throw new ApiError(409, 'IDEMPOTENCY_FAILED', 'Idempotent command previously failed', {
      idempotencyKey: command.idempotencyKey,
    });
  }
  throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing', {
    idempotencyKey: command.idempotencyKey,
  });
}

async function completeTransferIdempotency(
  tx: TransactionClient,
  idempotencyKey: string,
  response: TransferOrderDetailsResponseDto,
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

function hashRequest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function parseTransferResponse(value: TransferOrderDetailsResponseDto | string): TransferOrderDetailsResponseDto {
  return typeof value === 'string' ? JSON.parse(value) as TransferOrderDetailsResponseDto : value;
}

function parseJsonObject(value: Record<string, unknown> | string | null): Record<string, unknown> | null {
  if (value === null) {
    return null;
  }
  return typeof value === 'string' ? JSON.parse(value) as Record<string, unknown> : value;
}

function isStaleProcessing(createdAt: string | Date | null): boolean {
  if (!createdAt) {
    return false;
  }
  return Date.now() - new Date(createdAt).getTime() > IDEMPOTENCY_STALE_MS;
}

function compareDetailOrder(left: LockedDetailRow, right: LockedDetailRow): number {
  const leftNumber = toNullableNumber(left.detail_number) ?? Number.MAX_SAFE_INTEGER;
  const rightNumber = toNullableNumber(right.detail_number) ?? Number.MAX_SAFE_INTEGER;
  if (leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return toNumber(left.detail_id) - toNumber(right.detail_id);
}

function buildTransferAuditDetails(
  movedDetails: readonly LockedDetailRow[],
  targetDetailNumbers: ReadonlyMap<number, number>,
): TransferAuditDetail[] {
  return movedDetails.map((detail) => {
    const detailId = toNumber(detail.detail_id);
    return {
      detailId,
      sourceDetailNumber: toNullableNumber(detail.detail_number),
      targetDetailNumber: targetDetailNumbers.get(detailId) ?? null,
      height: toNumber(detail.height),
      width: toNumber(detail.width),
      quantity: toNumber(detail.quantity),
    };
  });
}

function mapTransferTarget(row: TargetSearchRow): OrderTransferTargetDto {
  return {
    orderId: toNumber(row.order_id),
    orderName: row.order_name,
    clientId: toNumber(row.client_id),
    clientName: row.client_name,
    orderDate: dateOnly(row.order_date),
    projectId: toNumber(row.project_id),
    projectCode: row.project_code,
    projectName: row.project_name,
    orderStatusId: toNumber(row.order_status_id),
    orderStatusName: row.order_status_name,
    productionStatusId: toNullableNumber(row.production_status_id),
    productionStatusName: row.production_status_name,
    version: toNumber(row.version),
  };
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') {
    throw new ApiError(500, 'INVALID_DATABASE_NUMBER', 'Invalid numeric database value');
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ApiError(500, 'INVALID_DATABASE_NUMBER', 'Invalid numeric database value');
  }
  return parsed;
}

function actorUserIdOf(currentUser: CurrentUser): number | null {
  const parsed = Number(currentUser.id);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return toNumber(value);
}

function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

function toBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function dateOnly(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function dateOnlyOrNull(value: string | Date | null): string | null {
  return value === null ? null : dateOnly(value);
}
