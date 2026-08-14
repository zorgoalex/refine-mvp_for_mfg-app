import { ApiError } from '../../../common/errors/api-error';
import { OrderAccessPolicy } from '../../../permissions/policies/order-access.policy';
import { PaymentAccessPolicy } from '../../../permissions/policies/payment-access.policy';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  CreateOrderCommand,
  DeleteOrderCommand,
  DetailSheetAuditRef,
  OrderDetailStatusAuditRow,
  OrderDeadlineSyncPort,
  OrderDefaultSchedulePort,
  OrderChildReference,
  RecalculateOrderHdfCommand,
  RestoreOrderCommand,
  OrderSaveAuditMetadata,
  OrderStatusAuditInfo,
  OrderAutomationSourceOutboxEvent,
  LockedOrderRow,
  OrderPermissionCheckerPort,
  ProductionStatusAuditInfo,
  OrderTransactionManagerPort,
  OrderWriteUnitOfWork,
  UpdateOrderCommand,
} from './order-transaction.types';
import type { DeleteOrderResponseDto, OrderDto, RestoreOrderResponseDto } from '../dto/order.dto';
import type {
  CalculatedOrderDetailDto,
  NormalizedSaveOrderDto,
  PreparedOrderSave,
} from '../dto/save-order.dto';
import type { CurrentUser } from '../../../permissions/current-user';
import {
  OrderNotDeletedError,
  OrderNotFoundError,
  OrderRestoreIdempotencyFailedError,
  OrderRestoreIdempotencyInProgressError,
  OrderRestoreIdempotencyKeyReusedError,
  OrderVersionConflictError,
} from '../errors/order.errors';
import { prepareOrderSave } from '../domain/order-save-preparer';
import { ProjectClientMismatchError } from '../../projects/errors/projects.errors';
import {
  addCalendarDays,
  calculateApplicableDeadlineSchedule,
} from '../../deadlines/domain/deadline-default-schedule';
import {
  assertSheetEligibilityAndNoClear,
  orderTouchesSheet,
  type SheetValidationDetail,
  type SheetValidationHeader,
} from '../domain/sheet-order-validation';
import type { StatusAutomationEvent } from '../../status-automation/application/status-automation.types';

interface StoredSheetSummary {
  eligible: boolean;
  headerSheetId: number | null;
  detailSheetIds: ReadonlyArray<{ detailId: number; sheetMaterialTypeId: number | null }>;
}

const ORDER_SAVE_SOURCE = 'backend-orders-command';

function actorUserIdOf(currentUser: CurrentUser): number | null {
  const parsed = Number(currentUser.id);
  return Number.isFinite(parsed) ? parsed : null;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function dateOnlyOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const normalized = String(value).trim();
  if (normalized.length === 0) return null;
  return /^(\d{4}-\d{2}-\d{2})/.exec(normalized)?.[1] ?? normalized;
}

function changedDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (before[key] !== after[key]) {
      diff[key] = { before: before[key] ?? null, after: after[key] ?? null };
    }
  }
  return diff;
}

function orderStatusAuditJson(
  statusId: number | null,
  status: OrderStatusAuditInfo | null,
  version: number,
): Record<string, unknown> {
  return {
    orderStatusId: statusId,
    orderStatusName: status?.statusName ?? null,
    orderStatusCode: status?.statusCode ?? null,
    version,
  };
}

function productionStatusAuditJson(
  statusId: number | null,
  status: ProductionStatusAuditInfo | null,
  version: number,
  productionStatusFromDetailsEnabled: boolean | null,
): Record<string, unknown> {
  return {
    productionStatusId: statusId,
    productionStatusName: status?.statusName ?? null,
    productionStatusCode: status?.statusCode ?? null,
    productionStatusFromDetailsEnabled,
    version,
  };
}

function detailProductionStatusAuditJson(
  detail: OrderDetailStatusAuditRow,
): Record<string, unknown> {
  return {
    detailId: detail.detailId,
    detailNumber: detail.detailNumber,
    productionStatusId: detail.productionStatusId,
    productionStatusName: detail.productionStatusName,
    productionStatusCode: detail.productionStatusCode,
  };
}

function normalizeProjectIdInput(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Order payload validation failed', {
      errors: [{ field: 'header.projectId', message: 'projectId must be a positive integer' }],
    });
  }

  return parsed;
}

function toSheetHeader(order: NormalizedSaveOrderDto): SheetValidationHeader {
  return {
    sheetMaterialTypeId: order.header.sheetMaterialTypeId ?? null,
    materialId: order.header.materialId ?? null,
  };
}

function toSheetDetails(details: readonly CalculatedOrderDetailDto[]): SheetValidationDetail[] {
  return details.map((detail, index) => ({
    label: `details[${index}]`,
    detailId: detail.id,
    sheetMaterialTypeId: detail.sheetMaterialTypeId ?? null,
    materialId: detail.materialId ?? null,
    height: detail.height,
    width: detail.width,
  }));
}

function toAfterDetailRefs(details: readonly CalculatedOrderDetailDto[]): DetailSheetAuditRef[] {
  return details.map((detail) => ({
    detailId: detail.id,
    tempKey: detail.id === undefined ? detail.clientKey : undefined,
    sheetMaterialTypeId: detail.sheetMaterialTypeId ?? null,
  }));
}

function toBeforeDetailRefs(
  stored: ReadonlyArray<{ detailId: number; sheetMaterialTypeId: number | null }>,
): DetailSheetAuditRef[] {
  return stored.map((row) => ({
    detailId: row.detailId,
    sheetMaterialTypeId: row.sheetMaterialTypeId,
  }));
}

function collectSheetMaterialTypeIds(
  headerSheetId: number | null | undefined,
  details: ReadonlyArray<{ sheetMaterialTypeId?: number | null }>,
  storedDetailIds?: ReadonlyArray<{ sheetMaterialTypeId: number | null }>,
): number[] {
  const ids = new Set<number>();
  if (headerSheetId != null) ids.add(headerSheetId);
  for (const d of details) {
    if (d.sheetMaterialTypeId != null) ids.add(d.sheetMaterialTypeId);
  }
  for (const d of storedDetailIds ?? []) {
    if (d.sheetMaterialTypeId != null) ids.add(d.sheetMaterialTypeId);
  }
  return [...ids];
}

export interface OrderTransactionServicePorts {
  transactions: OrderTransactionManagerPort;
  permissions?: OrderPermissionCheckerPort;
  deadlineSync?: OrderDeadlineSyncPort;
  defaultSchedule?: OrderDefaultSchedulePort;
}

export class OrderTransactionService {
  private readonly permissions: OrderPermissionCheckerPort;
  private readonly orderAccessPolicy = new OrderAccessPolicy();
  private readonly paymentAccessPolicy = new PaymentAccessPolicy();

  constructor(private readonly ports: OrderTransactionServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async create(command: CreateOrderCommand): Promise<OrderDto> {
    const order = await this.ports.transactions.runInTransaction(async (unitOfWork) => {
      await unitOfWork.setSessionUser(command.currentUser.id);
      if (command.dto.idempotencyKey) {
        const idem = await unitOfWork.reconcileOrderCreateIdempotency({
          idempotencyKey: command.dto.idempotencyKey,
          currentUser: command.currentUser,
          dto: command.dto,
        });
        if (idem.completedResponse) {
          return idem.completedResponse;
        }
      }
      this.requirePermission(command, 'orders.create');
      this.requirePermission(command, 'orders.view_financials');
      const normalized = prepareOrderSave(command.dto, { mode: 'create' });
      const appliedDefaults = await this.applyDefaultSchedule(
        normalized,
        unitOfWork,
      );
      const prepared = appliedDefaults.prepared;
      const requestedProjectId = normalizeProjectIdInput(
        command.dto.header.projectId,
      );
      this.requireFinancePermissionForPaymentMutations(command, prepared.order);

      // Уникальность номера заказа среди живых заказов — жёсткий блок (409 с
      // предложенным следующим номером), обхода нет by design. Advisory-лок
      // имени берётся ДО project/order-локов (единый порядок во всех командах).
      await unitOfWork.lockOrderName(prepared.order.header.orderName);
      await unitOfWork.assertOrderNameAvailable({ orderName: prepared.order.header.orderName });

      // New orders are SP3-era (sheet_eligible default true): eligible, no stored sheet state.
      const touchesSheet = await this.enforceSheetGuards(unitOfWork, command, prepared, {
        eligible: true,
        headerSheetId: null,
        detailSheetIds: [],
      });

      const project = await unitOfWork.resolveProjectForCreate({
        projectId: requestedProjectId,
        clientId: prepared.order.header.clientId,
        orderName: prepared.order.header.orderName,
        currentUser: command.currentUser,
        requestId: command.requestId ?? 'orders-create',
      });
      const orderId = await unitOfWork.createOrderHeader({
        header: prepared.order.header,
        totals: prepared.totals,
        projectId: project.projectId,
        currentUser: command.currentUser,
      });

      const detailIdsByClientKey = await this.persistChildren(
        unitOfWork,
        orderId,
        prepared,
        command.currentUser,
        command.requestId,
      );
      const version = await unitOfWork.updateOrderTotalsAndVersion({
        orderId,
        totals: prepared.totals,
        previousVersion: null,
        currentUser: command.currentUser,
      });
      const bazisPanelLinks = await this.reconcilePdfImportedBazisPanels(unitOfWork, {
        orderId,
        version,
        order: prepared.order,
        detailIdsByClientKey,
        currentUser: command.currentUser,
        requestId: command.requestId,
        sourceIdempotencyKey: command.dto.idempotencyKey,
      });
      const afterSnapshot = await unitOfWork.loadOrderHeaderSnapshot(orderId);
      const afterDetailRefs = touchesSheet ? toAfterDetailRefs(prepared.details) : undefined;
      await unitOfWork.writeAuditEvent({
        action: 'orders.create',
        orderId,
        actorUserId: command.currentUser.id,
        actorUsername: command.currentUser.username,
        actorRole: command.currentUser.role,
        clientId: prepared.order.header.clientId ?? null,
        requestId: command.requestId,
        before: null,
        // Embed detail sheet refs into the snapshot so computeDiff() emits them in diff_json
        // (Critic R7 M2). Uses a key without password/token/secret to avoid redaction.
        after: touchesSheet
          ? { ...afterSnapshot, detailSheetMaterialChanges: afterDetailRefs }
          : afterSnapshot,
        metadata: this.buildSaveMetadata(
          'orders.create',
          command.requestId,
          touchesSheet ? { before: [], after: afterDetailRefs! } : undefined,
          appliedDefaults.provenance,
          bazisPanelLinks,
        ),
        relatedSheetMaterialTypeIds: collectSheetMaterialTypeIds(
          prepared.order.header.sheetMaterialTypeId,
          prepared.details,
        ),
      });
      const automationRequestId =
        command.requestId ??
        (command.dto.idempotencyKey ? 'orders-create' : `orders-create-${orderId}`);
      const automationBase = {
        origin: 'user' as const,
        orderId,
        actor: command.currentUser,
        requestId: automationRequestId,
        sourceIdempotencyKey: command.dto.idempotencyKey ?? undefined,
      };
      await this.emitAutomationSourceEvent(unitOfWork, {
        event: { ...automationBase, eventType: 'order.created' },
        clientId: prepared.order.header.clientId ?? null,
        action: 'order_created',
        scopeSource: 'order-save',
        payload: { version },
      });
      const plannedCompletionDate = dateOnlyOrNull(afterSnapshot?.plannedCompletionDate);
      if (plannedCompletionDate !== null) {
        await this.emitAutomationSourceEvent(unitOfWork, {
          event: {
            ...automationBase,
            eventType: 'order.planned_completion_date_changed',
            plannedCompletionDateBefore: null,
            plannedCompletionDateAfter: plannedCompletionDate,
          },
          clientId: prepared.order.header.clientId ?? null,
          action: 'planned_completion_date_change',
          scopeSource: 'order-save',
          payload: {
            plannedCompletionDateBefore: null,
            plannedCompletionDateAfter: plannedCompletionDate,
            version,
          },
        });
      }
      await this.emitPaymentCreatedAutomationEvents(unitOfWork, {
        orderId,
        order: prepared.order,
        currentUser: command.currentUser,
        requestId: automationRequestId,
        sourceIdempotencyKey: command.dto.idempotencyKey ?? undefined,
      });
      if (command.postPersistHook) {
        await command.postPersistHook(unitOfWork, { orderId, detailIdsByClientKey });
      }

      const response = this.attachProjectToOrder(
        await this.readAndAssertVersion(unitOfWork, orderId, version, command),
        project.projectId,
        project.code,
      );
      if (command.dto.idempotencyKey) {
        await unitOfWork.completeOrderCreateIdempotency(command.dto.idempotencyKey, response);
      }
      return response;
    });

    await this.ports.deadlineSync?.syncOrderDeadlinesAfterSave({
      orderId: order.header.orderId,
      currentUser: command.currentUser,
      eventType: 'ORDER_CREATED',
      requestId: command.requestId,
    });

    return order;
  }

  private async applyDefaultSchedule(
    prepared: PreparedOrderSave,
    unitOfWork: OrderWriteUnitOfWork,
  ): Promise<{
    prepared: PreparedOrderSave;
    provenance?: NonNullable<OrderSaveAuditMetadata['defaultSchedule']>;
  }> {
    const schedule = this.ports.defaultSchedule
      ? await this.ports.defaultSchedule.getConfiguredSchedule(
          unitOfWork.getTransactionClient(),
        )
      : undefined;
    if (!schedule) {
      return { prepared };
    }

    const orderDate = prepared.order.header.orderDate;
    const applicableSchedule = calculateApplicableDeadlineSchedule(
      schedule,
      prepared.order.workshops.map((workshop) => workshop.productionStatusId),
    );
    if (!applicableSchedule) {
      return { prepared };
    }
    const headerDefaultDate = addCalendarDays(
      orderDate,
      applicableSchedule.plannedOrderDays,
    );
    const headerApplied =
      prepared.order.header.plannedCompletionDate === null && headerDefaultDate !== null;
    const appliedWorkshops: NonNullable<
      OrderSaveAuditMetadata['defaultSchedule']
    >['workshops'] = [];
    return {
      prepared: {
        ...prepared,
        order: {
          ...prepared.order,
          header: {
            ...prepared.order.header,
            plannedCompletionDate:
              prepared.order.header.plannedCompletionDate === null
                ? headerDefaultDate
                : prepared.order.header.plannedCompletionDate,
          },
          workshops: prepared.order.workshops.map((workshop) => {
            if (workshop.plannedCompletionDate !== null) {
              return workshop;
            }
            const stageDays =
              applicableSchedule.stageDeadlineDaysByProductionStatusId.get(
                workshop.productionStatusId,
              );
            const plannedCompletionDate =
              stageDays === undefined ? null : addCalendarDays(orderDate, stageDays);
            if (plannedCompletionDate === null) {
              return workshop;
            }
            appliedWorkshops.push({
              ...(workshop.clientKey ? { clientKey: workshop.clientKey } : {}),
              productionStatusId: workshop.productionStatusId,
            });
            return { ...workshop, plannedCompletionDate };
          }),
        },
      },
      provenance: {
        version: schedule.version,
        headerApplied,
        workshops: appliedWorkshops,
      },
    };
  }

  async update(command: UpdateOrderCommand): Promise<OrderDto> {
    const order = await this.ports.transactions.runInTransaction(async (unitOfWork) => {
      await unitOfWork.setSessionUser(command.currentUser.id);
      this.requirePermission(command, 'orders.update');
      this.requirePermission(command, 'orders.view_financials');

      // Global lock order shared with projects move/merge: project rows BEFORE
      // order rows. A client change retargets the order's root project, so when
      // this update will need the project lock it must be taken before the
      // order row lock — taking it after inverts moveOrder's order and can
      // deadlock. Pre-read is unlocked; the client-change block below re-checks
      // against the locked snapshot and 409s if the world moved in between.
      // Advisory-лок номера — ПЕРВЫМ, до project/order row-локов: update с
      // одновременной сменой клиента (project-лок) и переименованием иначе
      // инвертирует порядок против create и даёт deadlock (Critic R1-1).
      // Без переименования лок избыточен, но безвреден (self-serialization).
      // String(...) — та же коэрсия, что в order-normalizer: raw @Body может
      // принести не-строку, TypeError до валидации недопустим (Critic R2).
      await unitOfWork.lockOrderName(String(command.dto.header?.orderName ?? ''));

      const requestedClientId = numOrNull(command.dto.header?.clientId);
      const preRead = await unitOfWork.readOrderClientProject(command.orderId);
      if (!preRead) {
        throw new OrderNotFoundError(command.orderId);
      }
      const projectLockedUpfront =
        requestedClientId !== null && preRead.clientId !== null && preRead.clientId !== requestedClientId;
      if (projectLockedUpfront) {
        await unitOfWork.lockProjectById(preRead.projectId);
      }

      const lockedOrder = await unitOfWork.loadOrderForUpdate(command.orderId);

      if (!lockedOrder) {
        throw new OrderNotFoundError(command.orderId);
      }

      this.requireUpdateScope(command, lockedOrder);

      const clientVersion = this.extractClientVersion(command.dto.version, lockedOrder.version);

      if (clientVersion !== lockedOrder.version) {
        throw new OrderVersionConflictError(lockedOrder.version, clientVersion);
      }

      const prepared = prepareOrderSave({ ...command.dto, version: clientVersion }, {
        mode: 'update',
        pathOrderId: command.orderId,
      });

      this.requireFinancePermissionForPaymentMutations(command, prepared.order, lockedOrder);

      // Переименование в занятый номер — блок; без смены имени проверка не
      // выполняется (легаси-дубли остаются редактируемыми).
      if (
        prepared.order.header.orderName.trim().toLowerCase() !==
        lockedOrder.orderName.trim().toLowerCase()
      ) {
        await unitOfWork.assertOrderNameAvailable({
          orderName: prepared.order.header.orderName,
          excludeOrderId: command.orderId,
        });
      }
      const beforeSnapshot = await unitOfWork.loadOrderHeaderSnapshot(command.orderId);
      const beforeDetailStatusRows = await unitOfWork.loadOrderDetailStatusAuditRows(command.orderId);

      // SP3 stored sheet state. Only sheet-eligible orders can carry sheet details, so
      // read stored details ONLY when eligible — legacy updates take no extra query and
      // skip the sheet path entirely.
      const storedEligible = (beforeSnapshot as Record<string, unknown> | null)?.sheetEligible === true;
      const storedHeaderSheetId = numOrNull(
        (beforeSnapshot as Record<string, unknown> | null)?.sheetMaterialTypeId,
      );
      let storedDetailSheetIds: ReadonlyArray<{
        detailId: number;
        sheetMaterialTypeId: number | null;
      }> = [];
      if (storedEligible) {
        const storedState = await unitOfWork.loadStoredOrderSheetState(command.orderId);
        storedDetailSheetIds = storedState.detailSheetIds;
      }
      const touchesSheet = await this.enforceSheetGuards(unitOfWork, command, prepared, {
        eligible: storedEligible,
        headerSheetId: storedHeaderSheetId,
        detailSheetIds: storedDetailSheetIds,
      });

      const previousClientId = numOrNull(
        (beforeSnapshot as Record<string, unknown> | null)?.clientId,
      );
      const nextClientId = prepared.order.header.clientId;
      if (previousClientId !== null && previousClientId !== nextClientId) {
        // The project row must already be held from the pre-lock above, for the
        // same project the order belongs to NOW. If the pre-read missed the
        // client change or the order was re-parented in between, locking the
        // project here would invert the global lock order — fail retriable.
        const snapshotProjectId = numOrNull(
          (beforeSnapshot as Record<string, unknown> | null)?.projectId,
        );
        if (!projectLockedUpfront || snapshotProjectId !== preRead.projectId) {
          throw new ApiError(
            409,
            'ORDER_PROJECT_CONFLICT',
            'Заказ или его проект изменён параллельной операцией, повторите',
          );
        }
        const project = await unitOfWork.lockProjectForOrder(command.orderId);
        if (project.clientId !== nextClientId) {
          const ordersInProject = await unitOfWork.countOrdersInProject(project.projectId);
          if (ordersInProject === 1) {
            await unitOfWork.retargetProjectClient(
              project.projectId,
              nextClientId,
              command.currentUser,
              command.requestId,
            );
          } else {
            throw new ProjectClientMismatchError();
          }
        }
      }

      await unitOfWork.assertChildOwnership(
        command.orderId,
        collectChildReferences(prepared.order),
      );
      if (command.prePersistHook) {
        await command.prePersistHook(unitOfWork, lockedOrder);
      }
      await unitOfWork.updateOrderHeader({
        orderId: command.orderId,
        header: prepared.order.header,
        totals: prepared.totals,
        currentUser: command.currentUser,
      });
      const detailIdsByClientKey = await this.persistChildren(
        unitOfWork,
        command.orderId,
        prepared,
        command.currentUser,
        command.requestId,
      );
      const version = await unitOfWork.updateOrderTotalsAndVersion({
        orderId: command.orderId,
        totals: prepared.totals,
        previousVersion: lockedOrder.version,
        currentUser: command.currentUser,
      });
      const bazisPanelLinks = await this.reconcilePdfImportedBazisPanels(unitOfWork, {
        orderId: command.orderId,
        version,
        order: prepared.order,
        detailIdsByClientKey,
        currentUser: command.currentUser,
        requestId: command.requestId,
        sourceIdempotencyKey: command.dto.idempotencyKey,
      });
      const afterSnapshot = await unitOfWork.loadOrderHeaderSnapshot(command.orderId);
      const afterDetailStatusRows = await unitOfWork.loadOrderDetailStatusAuditRows(command.orderId);
      const beforeDetailRefs = touchesSheet ? toBeforeDetailRefs(storedDetailSheetIds) : undefined;
      const afterDetailRefs2 = touchesSheet ? toAfterDetailRefs(prepared.details) : undefined;
      await unitOfWork.writeAuditEvent({
        action: 'orders.update',
        orderId: command.orderId,
        actorUserId: command.currentUser.id,
        actorUsername: command.currentUser.username,
        actorRole: command.currentUser.role,
        clientId: prepared.order.header.clientId ?? null,
        requestId: command.requestId,
        // Embed detail sheet refs into snapshots so computeDiff() emits them in diff_json
        // (Critic R7 M2). Uses a key without password/token/secret to avoid redaction.
        before: touchesSheet
          ? { ...beforeSnapshot, detailSheetMaterialChanges: beforeDetailRefs }
          : beforeSnapshot,
        after: touchesSheet
          ? { ...afterSnapshot, detailSheetMaterialChanges: afterDetailRefs2 }
          : afterSnapshot,
        metadata: this.buildSaveMetadata(
          'orders.update',
          command.requestId,
          touchesSheet
            ? { before: beforeDetailRefs!, after: afterDetailRefs2! }
            : undefined,
          undefined,
          bazisPanelLinks,
        ),
        relatedSheetMaterialTypeIds: collectSheetMaterialTypeIds(
          prepared.order.header.sheetMaterialTypeId,
          prepared.details,
          storedDetailSheetIds,
        ),
      });
      const automationRequestId =
        command.requestId ??
        (command.dto.idempotencyKey ? 'orders-update' : `orders-update-${command.orderId}-v${version}`);
      await this.emitStatusChangeAuditAndEvents(unitOfWork, {
        orderId: command.orderId,
        previousVersion: lockedOrder.version,
        nextVersion: version,
        currentUser: command.currentUser,
        clientId: prepared.order.header.clientId ?? null,
        requestId: automationRequestId,
        sourceIdempotencyKey: command.dto.idempotencyKey ?? undefined,
        beforeSnapshot,
        afterSnapshot,
        beforeDetailStatusRows,
        afterDetailStatusRows,
      });
      const plannedCompletionDateBefore = dateOnlyOrNull(beforeSnapshot?.plannedCompletionDate);
      const plannedCompletionDateAfter = dateOnlyOrNull(afterSnapshot?.plannedCompletionDate);
      if (plannedCompletionDateBefore !== plannedCompletionDateAfter) {
        await this.emitAutomationSourceEvent(unitOfWork, {
          event: {
            eventType: 'order.planned_completion_date_changed',
            origin: 'user',
            orderId: command.orderId,
            actor: command.currentUser,
            requestId: automationRequestId,
            sourceIdempotencyKey: command.dto.idempotencyKey ?? undefined,
            plannedCompletionDateBefore,
            plannedCompletionDateAfter,
          },
          clientId: prepared.order.header.clientId ?? null,
          action: 'planned_completion_date_change',
          scopeSource: 'order-save',
          payload: {
            plannedCompletionDateBefore,
            plannedCompletionDateAfter,
            previousVersion: lockedOrder.version,
            version,
          },
        });
      }
      await this.emitPaymentCreatedAutomationEvents(unitOfWork, {
        orderId: command.orderId,
        order: prepared.order,
        currentUser: command.currentUser,
        requestId: automationRequestId,
        sourceIdempotencyKey: command.dto.idempotencyKey ?? undefined,
      });
      await this.emitAutomationSourceEvent(unitOfWork, {
        event: {
          eventType: 'order.updated',
          origin: 'user',
          orderId: command.orderId,
          actor: command.currentUser,
          requestId: automationRequestId,
          sourceIdempotencyKey: command.dto.idempotencyKey ?? undefined,
        },
        clientId: prepared.order.header.clientId ?? null,
        action: 'order_updated',
        scopeSource: 'order-save',
        payload: {
          previousVersion: lockedOrder.version,
          version,
        },
      });
      if (command.postPersistHook) {
        await command.postPersistHook(unitOfWork, {
          orderId: command.orderId,
          detailIdsByClientKey,
        });
      }

      return this.readAndAssertVersion(unitOfWork, command.orderId, version, command);
    });

    await this.ports.deadlineSync?.syncOrderDeadlinesAfterSave({
      orderId: command.orderId,
      currentUser: command.currentUser,
      eventType: 'ORDER_UPDATED',
      requestId: command.requestId,
    });

    return order;
  }

  async recalculateHdf(command: RecalculateOrderHdfCommand): Promise<OrderDto> {
    const order = await this.ports.transactions.runInTransaction(async (unitOfWork) => {
      await unitOfWork.setSessionUser(command.currentUser.id);
      this.requirePermission(command, 'orders.update');

      const lockedOrder = await unitOfWork.loadOrderForUpdate(command.orderId);
      if (!lockedOrder) {
        throw new OrderNotFoundError(command.orderId);
      }
      this.requireUpdateScope(command, lockedOrder);

      await unitOfWork.reconcileHdfDetails({
        orderId: command.orderId,
        currentUser: command.currentUser,
        requestId: command.requestId,
      });
      await unitOfWork.recalcOrderProductionStatus(command.orderId);

      return this.filterOrderForReadPermissions(
        await unitOfWork.readOrder(command.orderId),
        command,
      );
    });

    await this.ports.deadlineSync?.syncOrderDeadlinesAfterSave({
      orderId: command.orderId,
      currentUser: command.currentUser,
      eventType: 'ORDER_UPDATED',
      requestId: command.requestId,
    });

    return order;
  }

  async delete(command: DeleteOrderCommand): Promise<DeleteOrderResponseDto> {
    return this.ports.transactions.runInTransaction(async (unitOfWork) => {
      await unitOfWork.setSessionUser(command.currentUser.id);

      const requestId = command.requestId ?? 'order-delete-command';
      const idempotency = await unitOfWork.reconcileOrderDeleteIdempotency(command);
      if (idempotency.completedResponse) {
        return idempotency.completedResponse;
      }

      const lockedOrder = await unitOfWork.loadOrderForDelete(command.orderId);

      if (!lockedOrder) {
        throw new OrderNotFoundError(command.orderId);
      }

      await this.requireDeletePermission(command, lockedOrder);

      if (command.version !== lockedOrder.version) {
        throw new OrderVersionConflictError(lockedOrder.version, command.version);
      }

      const nextVersion = await unitOfWork.softDeleteOrder({
        orderId: command.orderId,
        previousVersion: lockedOrder.version,
        actorUserId: command.currentUser.id,
      });
      const auditId = await unitOfWork.writeOrderDeleteAudit({
        currentUser: command.currentUser,
        requestId,
        order: lockedOrder,
        nextVersion,
      });
      await unitOfWork.enqueueOrderDeleteOutbox({
        currentUser: command.currentUser,
        requestId,
        order: lockedOrder,
        nextVersion,
        auditId,
        idempotencyKey: command.idempotencyKey,
      });

      const response: DeleteOrderResponseDto = {
        success: true,
        orderId: command.orderId,
        auditId,
        requestId,
      };
      await unitOfWork.completeOrderDeleteIdempotency(command.idempotencyKey, response);

      return response;
    });
  }

  async restore(command: RestoreOrderCommand): Promise<RestoreOrderResponseDto> {
    const targetOrderName =
      command.orderName === undefined ? undefined : String(command.orderName).trim();
    const normalizedCommand =
      targetOrderName === command.orderName ? command : { ...command, orderName: targetOrderName };

    try {
      const idempotency = await this.ports.transactions.reserveOrderRestoreIdempotency(normalizedCommand);
      if (idempotency.completedResponse) {
        return idempotency.completedResponse;
      }

      return await this.ports.transactions.runInTransaction(async (unitOfWork) => {
        await unitOfWork.setSessionUser(command.currentUser.id);

        const requestId = command.requestId ?? 'order-restore-command';
        if (targetOrderName !== undefined && targetOrderName.length === 0) {
          throw new ApiError(422, 'VALIDATION_ERROR', 'orderName не может быть пустым', {
            field: 'orderName',
          });
        }

        const peekedOrderName =
          targetOrderName === undefined ? await unitOfWork.peekOrderName(command.orderId) : null;
        if (targetOrderName === undefined && peekedOrderName === null) {
          throw new OrderNotFoundError(command.orderId);
        }

        const lockedTargetName = targetOrderName ?? peekedOrderName!;
        await unitOfWork.lockOrderName(lockedTargetName);

        const lockedOrder = await unitOfWork.loadOrderForRestore(command.orderId);
        if (!lockedOrder) {
          throw new OrderNotFoundError(command.orderId);
        }

        await this.requireDeletePermission(normalizedCommand, lockedOrder, async () => {
          await unitOfWork.recordOrderRestoreDenied({
            currentUser: command.currentUser,
            orderId: command.orderId,
            requestId,
          });
        });

        if (!lockedOrder.deleteFlag) {
          throw new OrderNotDeletedError(command.orderId);
        }

        if (command.version !== lockedOrder.version) {
          throw new OrderVersionConflictError(lockedOrder.version, command.version);
        }

        const effectiveTargetName = targetOrderName ?? lockedOrder.orderName;
        if (effectiveTargetName !== lockedTargetName) {
          throw new OrderVersionConflictError(lockedOrder.version, command.version);
        }

        await unitOfWork.assertOrderNameAvailable({ orderName: effectiveTargetName });

        const nextVersion = await unitOfWork.restoreOrder({
          orderId: command.orderId,
          previousVersion: lockedOrder.version,
          targetOrderName: effectiveTargetName,
          actorUserId: command.currentUser.id,
        });
        const auditId = await unitOfWork.writeOrderRestoreAudit({
          currentUser: command.currentUser,
          requestId,
          order: lockedOrder,
          targetOrderName: effectiveTargetName,
          nextVersion,
        });
        await unitOfWork.enqueueOrderRestoreOutbox({
          currentUser: command.currentUser,
          requestId,
          order: lockedOrder,
          targetOrderName: effectiveTargetName,
          nextVersion,
          auditId,
          idempotencyKey: command.idempotencyKey,
        });

        const order = await unitOfWork.readOrder(command.orderId);
        const response: RestoreOrderResponseDto = { order, auditId, requestId };
        await unitOfWork.completeOrderRestoreIdempotency(command.idempotencyKey, response);
        return response;
      });
    } catch (error) {
      if (this.shouldMarkRestoreIdempotencyFailed(error)) {
        // Burn is awaited before rethrow so the client's next sequential retry
        // with the same key deterministically sees failed state. Двухфазная
        // схема: reserve уже ЗАКОММИЧЕН, поэтому провал burn'а оставляет
        // строку 'processing' до stale-таймаута (retry в этом окне получает
        // IN_PROGRESS, не FAILED) — это деградация, а не потеря данных, но она
        // НЕ должна быть молчаливой (Critic code-R4): один повтор + громкий лог.
        await this.burnRestoreIdempotencyLoudly(normalizedCommand);
      }
      throw error;
    }
  }

  private async burnRestoreIdempotencyLoudly(command: RestoreOrderCommand): Promise<void> {
    try {
      await this.ports.transactions.markOrderRestoreIdempotencyFailed(command);
      return;
    } catch {
      // одна повторная попытка: burn — отдельная короткая tx, транзиентные
      // сбои соединения чаще всего одноразовые
    }
    try {
      await this.ports.transactions.markOrderRestoreIdempotencyFailed(command);
    } catch (burnError) {
      console.error(
        '[orders.restore] failed to burn idempotency key after command failure; ' +
          `key stays 'processing' until stale timeout (orderId=${command.orderId}, ` +
          `idempotencyKey=${command.idempotencyKey})`,
        burnError,
      );
    }
  }

  private async persistChildren(
    unitOfWork: OrderWriteUnitOfWork,
    orderId: number,
    prepared: PreparedOrderSave,
    currentUser: CurrentUser,
    requestId?: string,
  ): Promise<Map<string, number>> {
    await unitOfWork.upsertDetails(orderId, prepared.details);
    await unitOfWork.deleteDetails(orderId, prepared.order.deleted.detailIds);
    await unitOfWork.applyHdfStatusEdits({
      orderId,
      edits: prepared.order.hdfDetails,
      currentUser,
      requestId,
    });
    await unitOfWork.deleteHdfDetails(orderId, prepared.order.deleted.hdfDetailIds);
    await unitOfWork.reconcileHdfDetails({ orderId, currentUser, requestId });
    await unitOfWork.recalcOrderProductionStatus(orderId);
    await unitOfWork.upsertPayments(orderId, prepared.order.payments);
    await unitOfWork.deletePayments(orderId, prepared.order.deleted.paymentIds);
    await unitOfWork.deleteWorkshops(orderId, prepared.order.deleted.workshopIds);
    await unitOfWork.upsertWorkshops(orderId, prepared.order.workshops);
    await unitOfWork.deleteRequirements(orderId, prepared.order.deleted.requirementIds);
    await unitOfWork.upsertRequirements(orderId, prepared.order.requirements);
    await unitOfWork.deleteDowelingLinks(orderId, prepared.order.deleted.dowelingLinkIds);
    await unitOfWork.upsertDowelingLinks(orderId, prepared.order.dowelingLinks);
    return new Map(
      prepared.details
        .filter((detail) => detail.clientKey && detail.id)
        .map((detail) => [detail.clientKey as string, detail.id as number]),
    );
  }

  private async reconcilePdfImportedBazisPanels(
    unitOfWork: OrderWriteUnitOfWork,
    input: {
      orderId: number;
      version: number;
      order: NormalizedSaveOrderDto;
      detailIdsByClientKey: Map<string, number>;
      currentUser: CurrentUser;
      requestId?: string;
      sourceIdempotencyKey?: string;
    },
  ) {
    if (input.order.bazisImportCandidateClientKeys.length === 0) return [];

    const candidateDetailIds = input.order.bazisImportCandidateClientKeys.map((clientKey) => {
      const detailId = input.detailIdsByClientKey.get(clientKey);
      if (!detailId) {
        throw new ApiError(
          500,
          'ORDER_SAVE_FAILED',
          'Не удалось определить импортированную позицию заказа',
        );
      }
      return detailId;
    });
    const requestId = input.requestId ?? `orders-save-${input.orderId}-v${input.version}`;
    return unitOfWork.reconcileBazisPanelOrderLinks({
      orderId: input.orderId,
      candidateDetailIds,
      source: 'pdf_import',
      currentUser: input.currentUser,
      requestId,
      idempotencyKey: `${input.sourceIdempotencyKey ?? requestId}:bazis-panel-order-links`,
    });
  }

  private async readAndAssertVersion(
    unitOfWork: OrderWriteUnitOfWork,
    orderId: number,
    version: number,
    command: Pick<CreateOrderCommand | UpdateOrderCommand, 'currentUser'>,
  ): Promise<OrderDto> {
    const order = await unitOfWork.readOrder(orderId);

    // Status automation can bump order.version inside the same save transaction.
    if (order.version < version) {
      throw new ApiError(500, 'ORDER_SAVE_FAILED', 'Не удалось сохранить заказ');
    }

    return this.filterOrderForReadPermissions(order, command);
  }

  private filterOrderForReadPermissions(
    order: OrderDto,
    command: Pick<CreateOrderCommand | UpdateOrderCommand | RecalculateOrderHdfCommand, 'currentUser'>,
  ): OrderDto {
    return this.permissions.canUser(command.currentUser, 'payments.view')
      ? order
      : { ...order, payments: [] };
  }

  private async emitAutomationSourceEvent(
    unitOfWork: OrderWriteUnitOfWork,
    input: {
      event: StatusAutomationEvent;
      clientId: number | null;
      action: string;
      scopeSource: 'order-save';
      payload?: Record<string, unknown>;
    },
  ): Promise<void> {
    const sourceKey = input.event.sourceIdempotencyKey ?? input.event.requestId;
    const outboxIdempotencyKey = `${sourceKey}:${input.event.eventType}`;
    await unitOfWork.enqueueAutomationSourceOutboxEvent({
      eventType: input.event.eventType,
      orderId: input.event.orderId,
      clientId: input.clientId,
      actorUserId: input.event.actor.id,
      requestId: input.event.requestId,
      idempotencyKey: outboxIdempotencyKey,
      sourceIdempotencyKey: input.event.sourceIdempotencyKey,
      payload: {
        eventType: input.event.eventType,
        actorUserId: input.event.actor.id,
        requestId: input.event.requestId,
        entityType: 'order',
        entityId: String(input.event.orderId),
        orderId: input.event.orderId,
        clientId: input.clientId,
        action: input.action,
        scope: { source: input.scopeSource },
        idempotencyKey: sourceKey,
        outboxIdempotencyKey,
        ...input.payload,
      },
    });
    await unitOfWork.evaluateStatusAutomation(input.event);
  }

  private async emitStatusChangeAuditAndEvents(
    unitOfWork: OrderWriteUnitOfWork,
    input: {
      orderId: number;
      previousVersion: number;
      nextVersion: number;
      currentUser: CurrentUser;
      clientId: number | null;
      requestId: string;
      sourceIdempotencyKey?: string;
      beforeSnapshot: Record<string, unknown> | null;
      afterSnapshot: Record<string, unknown> | null;
      beforeDetailStatusRows: OrderDetailStatusAuditRow[];
      afterDetailStatusRows: OrderDetailStatusAuditRow[];
    },
  ): Promise<void> {
    const outboxEvents: OrderAutomationSourceOutboxEvent[] = [];
    const outboxSeed = input.sourceIdempotencyKey ?? input.requestId;
    const beforeOrderStatusId = numOrNull(input.beforeSnapshot?.orderStatusId);
    const afterOrderStatusId = numOrNull(input.afterSnapshot?.orderStatusId);

    if (beforeOrderStatusId !== afterOrderStatusId) {
      const beforeStatus = await unitOfWork.loadOrderStatusAuditInfo(beforeOrderStatusId);
      const afterStatus = await unitOfWork.loadOrderStatusAuditInfo(afterOrderStatusId);
      const before = orderStatusAuditJson(beforeOrderStatusId, beforeStatus, input.previousVersion);
      const after = orderStatusAuditJson(afterOrderStatusId, afterStatus, input.nextVersion);

      await unitOfWork.writeStatusAuditEvent({
        action: 'orders.status_change',
        orderId: input.orderId,
        actorUserId: input.currentUser.id,
        actorUsername: input.currentUser.username,
        actorRole: input.currentUser.role,
        clientId: input.clientId,
        requestId: input.requestId,
        statusField: 'orderStatus',
        statusId: afterOrderStatusId,
        statusName: afterStatus?.statusName ?? null,
        statusCode: afterStatus?.statusCode ?? null,
        before,
        after,
        diff: changedDiff(before, after),
        metadata: {
          source: ORDER_SAVE_SOURCE,
          orderId: input.orderId,
          clientId: input.clientId,
          orderStatusId: afterOrderStatusId,
          orderStatusName: afterStatus?.statusName ?? null,
          previousOrderStatusId: beforeOrderStatusId,
          previousOrderStatusName: beforeStatus?.statusName ?? null,
          action: 'order_status_change',
          statusField: 'orderStatus',
          requestId: input.requestId,
        },
      });

      outboxEvents.push({
        eventType: 'order.status_changed',
        orderId: input.orderId,
        clientId: input.clientId,
        actorUserId: input.currentUser.id,
        requestId: input.requestId,
        idempotencyKey: `${outboxSeed}:order.status_changed`,
        sourceIdempotencyKey: input.sourceIdempotencyKey,
        payload: {
          eventType: 'order.status_changed',
          actorUserId: input.currentUser.id,
          requestId: input.requestId,
          entityType: 'order',
          entityId: String(input.orderId),
          orderId: input.orderId,
          clientId: input.clientId,
          orderStatusId: afterOrderStatusId,
          previousOrderStatusId: beforeOrderStatusId,
          action: 'order_status_change',
          scope: { source: 'order-save' },
          idempotencyKey: input.sourceIdempotencyKey ?? input.requestId,
          outboxIdempotencyKey: `${outboxSeed}:order.status_changed`,
        },
      });
    }

    const beforeProductionStatusId = numOrNull(input.beforeSnapshot?.productionStatusId);
    const afterProductionStatusId = numOrNull(input.afterSnapshot?.productionStatusId);
    if (beforeProductionStatusId !== afterProductionStatusId) {
      const beforeStatus = await unitOfWork.loadProductionStatusAuditInfo(beforeProductionStatusId);
      const afterStatus = await unitOfWork.loadProductionStatusAuditInfo(afterProductionStatusId);
      const before = productionStatusAuditJson(
        beforeProductionStatusId,
        beforeStatus,
        input.previousVersion,
        boolOrNull(input.beforeSnapshot?.productionStatusFromDetailsEnabled),
      );
      const after = productionStatusAuditJson(
        afterProductionStatusId,
        afterStatus,
        input.nextVersion,
        boolOrNull(input.afterSnapshot?.productionStatusFromDetailsEnabled),
      );

      await unitOfWork.writeStatusAuditEvent({
        action: 'orders.production_status_change',
        orderId: input.orderId,
        actorUserId: input.currentUser.id,
        actorUsername: input.currentUser.username,
        actorRole: input.currentUser.role,
        clientId: input.clientId,
        requestId: input.requestId,
        statusField: 'productionCurrentStatus',
        statusId: afterProductionStatusId,
        statusName: afterStatus?.statusName ?? null,
        statusCode: afterStatus?.statusCode ?? null,
        before,
        after,
        diff: changedDiff(before, after),
        metadata: {
          source: ORDER_SAVE_SOURCE,
          orderId: input.orderId,
          clientId: input.clientId,
          productionStatusId: afterProductionStatusId,
          productionStatusCode: afterStatus?.statusCode ?? null,
          productionStatusName: afterStatus?.statusName ?? null,
          previousProductionStatusId: beforeProductionStatusId,
          previousProductionStatusCode: beforeStatus?.statusCode ?? null,
          previousProductionStatusName: beforeStatus?.statusName ?? null,
          action: 'production_status_change',
          statusField: 'productionCurrentStatus',
          requestId: input.requestId,
        },
      });

      outboxEvents.push({
        eventType: 'order.production_status_changed',
        orderId: input.orderId,
        clientId: input.clientId,
        actorUserId: input.currentUser.id,
        requestId: input.requestId,
        idempotencyKey: `${outboxSeed}:order.production_status_changed`,
        sourceIdempotencyKey: input.sourceIdempotencyKey,
        payload: {
          eventType: 'order.production_status_changed',
          actorUserId: input.currentUser.id,
          requestId: input.requestId,
          entityType: 'order',
          entityId: String(input.orderId),
          orderId: input.orderId,
          clientId: input.clientId,
          productionStatusId: afterProductionStatusId,
          productionStatusCode: afterStatus?.statusCode ?? null,
          previousProductionStatusId: beforeProductionStatusId,
          previousProductionStatusCode: beforeStatus?.statusCode ?? null,
          action: 'production_status_change',
          scope: { source: 'order-save' },
          idempotencyKey: input.sourceIdempotencyKey ?? input.requestId,
          outboxIdempotencyKey: `${outboxSeed}:order.production_status_changed`,
        },
      });
    }

    const beforeDetailsById = new Map(
      input.beforeDetailStatusRows.map((detail) => [detail.detailId, detail]),
    );
    for (const afterDetail of input.afterDetailStatusRows) {
      const beforeDetail = beforeDetailsById.get(afterDetail.detailId);
      if (!beforeDetail) {
        continue;
      }
      if (beforeDetail.productionStatusId === afterDetail.productionStatusId) {
        continue;
      }

      const before = detailProductionStatusAuditJson(beforeDetail);
      const after = detailProductionStatusAuditJson(afterDetail);
      await unitOfWork.writeStatusAuditEvent({
        action: 'orders.detail_production_status_change',
        orderId: input.orderId,
        detailId: afterDetail.detailId,
        actorUserId: input.currentUser.id,
        actorUsername: input.currentUser.username,
        actorRole: input.currentUser.role,
        clientId: input.clientId,
        requestId: input.requestId,
        statusField: 'productionDetailStage',
        statusId: afterDetail.productionStatusId,
        statusName: afterDetail.productionStatusName,
        statusCode: afterDetail.productionStatusCode,
        before,
        after,
        diff: changedDiff(before, after),
        metadata: {
          source: ORDER_SAVE_SOURCE,
          orderId: input.orderId,
          clientId: input.clientId,
          detailId: afterDetail.detailId,
          detailNumber: afterDetail.detailNumber,
          productionStatusId: afterDetail.productionStatusId,
          productionStatusCode: afterDetail.productionStatusCode,
          productionStatusName: afterDetail.productionStatusName,
          previousProductionStatusId: beforeDetail.productionStatusId,
          previousProductionStatusCode: beforeDetail.productionStatusCode,
          previousProductionStatusName: beforeDetail.productionStatusName,
          action: 'detail_production_status_change',
          statusField: 'productionDetailStage',
          requestId: input.requestId,
        },
      });
    }

    for (const event of outboxEvents) {
      await unitOfWork.enqueueAutomationSourceOutboxEvent(event);
    }

    for (const event of outboxEvents) {
      await unitOfWork.evaluateStatusAutomation({
        eventType: event.eventType,
        origin: 'user',
        orderId: event.orderId,
        actor: input.currentUser,
        requestId: event.requestId,
        sourceIdempotencyKey: event.sourceIdempotencyKey,
      });
    }
  }

  private async emitPaymentCreatedAutomationEvents(
    unitOfWork: OrderWriteUnitOfWork,
    input: {
      orderId: number;
      order: NormalizedSaveOrderDto;
      currentUser: CurrentUser;
      requestId: string;
      sourceIdempotencyKey?: string;
    },
  ): Promise<void> {
    const createdPayments = input.order.payments.filter((payment) => payment.id === undefined);
    if (createdPayments.length === 0) {
      return;
    }

    const existingPaymentsCount = Math.max(0, input.order.payments.length - createdPayments.length);
    for (const [index] of createdPayments.entries()) {
      await unitOfWork.evaluateStatusAutomation({
        eventType: 'payment.created',
        origin: 'user',
        orderId: input.orderId,
        actor: input.currentUser,
        requestId: input.requestId,
        sourceIdempotencyKey: input.sourceIdempotencyKey,
        paymentsCountAfter: existingPaymentsCount + index + 1,
      });
    }
  }

  private attachProjectToOrder(order: OrderDto, projectId: number, projectCode: string): OrderDto {
    return {
      ...order,
      header: { ...order.header, projectId, projectCode },
    };
  }

  private shouldMarkRestoreIdempotencyFailed(error: unknown): boolean {
    return !(
      error instanceof OrderRestoreIdempotencyKeyReusedError ||
      error instanceof OrderRestoreIdempotencyInProgressError ||
      error instanceof OrderRestoreIdempotencyFailedError
    );
  }

  private extractClientVersion(version: unknown, lockedVersion: number): number {
    if ((version === null || version === undefined) && lockedVersion === 0) {
      return 0;
    }

    if (!Number.isInteger(version) || Number(version) < 0) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Order payload validation failed', {
        errors: [{ field: 'version', message: 'version must be a non-negative integer' }],
      });
    }

    return Number(version);
  }

  private requirePermission(
    command: Pick<CreateOrderCommand | UpdateOrderCommand, 'currentUser'>,
    permission: PermissionName,
  ): void {
    if (!this.permissions.canUser(command.currentUser, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
      });
    }
  }

  /**
   * SP3 sheet guards. Runs ONLY when the save touches the sheet path (incoming OR stored
   * sheet id) so legacy orders are untouched. Order: permission → eligibility/no-clear →
   * tx-scoped reference validation → save-context for shadow audit. Returns whether the
   * sheet path is active (drives audit metadata).
   */
  private async enforceSheetGuards(
    unitOfWork: OrderWriteUnitOfWork,
    command: { currentUser: CurrentUser; requestId?: string },
    prepared: PreparedOrderSave,
    stored: StoredSheetSummary,
  ): Promise<boolean> {
    const header = toSheetHeader(prepared.order);
    const details = toSheetDetails(prepared.details);
    const touchesSheet = orderTouchesSheet({
      header,
      details,
      storedHeaderSheetId: stored.headerSheetId,
      storedDetailSheetIds: stored.detailSheetIds,
    });
    if (!touchesSheet) {
      // SECURITY: even a legacy-looking save must not smuggle a shadow material_id with a
      // null sheet id (would forge Variant-A sheet semantics outside the command boundary).
      // Anti-injection runs on EVERY save; the full sheet path (existence/dim/eligibility)
      // stays gated below.
      await unitOfWork.validateNoShadowInjection({ header, details });
      return false;
    }
    // SECURITY: any incoming OR stored sheet id requires sheet_materials.view (FE gating
    // is not a boundary). Reject BEFORE any write.
    this.requirePermission(command, 'sheet_materials.view');
    assertSheetEligibilityAndNoClear({
      eligible: stored.eligible,
      storedHeaderSheetId: stored.headerSheetId,
      storedDetailSheetIds: stored.detailSheetIds,
      header,
      details,
    });
    await unitOfWork.validateSheetReferences({ header, details });
    // VARIANT B: shadow save-context no longer needed — material_id is always NULL for
    // order rows and resolveShadowMaterialId is never called. setSaveContext is retained
    // on the interface as a no-op (dead after shadow removal — delete in follow-up).
    return true;
  }

  private buildSaveMetadata(
    commandName: 'orders.create' | 'orders.update',
    requestId: string | undefined,
    detailSheetMaterialTypeIds?: { before: DetailSheetAuditRef[]; after: DetailSheetAuditRef[] },
    defaultSchedule?: OrderSaveAuditMetadata['defaultSchedule'],
    bazisPanelLinks?: OrderSaveAuditMetadata['bazisPanelLinks'],
  ): OrderSaveAuditMetadata {
    return {
      commandName,
      ...(requestId ? { requestId } : {}),
      ...(detailSheetMaterialTypeIds ? { detailSheetMaterialTypeIds } : {}),
      ...(defaultSchedule ? { defaultSchedule } : {}),
      ...(bazisPanelLinks && bazisPanelLinks.length > 0 ? { bazisPanelLinks } : {}),
    };
  }

  private requireFinancePermissionForPaymentMutations(
    command: Pick<CreateOrderCommand | UpdateOrderCommand, 'currentUser'>,
    order: NormalizedSaveOrderDto,
    lockedOrder?: Pick<LockedOrderRow, 'createdByUserId' | 'managerUserId'>,
  ): void {
    const createsPayment = order.payments.some((payment) => payment.id === undefined);
    const updatesPayment = order.payments.some((payment) => payment.id !== undefined);
    const deletesPayment = (order.deleted.paymentIds?.length ?? 0) > 0;
    const updatesPaymentStatus = order.header.paymentStatusId !== undefined;
    const carriesFinancialFields = orderCarriesFinancialFields(order);

    if (!createsPayment && !updatesPayment && !deletesPayment && !carriesFinancialFields) {
      return;
    }

    this.requirePermission(command, 'orders.view_financials');

    if (createsPayment) {
      this.requirePermission(command, 'payments.create');
    }
    if (updatesPayment || updatesPaymentStatus) {
      this.requirePermission(command, 'payments.update');
    }
    if (deletesPayment) {
      if (
        !lockedOrder ||
        !this.paymentAccessPolicy.canDelete(command.currentUser, {
          paymentId: 0,
          order: {
            createdByUserId: lockedOrder.createdByUserId,
            managerUserId: lockedOrder.managerUserId,
          },
        })
      ) {
        throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
          requiredPermissions: ['payments.delete'],
        });
      }
    }
  }

  private requireUpdateScope(command: Pick<UpdateOrderCommand, 'currentUser'>, order: LockedOrderRow): void {
    if (
      !this.orderAccessPolicy.canUpdate(command.currentUser, {
        orderId: order.orderId,
        createdByUserId: order.createdByUserId,
        managerUserId: order.managerUserId,
      })
    ) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: ['orders.update'],
      });
    }
  }

  private async requireDeletePermission(
    command: Pick<DeleteOrderCommand | RestoreOrderCommand, 'currentUser'>,
    order: {
      orderId: number;
      createdByUserId: string | null;
      managerUserId: string | null;
    },
    onDenied?: () => Promise<void>,
  ): Promise<void> {
    if (
      !this.orderAccessPolicy.canDelete(command.currentUser, {
        orderId: order.orderId,
        createdByUserId: order.createdByUserId,
        managerUserId: order.managerUserId,
      })
    ) {
      if (onDenied) {
        try {
          await onDenied();
        } catch {
          // best-effort: denied-audit sink failures must not mask the 403
        }
      }
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: ['orders.delete'],
      });
    }
  }
}

function orderCarriesFinancialFields(order: NormalizedSaveOrderDto): boolean {
  return (
    order.header.discount !== 0 ||
    order.header.surcharge !== 0 ||
    order.header.paymentStatusId !== undefined ||
    order.header.paymentDate !== undefined ||
    order.details.some((detail) => detail.millingCostPerSqm !== null || detail.detailCost !== null) ||
    order.requirements.some((requirement) => requirement.purchasePrice !== null)
  );
}

export function collectChildReferences(order: NormalizedSaveOrderDto): OrderChildReference[] {
  return [
    ...order.details
      .filter((detail) => detail.id !== undefined)
      .map((detail) => ({ entityType: 'detail' as const, id: detail.id as number })),
    ...order.deleted.detailIds.map((id) => ({ entityType: 'detail' as const, id })),
    ...order.payments
      .filter((payment) => payment.id !== undefined)
      .map((payment) => ({ entityType: 'payment' as const, id: payment.id as number })),
    ...order.deleted.paymentIds.map((id) => ({ entityType: 'payment' as const, id })),
    ...order.workshops
      .filter((workshop) => workshop.id !== undefined)
      .map((workshop) => ({ entityType: 'workshop' as const, id: workshop.id as number })),
    ...order.deleted.workshopIds.map((id) => ({ entityType: 'workshop' as const, id })),
    ...order.requirements
      .filter((requirement) => requirement.id !== undefined)
      .map((requirement) => ({
        entityType: 'requirement' as const,
        id: requirement.id as number,
      })),
    ...order.deleted.requirementIds.map((id) => ({ entityType: 'requirement' as const, id })),
    ...order.dowelingLinks
      .filter((link) => link.id !== undefined)
      .map((link) => ({ entityType: 'dowelingLink' as const, id: link.id as number })),
    ...order.deleted.dowelingLinkIds.map((id) => ({ entityType: 'dowelingLink' as const, id })),
  ];
}
