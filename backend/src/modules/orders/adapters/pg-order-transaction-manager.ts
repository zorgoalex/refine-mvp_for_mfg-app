import { createHash } from 'crypto';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { auditService } from '../../../common/audit/audit.service';
import { computeDiff } from '../../../common/audit/audit-diff';
import { PgOrderReadRepository } from './pg-order-read-repository';
import type {
  DeleteOrderCommand,
  LockedProjectRow,
  LockedOrderRow,
  LockedOrderDeleteRow,
  LockedOrderRestoreRow,
  OrderCreateIdempotencyResult,
  OrderChildReference,
  OrderDetailStatusAuditRow,
  OrderDeleteAuditInput,
  OrderDeleteOutboxInput,
  OrderDeleteIdempotencyResult,
  OrderRestoreAuditInput,
  OrderRestoreIdempotencyResult,
  OrderRestoreOutboxInput,
  OrderSaveAuditEvent,
  OrderStatusAuditEvent,
  OrderStatusAuditInfo,
  OrderAutomationSourceOutboxEvent,
  OrderTransactionManagerPort,
  RestoreOrderCommand,
  ProductionStatusAuditInfo,
  OrderWriteUnitOfWork,
  SaveContext,
  SheetReferenceValidationInput,
  StoredOrderSheetState,
  ReconcileBazisPanelOrderLinksInput,
  BazisPanelOrderLink,
} from '../application/order-transaction.types';
import { evaluateStatusAutomation } from '../../status-automation/application/status-automation-runtime';
import type { StatusAutomationEvent } from '../../status-automation/application/status-automation.types';
// VARIANT B: dead after shadow removal — delete in follow-up
// (shadow-material module retained as a no-op for one release; types removed here)
import {
  validateSheetReferences as validateSheetReferencesShared,
  validateNoShadowInjection as validateNoShadowInjectionShared,
} from '../domain/sheet-order-validation';
import type { DeleteOrderResponseDto, OrderDto, RestoreOrderResponseDto } from '../dto/order.dto';
import type {
  CalculatedOrderDetailDto,
  NormalizedSaveOrderDowelingLinkDto,
  NormalizedSaveOrderHdfDetailDto,
  NormalizedSaveOrderHeaderDto,
  NormalizedSaveOrderPaymentDto,
  NormalizedSaveOrderRequirementDto,
  NormalizedSaveOrderWorkshopDto,
  OrderTotalsDto,
} from '../dto/save-order.dto';
import {
  calculateOrderHdfDetail,
  type OrderHdfConfigInput,
} from '../domain/order-hdf-calculations';
import {
  OrderDeleteIdempotencyFailedError,
  OrderDeleteIdempotencyInProgressError,
  OrderDeleteIdempotencyKeyReusedError,
  OrderNameDuplicateError,
  OrderRestoreIdempotencyFailedError,
  OrderRestoreIdempotencyInProgressError,
  OrderRestoreIdempotencyKeyReusedError,
} from '../errors/order.errors';
import type { SaveOrderDto } from '../dto/save-order.dto';
import {
  ProjectArchivedError,
  ProjectClientMismatchError,
  ProjectNotFoundError,
} from '../../projects/errors/projects.errors';
import { reconcileBazisPanelOrderLinks } from './pg-bazis-panel-order-link-reconciler';

const CHILD_TABLES = {
  detail: { table: 'order_details', pk: 'detail_id' },
  payment: { table: 'payments', pk: 'payment_id' },
  workshop: { table: 'order_workshops', pk: 'order_workshop_id' },
  requirement: { table: 'order_resource_requirements', pk: 'requirement_id' },
  dowelingLink: { table: 'order_doweling_links', pk: 'order_doweling_link_id' },
} as const;

const SOURCE = 'backend-orders-command';
const STALE_PROCESSING_MS = 10 * 60 * 1000;

interface IdempotencyRow {
  idempotency_key: string;
  request_hash: string;
  response_json: OrderDto | DeleteOrderResponseDto | RestoreOrderResponseDto | string | null;
  status: string;
  created_at?: string | Date | null;
}

interface LockedOrderDeleteDbRow {
  order_id: string | number;
  order_name: string;
  client_id: string | number | null;
  version: string | number;
  created_by: string | number | null;
  manager_id: string | number | null;
}

interface LockedOrderRestoreDbRow extends LockedOrderDeleteDbRow {
  delete_flag: boolean;
  deleted_at: string | Date | null;
  deleted_by: string | number | null;
}

interface AuditRow {
  audit_id: string;
}

interface OrderStatusAuditInfoRow {
  order_status_id: string | number;
  order_status_name: string;
}

interface ProductionStatusAuditInfoRow {
  production_status_id: string | number;
  production_status_name: string;
  production_status_code: string | null;
}

interface OrderDetailStatusAuditDbRow {
  detail_id: string | number;
  detail_number: string | number | null;
  production_status_id: string | number | null;
  production_status_name: string | null;
  production_status_code: string | null;
}

interface HdfConfigRow {
  threshold_mm: string | number | null;
  hdf_sheet_material_type_id: string | number | null;
  hdf_sheet_material_name: string | null;
  config_revision: string | number;
}

interface HdfSourceRow {
  detail_id: string | number;
  detail_number: string | number | null;
  detail_name: string | null;
  height: string | number | null;
  width: string | number | null;
  quantity: string | number | null;
  sheet_material_type_id: string | number | null;
  sheet_material_name: string | null;
  milling_type_id: string | number | null;
  milling_type_name: string | null;
  hdf_enabled: boolean | null;
  hdf_edge_mm: string | number | null;
  hdf_parameter_override_mm: string | number | null;
  production_status_id: string | number | null;
}

interface ExistingHdfRow {
  order_hdf_detail_id: string | number;
  source_order_detail_id: string | number | null;
  source_order_detail_id_snapshot: string | number;
  source_snapshot_hash: string;
  config_revision: string | number;
  status: string;
  production_status_id: string | number | null;
  production_status_locked: boolean;
  has_cut_link: boolean;
  has_bazis_link: boolean;
}

interface HdfStatusEditRow {
  order_hdf_detail_id: string | number;
  version: string | number;
  production_status_id: string | number | null;
}

export class PgOrderTransactionManager implements OrderTransactionManagerPort {
  // SP3: sheetOrdersReads (BACKEND_SHEET_ORDERS_READS, default false in the module) gates
  // the migration-029 sheet columns in the post-save read-back so saves work pre-migration.
  constructor(
    private readonly database: DatabaseService,
    private readonly sheetOrdersReads: boolean = true,
  ) {}

  runInTransaction<T>(handler: (unitOfWork: OrderWriteUnitOfWork) => Promise<T>): Promise<T> {
    return this.database.transaction((tx) =>
      handler(new PgOrderWriteUnitOfWork(tx, this.database, this.sheetOrdersReads)),
    );
  }

  reserveOrderRestoreIdempotency(
    command: RestoreOrderCommand,
  ): Promise<OrderRestoreIdempotencyResult> {
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT set_session_user($1)', [command.currentUser.id]);
      return reserveOrderRestoreIdempotency(tx, command);
    });
  }

  markOrderRestoreIdempotencyFailed(command: RestoreOrderCommand): Promise<void> {
    return this.database
      .transaction(async (tx) => {
        await tx.query('SELECT set_session_user($1)', [command.currentUser.id]);
        await markOrderRestoreIdempotencyFailed(tx, command.idempotencyKey);
      })
      .then(() => undefined);
  }
}

class PgOrderWriteUnitOfWork implements OrderWriteUnitOfWork {
  // VARIANT B: dead after shadow removal — delete in follow-up
  private saveContext: SaveContext | null = null;

  constructor(
    private readonly tx: TransactionClient,
    private readonly database: DatabaseService,
    private readonly sheetOrdersReads: boolean = true,
  ) {}

  getTransactionClient(): TransactionClient {
    return this.tx;
  }

  // VARIANT B: dead after shadow removal — delete in follow-up (no-op; no longer read by upsertDetails)
  setSaveContext(context: SaveContext): void {
    this.saveContext = context;
  }

  async loadStoredOrderSheetState(orderId: number): Promise<StoredOrderSheetState> {
    const header = await this.tx.query<{
      sheet_material_type_id: number | string | null;
      sheet_eligible: boolean | null;
    }>(
      `SELECT sheet_material_type_id, sheet_eligible FROM orders
        WHERE order_id = $1 AND order_kind = 'production_order'`,
      [orderId],
    );
    const details = await this.tx.query<{
      detail_id: number | string;
      sheet_material_type_id: number | string | null;
    }>(
      `SELECT detail_id, sheet_material_type_id FROM order_details
        WHERE order_id = $1 AND delete_flag = false`,
      [orderId],
    );
    return {
      sheetEligible: header.rows[0]?.sheet_eligible === true,
      headerSheetMaterialTypeId:
        header.rows[0]?.sheet_material_type_id == null
          ? null
          : Number(header.rows[0].sheet_material_type_id),
      detailSheetIds: details.rows.map((row) => ({
        detailId: Number(row.detail_id),
        sheetMaterialTypeId:
          row.sheet_material_type_id == null ? null : Number(row.sheet_material_type_id),
      })),
    };
  }

  async validateSheetReferences(input: SheetReferenceValidationInput): Promise<void> {
    await validateSheetReferencesShared(this.tx, input.header, input.details);
  }

  async validateNoShadowInjection(input: SheetReferenceValidationInput): Promise<void> {
    await validateNoShadowInjectionShared(this.tx, input.header, input.details);
  }

  async setSessionUser(userId: string): Promise<void> {
    await this.tx.query('SELECT set_session_user($1)', [userId]);
  }

  async resolveProjectForCreate(input: {
    projectId: number | null;
    clientId: number;
    orderName: string;
    currentUser: CurrentUser;
    requestId: string;
  }) {
    if (input.projectId !== null) {
      const result = await this.tx.query<{
        project_id: string | number;
        client_id: string | number;
        delete_flag: boolean;
        code: string;
      }>(
        `
        SELECT project_id, client_id, delete_flag, code
        FROM projects
        WHERE project_id = $1
        FOR UPDATE
        `,
        [input.projectId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new ProjectNotFoundError(input.projectId);
      }
      if (row.delete_flag) {
        throw new ProjectArchivedError(input.projectId);
      }
      if (Number(row.client_id) !== input.clientId) {
        throw new ProjectClientMismatchError();
      }

      return {
        projectId: Number(row.project_id),
        created: false,
        code: row.code,
      };
    }

    return insertAutoRoot(this.tx, {
      orderName: input.orderName,
      clientId: input.clientId,
      currentUser: input.currentUser,
      requestId: input.requestId,
    });
  }

  async reconcileOrderCreateIdempotency(input: {
    idempotencyKey: string;
    currentUser: CurrentUser;
    dto: SaveOrderDto;
  }): Promise<OrderCreateIdempotencyResult> {
    return reconcileOrderCreateIdempotency(this.tx, input);
  }

  async completeOrderCreateIdempotency(idempotencyKey: string, response: OrderDto): Promise<void> {
    await completeOrderCreateIdempotency(this.tx, idempotencyKey, response);
  }

  async reconcileOrderDeleteIdempotency(
    command: DeleteOrderCommand,
  ): Promise<OrderDeleteIdempotencyResult> {
    return reconcileOrderDeleteIdempotency(this.tx, command);
  }

  async completeOrderDeleteIdempotency(
    idempotencyKey: string,
    response: DeleteOrderResponseDto,
  ): Promise<void> {
    await completeOrderDeleteIdempotency(this.tx, idempotencyKey, response);
  }

  async completeOrderRestoreIdempotency(
    idempotencyKey: string,
    response: RestoreOrderResponseDto,
  ): Promise<void> {
    await completeOrderRestoreIdempotency(this.tx, idempotencyKey, response);
  }

  async peekOrderName(orderId: number): Promise<string | null> {
    const result = await this.tx.query<{ order_name: string }>(
      `
      SELECT order_name
      FROM orders
      WHERE order_id = $1 AND order_kind = 'production_order'
      `,
      [orderId],
    );
    return result.rows[0] ? String(result.rows[0].order_name) : null;
  }

  async lockOrderName(orderName: string): Promise<void> {
    // Advisory xact lock по нормализованному имени: два конкурентных сохранения
    // одного номера сериализуются, второй видит первого после его коммита.
    // Хэш-коллизия имён лишь добавляет ложную сериализацию — корректность цела.
    await this.tx.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('order_name:' || normalize_order_name($1), 0))`,
      [orderName],
    );
  }

  async assertOrderNameAvailable(input: { orderName: string; excludeOrderId?: number }): Promise<void> {
    if (input.excludeOrderId !== undefined) {
      const current = await this.tx.query<{
        legacy_duplicate_name_exempt: boolean;
        same_normalized_name: boolean;
      }>(
        `
        SELECT legacy_duplicate_name_exempt,
               normalize_order_name(order_name) = normalize_order_name($2) AS same_normalized_name
        FROM orders
        WHERE order_id = $1
          AND order_kind = 'production_order'
        `,
        [input.excludeOrderId, input.orderName],
      );
      const currentRow = current.rows[0];
      if (currentRow?.legacy_duplicate_name_exempt && currentRow.same_normalized_name) {
        return;
      }
    }

    const duplicate = await this.tx.query<{ order_id: string | number; order_name: string }>(
      `
      SELECT order_id, order_name
      FROM orders
      WHERE normalize_order_name(order_name) = normalize_order_name($1)
        AND delete_flag = false
        AND order_kind = 'production_order'
        AND ($2::bigint IS NULL OR order_id <> $2)
      ORDER BY order_id
      LIMIT 1
      `,
      [input.orderName, input.excludeOrderId ?? null],
    );
    const row = duplicate.rows[0];
    const reserved = row
      ? null
      : await this.tx.query<{ order_id: string | number }>(
          `
          SELECT MIN(ledger.order_id) AS order_id
          FROM order_legacy_duplicate_name_registry registry
          JOIN order_legacy_duplicate_name_ledger ledger
            ON ledger.normalized_name = registry.normalized_name
          WHERE registry.normalized_name = normalize_order_name($1)
          GROUP BY registry.normalized_name
          `,
          [input.orderName],
        );
    const reservedRow = reserved?.rows[0];
    if (!row && !reservedRow) {
      return;
    }

    // Подсказка следующего номера — только продакшн-эпоха нумерации
    // (order_date >= 2025-12-01, решение пользователя 2026-07-13): легаси-имена
    // вида 230725 (до go-live) не должны задирать серию. Сама проверка
    // занятости выше НЕ фильтруется по дате — легаси-номер переиспользовать нельзя.
    const suggestion = await this.tx.query<{ next: string | null }>(
      `
      SELECT (COALESCE(MAX(order_name::bigint), 0) + 1)::text AS next
      FROM orders
      WHERE order_name ~ '^\\d{1,15}$'
        AND delete_flag = false
        AND order_kind = 'production_order'
        AND order_date >= DATE '2025-12-01'
      `,
    );
    throw new OrderNameDuplicateError({
      existingOrderId: Number(row?.order_id ?? reservedRow!.order_id),
      orderName: input.orderName.trim(),
      suggestedOrderName: suggestion.rows[0]?.next ?? null,
    });
  }

  async loadOrderForRestore(orderId: number): Promise<LockedOrderRestoreRow | null> {
    const result = await this.tx.query<LockedOrderRestoreDbRow>(
      `
      SELECT order_id, order_name, client_id, version, created_by, manager_id,
             delete_flag, deleted_at, deleted_by
      FROM orders
      WHERE order_id = $1 AND order_kind = 'production_order'
      FOR UPDATE
      `,
      [orderId],
    );
    const row = result.rows[0];

    return row
      ? {
          orderId: Number(row.order_id),
          orderName: String(row.order_name),
          clientId: row.client_id === null ? null : Number(row.client_id),
          version: Number(row.version),
          createdByUserId: toNullableString(row.created_by),
          managerUserId: toNullableString(row.manager_id),
          deleteFlag: Boolean(row.delete_flag),
          deletedAt: row.deleted_at === null ? null : new Date(row.deleted_at).toISOString(),
          deletedBy: toNullableString(row.deleted_by),
        }
      : null;
  }

  async recordOrderRestoreDenied(input: {
    currentUser: CurrentUser;
    orderId: number;
    requestId: string;
  }): Promise<void> {
    await auditService.recordDenied(this.database, {
      event: 'orders.restore',
      entityType: 'order',
      entityId: String(input.orderId),
      actorUserId: input.currentUser.id,
      actorUsername: input.currentUser.username ?? null,
      actorRole: input.currentUser.role ?? null,
      requestId: input.requestId,
      source: SOURCE,
      relatedOrderId: input.orderId,
      reason: 'PERMISSION_DENIED',
      requiredPermissions: ['orders.delete'],
    });
  }

  async loadOrderForUpdate(orderId: number): Promise<LockedOrderRow | null> {
    const result = await this.tx.query<{
      order_id: string | number;
      order_name: string;
      version: string | number;
      created_by: string | number | null;
      manager_id: string | number | null;
    }>(
      `
      SELECT order_id, order_name, version, created_by, manager_id
      FROM orders
      WHERE order_id = $1 AND delete_flag = false
        AND order_kind = 'production_order'
      FOR UPDATE
      `,
      [orderId],
    );
    const row = result.rows[0];

    return row
      ? {
          orderId: Number(row.order_id),
          orderName: row.order_name,
          version: Number(row.version),
          createdByUserId: toNullableString(row.created_by),
          managerUserId: toNullableString(row.manager_id),
        }
      : null;
  }

  async loadOrderForDelete(orderId: number): Promise<LockedOrderDeleteRow | null> {
    const result = await this.tx.query<LockedOrderDeleteDbRow>(
      `
      SELECT order_id, order_name, client_id, version, created_by, manager_id
      FROM orders
      WHERE order_id = $1 AND delete_flag = false
        AND order_kind = 'production_order'
      FOR UPDATE
      `,
      [orderId],
    );
    const row = result.rows[0];

    return row
      ? {
          orderId: Number(row.order_id),
          orderName: row.order_name,
          clientId: row.client_id === null ? null : Number(row.client_id),
          version: Number(row.version),
          createdByUserId: toNullableString(row.created_by),
          managerUserId: toNullableString(row.manager_id),
        }
      : null;
  }

  async readOrderClientProject(
    orderId: number,
  ): Promise<{ clientId: number | null; projectId: number } | null> {
    const result = await this.tx.query<{
      client_id: string | number | null;
      project_id: string | number;
    }>(
      `
      SELECT client_id, project_id
      FROM orders
      WHERE order_id = $1 AND delete_flag = false
        AND order_kind = 'production_order'
      `,
      [orderId],
    );
    const row = result.rows[0];
    return row
      ? {
          clientId: row.client_id === null ? null : Number(row.client_id),
          projectId: Number(row.project_id),
        }
      : null;
  }

  async lockProjectById(projectId: number): Promise<void> {
    await this.tx.query(
      `
      SELECT project_id
      FROM projects
      WHERE project_id = $1
      FOR UPDATE
      `,
      [projectId],
    );
  }

  async lockProjectForOrder(orderId: number): Promise<LockedProjectRow> {
    const result = await this.tx.query<{
      project_id: string | number;
      client_id: string | number;
      code: string;
    }>(
      `
      SELECT p.project_id, p.client_id, p.code
      FROM projects p
      JOIN orders o USING (project_id)
      WHERE o.order_id = $1 AND o.order_kind = 'production_order'
      FOR UPDATE
      `,
      [orderId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new ApiError(500, 'ORDER_PROJECT_NOT_FOUND', 'Не найден проект заказа');
    }

    return {
      projectId: Number(row.project_id),
      clientId: Number(row.client_id),
      code: row.code,
    };
  }

  async countOrdersInProject(projectId: number): Promise<number> {
    const result = await this.tx.query<{ count: string | number }>(
      `
      -- ВСЕ заказы, включая soft-deleted: composite FK ON UPDATE CASCADE при retarget
      -- перезаписал бы client_id и архивным заказам — deleted удерживают клиента корня.
      SELECT COUNT(*)::int AS count
      FROM orders
      WHERE project_id = $1 AND order_kind = 'production_order'
      `,
      [projectId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async retargetProjectClient(
    projectId: number,
    clientId: number,
    currentUser: CurrentUser,
    requestId?: string,
  ): Promise<void> {
    const beforeResult = await this.tx.query<{
      client_id: string | number;
      code: string;
      version: string | number;
    }>(
      `
      SELECT client_id, code, version
      FROM projects
      WHERE project_id = $1
      FOR UPDATE
      `,
      [projectId],
    );
    const before = beforeResult.rows[0];
    if (!before) {
      throw new ProjectNotFoundError(projectId);
    }

    await this.tx.query(
      `
      UPDATE projects
      SET client_id = $2,
          version = version + 1,
          edited_by = $3,
          updated_at = now()
      WHERE project_id = $1
      `,
      [projectId, clientId, Number(currentUser.id)],
    );

    await auditService.record(this.tx, {
      event: 'project.updated',
      entityType: 'project',
      entityId: projectId,
      actorUserId: currentUser.id,
      actorUsername: currentUser.username,
      actorRole: currentUser.role,
      requestId: requestId ?? 'orders-update-project-retarget',
      source: SOURCE,
      relatedClientId: clientId,
      before: { projectId, clientId: Number(before.client_id), code: before.code },
      after: { projectId, clientId, code: before.code },
      diff: {
        clientId: { from: Number(before.client_id), to: clientId },
        version: { from: Number(before.version), to: Number(before.version) + 1 },
      },
      metadata: {
        action: 'project_client_retarget',
        projectId,
      },
      relatedEntities: [
        { entityType: 'project', entityId: projectId },
        { entityType: 'client', entityId: clientId },
      ],
    });
  }

  async loadOrderHeaderSnapshot(orderId: number): Promise<Record<string, unknown> | null> {
    const result = await this.tx.query<Record<string, unknown>>(
      `
      SELECT order_name AS "orderName", client_id AS "clientId", project_id AS "projectId",
             (SELECT code FROM projects WHERE project_id = orders.project_id) AS "projectCode",
             order_date AS "orderDate",
             priority, manager_id AS "managerId", order_status_id AS "orderStatusId",
             production_status_id AS "productionStatusId",
             planned_completion_date AS "plannedCompletionDate",
             completion_date AS "completionDate", issue_date AS "issueDate",
             discount, surcharge, total_amount AS "totalAmount", final_amount AS "finalAmount",
             link_cutting_file AS "linkCuttingFile",
             link_cutting_image_file AS "linkCuttingImageFile",
             link_cad_file AS "linkCadFile", link_pdf_file AS "linkPdfFile",
             notes, material_id AS "materialId", milling_type_id AS "millingTypeId",
             edge_type_id AS "edgeTypeId", film_id AS "filmId", ref_key_1c AS "refKey1c",
             sheet_material_type_id AS "sheetMaterialTypeId", sheet_eligible AS "sheetEligible",
             hdf_min_threshold_mm AS "hdfMinThresholdMm"
      FROM orders
      WHERE order_id = $1 AND order_kind = 'production_order'
      `,
      [orderId],
    );
    return result.rows[0] ?? null;
  }

  async loadOrderStatusAuditInfo(statusId: number | null): Promise<OrderStatusAuditInfo | null> {
    if (statusId === null) {
      return null;
    }

    const result = await this.tx.query<OrderStatusAuditInfoRow>(
      `
      SELECT order_status_id, order_status_name
      FROM order_statuses
      WHERE order_status_id = $1
      `,
      [statusId],
    );
    const row = result.rows[0];
    return row
      ? {
          statusId: Number(row.order_status_id),
          statusName: row.order_status_name,
          statusCode: null,
        }
      : null;
  }

  async loadProductionStatusAuditInfo(
    statusId: number | null,
  ): Promise<ProductionStatusAuditInfo | null> {
    if (statusId === null) {
      return null;
    }

    const result = await this.tx.query<ProductionStatusAuditInfoRow>(
      `
      SELECT production_status_id, production_status_name, production_status_code
      FROM production_statuses
      WHERE production_status_id = $1
      `,
      [statusId],
    );
    const row = result.rows[0];
    return row
      ? {
          statusId: Number(row.production_status_id),
          statusName: row.production_status_name,
          statusCode: row.production_status_code,
        }
      : null;
  }

  async loadOrderDetailStatusAuditRows(orderId: number): Promise<OrderDetailStatusAuditRow[]> {
    const result = await this.tx.query<OrderDetailStatusAuditDbRow>(
      `
      SELECT od.detail_id,
             od.detail_number,
             od.production_status_id,
             ps.production_status_name,
             ps.production_status_code
      FROM order_details od
      LEFT JOIN production_statuses ps ON ps.production_status_id = od.production_status_id
      WHERE od.order_id = $1
        AND od.delete_flag = false
      ORDER BY od.detail_id
      `,
      [orderId],
    );

    return result.rows.map((row) => ({
      detailId: Number(row.detail_id),
      detailNumber: row.detail_number === null ? null : Number(row.detail_number),
      productionStatusId:
        row.production_status_id === null ? null : Number(row.production_status_id),
      productionStatusName: row.production_status_name,
      productionStatusCode: row.production_status_code,
    }));
  }

  async assertChildOwnership(
    orderId: number,
    refs: readonly OrderChildReference[],
  ): Promise<void> {
    for (const [entityType, ids] of groupChildReferences(refs)) {
      if (ids.length === 0) {
        continue;
      }

      const table = CHILD_TABLES[entityType];
      const activeRowPredicate = entityType === 'detail' ? ' AND delete_flag = false' : '';
      const result = await this.tx.query<{ count: string | number }>(
        `
        SELECT COUNT(*)::int AS count
        FROM ${table.table}
        WHERE ${table.pk} = ANY($1::bigint[]) AND order_id = $2${activeRowPredicate}
        `,
        [ids, orderId],
      );

      if (Number(result.rows[0]?.count ?? 0) !== ids.length) {
        throw new ApiError(422, 'CHILD_ENTITY_NOT_OWNED', 'Child entity does not belong to order', {
          entityType,
          orderId,
        });
      }
    }
  }

  async createOrderHeader(input: {
    header: NormalizedSaveOrderHeaderDto;
    totals: OrderTotalsDto;
    projectId: number;
    currentUser: CurrentUser;
  }): Promise<number> {
    const result = await this.tx.query<{ order_id: string | number }>(
      `
      INSERT INTO orders (
        order_name, client_id, order_date, priority, manager_id,
        order_status_id, payment_status_id, production_status_id,
        production_status_from_details_enabled,
        planned_completion_date, completion_date, issue_date, payment_date,
        discount, surcharge, total_amount, final_amount, paid_amount, parts_count, total_area,
        link_cutting_file, link_cutting_image_file, link_cad_file, link_pdf_file,
        notes, material_id, milling_type_id, edge_type_id, film_id, ref_key_1c,
        sheet_material_type_id, hdf_min_threshold_mm, project_id, version
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8,
        $9,
        $10, $11, $12, $13,
        $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23, $24,
        $25, $26, $27, $28, $29, $30, $31, $32, $33, 1
      )
      RETURNING order_id
      `,
      [
        input.header.orderName,
        input.header.clientId,
        input.header.orderDate,
        input.header.priority,
        input.header.managerId ?? Number(input.currentUser.id),
        input.header.orderStatusId,
        input.totals.paymentStatusId,
        input.header.productionStatusId ?? null,
        true,
        input.header.plannedCompletionDate ?? null,
        input.header.completionDate ?? null,
        input.header.issueDate ?? null,
        input.totals.paymentDate,
        input.totals.discount,
        input.totals.surcharge,
        input.totals.totalAmount,
        input.totals.finalAmount,
        input.totals.paidAmount,
        input.totals.partsCount,
        input.totals.totalArea,
        input.header.linkCuttingFile ?? null,
        input.header.linkCuttingImageFile ?? null,
        input.header.linkCadFile ?? null,
        input.header.linkPdfFile ?? null,
        input.header.notes ?? null,
        // VARIANT B: orders.material_id is always NULL (chk_orders_material_id_null holds).
        null,
        input.header.millingTypeId ?? null,
        input.header.edgeTypeId ?? null,
        input.header.filmId ?? null,
        input.header.refKey1c ?? null,
        input.header.sheetMaterialTypeId ?? null,
        input.header.hdfMinThresholdMm ?? null,
        input.projectId,
      ],
    );

    return Number(result.rows[0].order_id);
  }

  async updateOrderHeader(input: {
    orderId: number;
    header: NormalizedSaveOrderHeaderDto;
    totals: OrderTotalsDto;
    currentUser: CurrentUser;
  }): Promise<void> {
    // production_status_id is derived from order_details after child persistence; do not write
    // the stale form snapshot here.
    await this.tx.query(
      `
      UPDATE orders
      SET order_name = $2,
          client_id = $3,
          order_date = $4,
          priority = $5,
          manager_id = $6,
          order_status_id = $7,
          planned_completion_date = $8,
          completion_date = $9,
          issue_date = $10,
          discount = $11,
          surcharge = $12,
          total_amount = $13,
          final_amount = $14,
          link_cutting_file = $15,
          link_cutting_image_file = $16,
          link_cad_file = $17,
          link_pdf_file = $18,
          notes = $19,
          material_id = $20,
          milling_type_id = $21,
          edge_type_id = $22,
          film_id = $23,
          ref_key_1c = $24,
          sheet_material_type_id = $25,
          hdf_min_threshold_mm = $26
      WHERE order_id = $1 AND delete_flag = false
      `,
      [
        input.orderId,
        input.header.orderName,
        input.header.clientId,
        input.header.orderDate,
        input.header.priority,
        input.header.managerId ?? Number(input.currentUser.id),
        input.header.orderStatusId,
        input.header.plannedCompletionDate ?? null,
        input.header.completionDate ?? null,
        input.header.issueDate ?? null,
        input.totals.discount,
        input.totals.surcharge,
        input.totals.totalAmount,
        input.totals.finalAmount,
        input.header.linkCuttingFile ?? null,
        input.header.linkCuttingImageFile ?? null,
        input.header.linkCadFile ?? null,
        input.header.linkPdfFile ?? null,
        input.header.notes ?? null,
        // VARIANT B: orders.material_id is always NULL (chk_orders_material_id_null holds).
        null,
        input.header.millingTypeId ?? null,
        input.header.edgeTypeId ?? null,
        input.header.filmId ?? null,
        input.header.refKey1c ?? null,
        input.header.sheetMaterialTypeId ?? null,
        input.header.hdfMinThresholdMm ?? null,
      ],
    );
  }

  async upsertDetails(orderId: number, details: readonly CalculatedOrderDetailDto[]): Promise<void> {
    for (const detail of details) {
      // VARIANT B: order details reference their material solely via
      // sheet_material_type_id. material_id is always NULL for order rows.
      const effective: CalculatedOrderDetailDto = { ...detail, materialId: null };

      if (effective.id) {
        await this.tx.query(
          `
          UPDATE order_details
          SET detail_number = $3, detail_name = $4, height = $5, width = $6, quantity = $7,
              area = $8, material_id = $9, milling_type_id = $10, edge_type_id = $11,
              film_id = $12, milling_cost_per_sqm = $13, detail_cost = $14, priority = $15,
              production_status_id = $16, joint_order_id = $17, note = $18,
              link_cutting_file = $19, link_cutting_image_file = $20, link_cad_file = $21,
              link_pdf_file = $22, ref_key_1c = $23, sheet_material_type_id = $24,
              hdf_parameter_override_mm = $25, basis_project = $26, basis_data = $27,
              basis_designation = $28, basis_product = $29, doweling = $30
          WHERE detail_id = $1 AND order_id = $2 AND delete_flag = false
          `,
          detailParams(effective.id, orderId, effective),
        );
      } else {
        const inserted = await this.tx.query<{ detail_id: string | number }>(
          `
          INSERT INTO order_details (
            order_id, detail_number, detail_name, height, width, quantity, area,
            material_id, milling_type_id, edge_type_id, film_id, milling_cost_per_sqm,
            detail_cost, priority, production_status_id, joint_order_id, note,
            link_cutting_file, link_cutting_image_file, link_cad_file, link_pdf_file, ref_key_1c,
            sheet_material_type_id, hdf_parameter_override_mm, basis_project, basis_data,
            basis_designation, basis_product, doweling
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29)
          RETURNING detail_id
          `,
          detailParamsForInsert(orderId, effective),
        );
        detail.id = Number(inserted.rows[0]?.detail_id);
      }
    }
  }

  async deleteDetails(orderId: number, ids: readonly number[]): Promise<void> {
    await softDeleteByIds(this.tx, 'order_details', 'detail_id', 'delete_flag', true, orderId, ids);
  }

  async applyHdfStatusEdits(input: {
    orderId: number;
    edits: readonly NormalizedSaveOrderHdfDetailDto[];
    currentUser: CurrentUser;
    requestId?: string;
  }): Promise<void> {
    if (input.edits.length === 0) return;
    for (const edit of input.edits) {
      const before = await this.tx.query<HdfStatusEditRow>(
        `
        SELECT order_hdf_detail_id, version, production_status_id
        FROM order_hdf_details
        WHERE order_hdf_detail_id = $1 AND order_id = $2 AND delete_flag = false
        FOR UPDATE
        `,
        [edit.id, input.orderId],
      );
      const row = before.rows[0];
      if (!row) {
        throw new ApiError(422, 'HDF_DETAIL_NOT_FOUND', 'HDF detail does not belong to order', {
          orderId: input.orderId,
          hdfDetailId: edit.id,
        });
      }
      const currentVersion = Number(row.version);
      if (currentVersion !== edit.version) {
        throw new ApiError(409, 'HDF_DETAIL_VERSION_CONFLICT', 'HDF detail was changed by another command', {
          hdfDetailId: edit.id,
          expectedVersion: edit.version,
          currentVersion,
        });
      }
      const previousStatusId = toNullableNumber(row.production_status_id);
      if (previousStatusId === edit.productionStatusId) {
        continue;
      }
      await this.tx.query(
        `
        UPDATE order_hdf_details
        SET production_status_id = $3,
            production_status_locked = true,
            edited_by = $4,
            updated_at = now(),
            version = version + 1
        WHERE order_hdf_detail_id = $1 AND order_id = $2 AND version = $5
        `,
        [
          edit.id,
          input.orderId,
          edit.productionStatusId,
          actorUserId(input.currentUser),
          edit.version,
        ],
      );
      await auditService.record(this.tx, {
        event: 'orders.hdf_detail_production_status_change',
        entityType: 'order_hdf_detail',
        entityId: edit.id,
        actorUserId: input.currentUser.id,
        actorUsername: input.currentUser.username,
        actorRole: input.currentUser.role,
        requestId: input.requestId ?? 'orders-hdf-status',
        source: SOURCE,
        relatedOrderId: input.orderId,
        before: { hdfDetailId: edit.id, productionStatusId: previousStatusId, version: currentVersion },
        after: { hdfDetailId: edit.id, productionStatusId: edit.productionStatusId, version: currentVersion + 1 },
        diff: {
          productionStatusId: { before: previousStatusId, after: edit.productionStatusId },
          version: { before: currentVersion, after: currentVersion + 1 },
        },
        metadata: { action: 'hdf_detail_production_status_change', orderId: input.orderId, hdfDetailId: edit.id },
        relatedEntities: [
          { entityType: 'order', entityId: input.orderId },
          { entityType: 'order_hdf_detail', entityId: edit.id },
        ],
      });
    }
  }

  async deleteHdfDetails(orderId: number, ids: readonly number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.tx.query(
      `
      UPDATE order_hdf_details
      SET delete_flag = true,
          deleted_at = now(),
          updated_at = now(),
          version = version + 1
      WHERE order_hdf_detail_id = ANY($1::bigint[])
        AND order_id = $2
        AND delete_flag = false
        AND NOT EXISTS (
          SELECT 1 FROM cut_job_item cji
          WHERE cji.order_hdf_detail_id = order_hdf_details.order_hdf_detail_id
            AND cji.is_active = true
        )
        AND NOT EXISTS (
          SELECT 1 FROM bazis_cut_set_details b
          WHERE b.source_order_hdf_detail_id = order_hdf_details.order_hdf_detail_id
        )
      `,
      [ids, orderId],
    );
  }

  async reconcileHdfDetails(input: {
    orderId: number;
    currentUser: CurrentUser;
    requestId?: string;
  }) {
    const config = await loadHdfConfig(this.tx, input.orderId);
    const sources = await loadHdfSourceRows(this.tx, input.orderId);
    const existing = await loadExistingHdfRows(this.tx, input.orderId);
    const existingBySource = new Map<number, ExistingHdfRow>();
    for (const row of existing) {
      const sourceId = toNullableNumber(row.source_order_detail_id);
      if (sourceId !== null) existingBySource.set(sourceId, row);
    }

    const seenSourceIds = new Set<number>();
    const createdHdfDetailIds: number[] = [];
    const updatedHdfDetailIds: number[] = [];
    const deactivatedHdfDetailIds: number[] = [];
    const sourceChangedHdfDetailIds: number[] = [];
    const configMissingHdfDetailIds: number[] = [];
    const statusCounts: Record<string, number> = {};

    for (const source of sources) {
      const sourceId = Number(source.detail_id);
      seenSourceIds.add(sourceId);
      const calculated = calculateOrderHdfDetail(
        {
          detailId: sourceId,
          detailNumber: toNullableNumber(source.detail_number),
          detailName: source.detail_name,
          heightMm: toNullableNumber(source.height),
          widthMm: toNullableNumber(source.width),
          quantity: toNullableNumber(source.quantity),
          sheetMaterialTypeId: toNullableNumber(source.sheet_material_type_id),
          sheetMaterialName: source.sheet_material_name,
          millingTypeId: toNullableNumber(source.milling_type_id),
          millingTypeName: source.milling_type_name,
          hdfParameterOverrideMm: toNullableNumber(source.hdf_parameter_override_mm),
          productionStatusId: toNullableNumber(source.production_status_id),
        },
        {
          hdfEnabled: source.hdf_enabled === true,
          hdfEdgeMm: toNullableNumber(source.hdf_parameter_override_mm) ?? toNullableNumber(source.hdf_edge_mm),
        },
        config,
      );
      statusCounts[calculated.status] = (statusCounts[calculated.status] ?? 0) + 1;
      const current = existingBySource.get(sourceId);
      const shouldPersist = calculated.status !== 'disabled' || current !== undefined;
      if (!shouldPersist) continue;

      if (!current) {
        const inserted = await insertHdfDetail(this.tx, input, source, calculated, config);
        createdHdfDetailIds.push(inserted);
        if (calculated.status === 'config_missing') configMissingHdfDetailIds.push(inserted);
        continue;
      }

      const hdfId = Number(current.order_hdf_detail_id);
      const hasLinks = current.has_cut_link || current.has_bazis_link;
      if (hasLinks && current.source_snapshot_hash !== calculated.sourceSnapshotHash) {
        await markHdfSourceChanged(this.tx, hdfId, input.currentUser, calculated);
        sourceChangedHdfDetailIds.push(hdfId);
        statusCounts.source_changed = (statusCounts.source_changed ?? 0) + 1;
        continue;
      }

      if (calculated.status === 'disabled') {
        await softDeleteHdfRow(this.tx, hdfId, input.currentUser);
        deactivatedHdfDetailIds.push(hdfId);
        continue;
      }

      const sourceProductionStatusId = toNullableNumber(source.production_status_id);
      const currentProductionStatusId = toNullableNumber(current.production_status_id);
      const productionStatusChanged = current.production_status_locked !== true
        && currentProductionStatusId !== sourceProductionStatusId;
      const changed = current.source_snapshot_hash !== calculated.sourceSnapshotHash
        || Number(current.config_revision) !== calculated.configRevision
        || current.status !== calculated.status
        || productionStatusChanged;
      if (changed) {
        await updateHdfDetail(this.tx, input, hdfId, source, calculated, config, current.production_status_locked);
        updatedHdfDetailIds.push(hdfId);
        if (calculated.status === 'config_missing') configMissingHdfDetailIds.push(hdfId);
      }
    }

    for (const current of existing) {
      const sourceId = toNullableNumber(current.source_order_detail_id);
      if (sourceId !== null && seenSourceIds.has(sourceId)) continue;
      const hdfId = Number(current.order_hdf_detail_id);
      if (current.has_cut_link || current.has_bazis_link) {
        await this.tx.query(
          `
          UPDATE order_hdf_details
          SET status = 'source_changed',
              updated_at = now(),
              edited_by = $2,
              version = version + 1
          WHERE order_hdf_detail_id = $1 AND status <> 'source_changed'
          `,
          [hdfId, actorUserId(input.currentUser)],
        );
        sourceChangedHdfDetailIds.push(hdfId);
      } else {
        await softDeleteHdfRow(this.tx, hdfId, input.currentUser);
        deactivatedHdfDetailIds.push(hdfId);
      }
    }

    if (
      createdHdfDetailIds.length
      || updatedHdfDetailIds.length
      || deactivatedHdfDetailIds.length
      || sourceChangedHdfDetailIds.length
    ) {
      await auditService.record(this.tx, {
        event: 'orders.hdf_reconciled',
        entityType: 'order',
        entityId: input.orderId,
        actorUserId: input.currentUser.id,
        actorUsername: input.currentUser.username,
        actorRole: input.currentUser.role,
        requestId: input.requestId ?? 'orders-hdf-reconcile',
        source: SOURCE,
        relatedOrderId: input.orderId,
        before: {},
        after: { createdHdfDetailIds, updatedHdfDetailIds, deactivatedHdfDetailIds, sourceChangedHdfDetailIds },
        diff: { hdfStatusCounts: statusCounts },
        metadata: { action: 'hdf_reconciled', configRevision: config.configRevision, hdfStatusCounts: statusCounts },
        relatedEntities: [
          { entityType: 'order', entityId: input.orderId },
          ...createdHdfDetailIds.map((id) => ({ entityType: 'order_hdf_detail', entityId: id })),
          ...updatedHdfDetailIds.map((id) => ({ entityType: 'order_hdf_detail', entityId: id })),
          ...deactivatedHdfDetailIds.map((id) => ({ entityType: 'order_hdf_detail', entityId: id })),
          ...sourceChangedHdfDetailIds.map((id) => ({ entityType: 'order_hdf_detail', entityId: id })),
        ],
      });
    }

    return {
      createdHdfDetailIds,
      updatedHdfDetailIds,
      deactivatedHdfDetailIds,
      sourceChangedHdfDetailIds,
      configMissingHdfDetailIds,
      hdfStatusCounts: statusCounts,
    };
  }

  async recalcOrderProductionStatus(orderId: number): Promise<void> {
    await this.tx.query(
      `
      UPDATE orders
      SET production_status_from_details_enabled = true
      WHERE order_id = $1
        AND production_status_from_details_enabled IS DISTINCT FROM true
      `,
      [orderId],
    );
    await this.tx.query('SELECT recalc_order_production_status($1)', [orderId]);
  }

  async upsertPayments(
    orderId: number,
    payments: readonly NormalizedSaveOrderPaymentDto[],
  ): Promise<void> {
    for (const payment of payments) {
      if (payment.id) {
        await this.tx.query(
          `
          UPDATE payments
          SET amount = $3, payment_date = $4, type_paid_id = $5, notes = $6, ref_key_1c = $7
          WHERE payment_id = $1 AND order_id = $2
          `,
          [
            payment.id,
            orderId,
            payment.amount,
            payment.paymentDate,
            payment.typePaidId,
            payment.notes,
            payment.refKey1c,
          ],
        );
      } else {
        await this.tx.query(
          `
          INSERT INTO payments (order_id, amount, payment_date, type_paid_id, notes, ref_key_1c)
          VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [orderId, payment.amount, payment.paymentDate, payment.typePaidId, payment.notes, payment.refKey1c],
        );
      }
    }
  }

  async deletePayments(orderId: number, ids: readonly number[]): Promise<void> {
    await deleteByIds(this.tx, 'payments', 'payment_id', orderId, ids);
  }

  async upsertWorkshops(
    orderId: number,
    workshops: readonly NormalizedSaveOrderWorkshopDto[],
  ): Promise<void> {
    for (const workshop of workshops) {
      if (workshop.id) {
        await this.tx.query(
          `
          UPDATE order_workshops
          SET workshop_id = $3, production_status_id = $4, received_date = $5,
              started_date = $6, completed_date = $7, planned_completion_date = $8,
              sequence_order = $9, responsible_employee_id = $10, notes = $11,
              ref_key_1c = $12, delete_flag = false
          WHERE order_workshop_id = $1 AND order_id = $2
          `,
          workshopParams(workshop.id, orderId, workshop),
        );
      } else {
        const restored = await this.tx.query(
          `
          UPDATE order_workshops
          SET delete_flag = false,
              received_date = $4,
              started_date = $5,
              completed_date = $6,
              planned_completion_date = $7,
              sequence_order = $8,
              responsible_employee_id = $9,
              notes = $10,
              ref_key_1c = $11
          WHERE order_id = $1 AND workshop_id = $2 AND production_status_id = $3 AND delete_flag = true
          RETURNING order_workshop_id
          `,
          [
            orderId,
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
          ],
        );

        if (restored.rowCount === 0) {
          await this.tx.query(
            `
            INSERT INTO order_workshops (
              order_id, workshop_id, production_status_id, received_date, started_date,
              completed_date, planned_completion_date, sequence_order,
              responsible_employee_id, notes, ref_key_1c
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            `,
            workshopParamsForInsert(orderId, workshop),
          );
        }
      }
    }
  }

  async deleteWorkshops(orderId: number, ids: readonly number[]): Promise<void> {
    await softDeleteByIds(
      this.tx,
      'order_workshops',
      'order_workshop_id',
      'delete_flag',
      true,
      orderId,
      ids,
    );
  }

  async upsertRequirements(
    orderId: number,
    requirements: readonly NormalizedSaveOrderRequirementDto[],
  ): Promise<void> {
    for (const requirement of requirements) {
      if (requirement.id) {
        await this.tx.query(
          `
          UPDATE order_resource_requirements
          SET resource_type = $3, material_id = $4, film_id = $5, edge_type_id = $6,
              required_quantity = $7, unit_id = $8, waste_percentage = $9,
              final_quantity = $10, requirement_status_id = $11, supplier_id = $12,
              purchase_price = $13, requisition_id = $14, warehouse_id = $15,
              reserved_at = $16, consumed_at = $17, notes = $18,
              calculation_details = $19, ref_key_1c = $20, is_active = true
          WHERE requirement_id = $1 AND order_id = $2
          `,
          requirementParams(requirement.id, orderId, requirement),
        );
      } else {
        await this.tx.query(
          `
          INSERT INTO order_resource_requirements (
            order_id, resource_type, material_id, film_id, edge_type_id, required_quantity,
            unit_id, waste_percentage, final_quantity, requirement_status_id, supplier_id,
            purchase_price, requisition_id, warehouse_id, reserved_at, consumed_at, notes,
            calculation_details, ref_key_1c
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
          `,
          requirementParamsForInsert(orderId, requirement),
        );
      }
    }
  }

  async deleteRequirements(orderId: number, ids: readonly number[]): Promise<void> {
    await softDeleteByIds(
      this.tx,
      'order_resource_requirements',
      'requirement_id',
      'is_active',
      false,
      orderId,
      ids,
    );
  }

  async upsertDowelingLinks(
    orderId: number,
    links: readonly NormalizedSaveOrderDowelingLinkDto[],
  ): Promise<void> {
    for (const link of links) {
      if (link.id) {
        await this.tx.query(
          `
          UPDATE order_doweling_links
          SET doweling_order_id = $3, ref_key_1c = $4, delete_flag = false
          WHERE order_doweling_link_id = $1 AND order_id = $2
          `,
          [link.id, orderId, link.dowelingOrderId, link.refKey1c],
        );
      } else {
        const restored = await this.tx.query(
          `
          UPDATE order_doweling_links
          SET delete_flag = false, ref_key_1c = $3
          WHERE order_id = $1 AND doweling_order_id = $2 AND delete_flag = true
          RETURNING order_doweling_link_id
          `,
          [orderId, link.dowelingOrderId, link.refKey1c],
        );

        if (restored.rowCount === 0) {
          await this.tx.query(
            `
            INSERT INTO order_doweling_links (order_id, doweling_order_id, ref_key_1c)
            VALUES ($1, $2, $3)
            `,
            [orderId, link.dowelingOrderId, link.refKey1c],
          );
        }
      }

      if (link.designEngineerId !== undefined) {
        const engineerUpdate = await this.tx.query(
          `
          UPDATE doweling_orders d
          SET design_engineer_id = $3
          WHERE d.doweling_order_id = $2
            AND d.delete_flag = false
            AND EXISTS (
              SELECT 1
              FROM order_doweling_links odl
              WHERE odl.order_id = $1
                AND odl.doweling_order_id = d.doweling_order_id
                AND odl.delete_flag = false
            )
          `,
          [orderId, link.dowelingOrderId, link.designEngineerId],
        );

        if (engineerUpdate.rowCount === 0) {
          throw new ApiError(
            422,
            'DOWELING_ORDER_NOT_LINKED',
            'Doweling order is not linked to order',
            { orderId, dowelingOrderId: link.dowelingOrderId },
          );
        }
      }
    }
  }

  async deleteDowelingLinks(orderId: number, ids: readonly number[]): Promise<void> {
    await softDeleteByIds(
      this.tx,
      'order_doweling_links',
      'order_doweling_link_id',
      'delete_flag',
      true,
      orderId,
      ids,
    );
  }

  async updateOrderTotalsAndVersion(input: {
    orderId: number;
    totals: OrderTotalsDto;
    previousVersion: number | null;
    currentUser: CurrentUser;
  }): Promise<number> {
    const nextVersion = input.previousVersion === null ? 1 : input.previousVersion + 1;

    await this.tx.query(
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
        input.orderId,
        input.totals.totalAmount,
        input.totals.finalAmount,
        input.totals.paidAmount,
        input.totals.paymentDate,
        input.totals.paymentStatusId,
        input.totals.partsCount,
        input.totals.totalArea,
        nextVersion,
      ],
    );

    return nextVersion;
  }

  reconcileBazisPanelOrderLinks(
    input: ReconcileBazisPanelOrderLinksInput,
  ): Promise<BazisPanelOrderLink[]> {
    return reconcileBazisPanelOrderLinks(this.tx, input);
  }

  async softDeleteOrder(input: {
    orderId: number;
    previousVersion: number;
    actorUserId: string;
  }): Promise<number> {
    const nextVersion = input.previousVersion + 1;
    const result = await this.tx.query<{ version: string | number }>(
      `
      UPDATE orders
      SET delete_flag = true,
          version = $2,
          deleted_at = now(),
          deleted_by = $3
      WHERE order_id = $1 AND delete_flag = false
      RETURNING version
      `,
      [input.orderId, nextVersion, input.actorUserId],
    );

    if (!result.rows[0]) {
      throw new ApiError(500, 'ORDER_DELETE_FAILED', 'Не удалось удалить заказ');
    }

    return Number(result.rows[0].version);
  }

  async restoreOrder(input: {
    orderId: number;
    previousVersion: number;
    targetOrderName: string;
    actorUserId: string;
  }): Promise<number> {
    const nextVersion = input.previousVersion + 1;
    try {
      const result = await this.tx.query<{ version: string | number }>(
        `
        UPDATE orders
        SET delete_flag = false,
            deleted_at = NULL,
            deleted_by = NULL,
            order_name = $3,
            version = $2,
            edited_by = $4
        WHERE order_id = $1 AND delete_flag = true
        RETURNING version
        `,
        [input.orderId, nextVersion, input.targetOrderName, input.actorUserId],
      );

      if (!result.rows[0]) {
        throw new ApiError(500, 'ORDER_RESTORE_FAILED', 'Не удалось восстановить заказ', {
          orderId: input.orderId,
        });
      }

      return Number(result.rows[0].version);
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') {
        throw new ApiError(
          409,
          'ORDER_RESTORE_CONFLICT',
          'Конкурентное изменение помешало восстановлению, повторите попытку',
          { orderId: input.orderId },
        );
      }
      throw error;
    }
  }

  async writeAuditEvent(event: OrderSaveAuditEvent): Promise<void> {
    const sheetIds = event.relatedSheetMaterialTypeIds ?? [];
    await auditService.record(this.tx, {
      event: event.action,
      entityType: 'order',
      entityId: event.orderId,
      actorUserId: event.actorUserId,
      actorUsername: event.actorUsername ?? null,
      actorRole: event.actorRole ?? null,
      requestId: event.requestId ?? 'order-transaction',
      source: SOURCE,
      relatedOrderId: event.orderId,
      relatedClientId: event.clientId ?? null,
      before: event.before ?? null,
      after: event.after ?? null,
      diff: computeDiff(event.before ?? null, event.after ?? null),
      metadata: (event.metadata ?? { commandName: event.action }) as unknown as Record<
        string,
        unknown
      >,
      relatedEntities: sheetIds.map((entityId) => ({ entityType: 'sheet_material_type', entityId })),
    });
  }

  async writeStatusAuditEvent(event: OrderStatusAuditEvent): Promise<void> {
    await auditService.record(this.tx, {
      event: event.action,
      entityType: event.detailId === undefined ? 'order' : 'order_detail',
      entityId: event.detailId ?? event.orderId,
      actorUserId: event.actorUserId,
      actorUsername: event.actorUsername ?? null,
      actorRole: event.actorRole ?? null,
      requestId: event.requestId ?? 'order-status-audit',
      source: SOURCE,
      relatedOrderId: event.orderId,
      relatedClientId: event.clientId ?? null,
      statusField: event.statusField,
      statusId: event.statusId,
      statusName: event.statusName ?? null,
      statusCode: event.statusCode ?? null,
      before: event.before ?? null,
      after: event.after ?? null,
      diff: event.diff ?? computeDiff(event.before ?? null, event.after ?? null),
      metadata: event.metadata ?? { commandName: event.action },
      relatedEntities:
        event.detailId === undefined
          ? []
          : [{ entityType: 'order_detail', entityId: event.detailId }],
    });
  }

  async enqueueAutomationSourceOutboxEvent(event: OrderAutomationSourceOutboxEvent): Promise<void> {
    await this.tx.query(
      `
      INSERT INTO outbox_events (
        event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
      )
      VALUES ($1, 'order', $2, $3::jsonb, $4)
      ON CONFLICT (idempotency_key) DO NOTHING
      `,
      [
        event.eventType,
        String(event.orderId),
        JSON.stringify({
          source: SOURCE,
          ...event.payload,
        }),
        event.idempotencyKey,
      ],
    );
  }

  async evaluateStatusAutomation(event: StatusAutomationEvent): Promise<void> {
    await evaluateStatusAutomation(this.tx, event);
  }

  async writeOrderDeleteAudit(input: OrderDeleteAuditInput): Promise<string> {
    return writeOrderDeleteAudit(this.tx, input);
  }

  async enqueueOrderDeleteOutbox(input: OrderDeleteOutboxInput): Promise<void> {
    await enqueueOrderDeleteOutbox(this.tx, input);
  }

  async writeOrderRestoreAudit(input: OrderRestoreAuditInput): Promise<string> {
    return writeOrderRestoreAudit(this.tx, input);
  }

  async enqueueOrderRestoreOutbox(input: OrderRestoreOutboxInput): Promise<void> {
    await enqueueOrderRestoreOutbox(this.tx, input);
  }

  readOrder(orderId: number): Promise<OrderDto> {
    const reader = new PgOrderReadRepository(this.tx, this.sheetOrdersReads);
    return reader
      .getOrderById({
        orderId,
        currentUser: {
          id: '0',
          username: 'system',
          role: 'admin',
          roleId: 1,
          permissions: [],
        },
      })
      .then((order) => {
        if (!order) {
          throw new ApiError(500, 'ORDER_SAVE_FAILED', 'Saved order cannot be loaded');
        }

        return order;
      });
  }
}

export async function insertAutoRoot(
  tx: TransactionClient,
  input: {
    orderName: string;
    clientId: number;
    currentUser: CurrentUser;
    requestId: string;
  },
): Promise<{ projectId: number; created: true; code: string }> {
  const created = await tx.query<{ project_id: string | number; code: string }>(
    `
    WITH next_project AS (
      SELECT nextval(pg_get_serial_sequence('public.projects', 'project_id')) AS project_id
    )
    INSERT INTO projects (project_id, code, name, client_id, created_by)
    SELECT
      next_project.project_id,
      'МП-' || next_project.project_id,
      LEFT($1, 300),
      $2,
      $3
    FROM next_project
    RETURNING project_id, code
    `,
    [input.orderName, input.clientId, Number(input.currentUser.id)],
  );
  const row = created.rows[0];
  if (!row) {
    throw new ApiError(500, 'PROJECT_AUTO_CREATE_FAILED', 'Не удалось создать проект');
  }

  const projectId = Number(row.project_id);
  const code = row.code;
  await auditService.record(tx, {
    event: 'project.created',
    entityType: 'project',
    entityId: projectId,
    actorUserId: input.currentUser.id,
    actorUsername: input.currentUser.username,
    actorRole: input.currentUser.role,
    requestId: input.requestId,
    source: SOURCE,
    relatedClientId: input.clientId,
    before: null,
    after: { projectId, code, clientId: input.clientId },
    metadata: {
      projectId,
      action: 'project_auto_create',
      origin: 'auto',
    },
    relatedEntities: [
      { entityType: 'project', entityId: projectId },
      { entityType: 'client', entityId: input.clientId },
    ],
  });
  await tx.query(
    `
    INSERT INTO outbox_events (
      event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
    )
    VALUES ($1, 'project', $2, $3::jsonb, $4)
    ON CONFLICT (idempotency_key) DO NOTHING
    `,
    [
      'project.created',
      String(projectId),
      JSON.stringify({
        eventType: 'project.created',
        projectId,
        code,
        clientId: input.clientId,
        actorUserId: input.currentUser.id,
        requestId: input.requestId,
      }),
      `project.created:${projectId}`,
    ],
  );

  return { projectId, created: true, code };
}

async function reconcileOrderCreateIdempotency(
  tx: TransactionClient,
  input: {
    idempotencyKey: string;
    currentUser: CurrentUser;
    dto: SaveOrderDto;
  },
): Promise<OrderCreateIdempotencyResult> {
  const requestShape = {
    actorUserId: input.currentUser.id,
    commandName: 'orders.create',
    entityId: 'pending',
    dto: input.dto,
  };
  const requestHash = hashRequest(requestShape);
  const inserted = await tx.query<IdempotencyRow>(
    `
    INSERT INTO command_idempotency_keys (
      idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status
    )
    VALUES ($1, 'orders.create', $2, 'order', $3, $4, 'processing')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING idempotency_key, request_hash, response_json, status
    `,
    [input.idempotencyKey, Number(input.currentUser.id), 'pending', requestHash],
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
    throw new OrderDeleteIdempotencyInProgressError(input.idempotencyKey);
  }
  if (row.request_hash !== requestHash) {
    throw new OrderDeleteIdempotencyKeyReusedError(input.idempotencyKey);
  }
  if (row.status === 'completed' && row.response_json) {
    return { completedResponse: parseStoredCreateResponse(row.response_json) };
  }
  if (row.status === 'failed') {
    throw new OrderDeleteIdempotencyFailedError(input.idempotencyKey);
  }

  throw new OrderDeleteIdempotencyInProgressError(input.idempotencyKey);
}

async function completeOrderCreateIdempotency(
  tx: TransactionClient,
  idempotencyKey: string,
  response: OrderDto,
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

async function reconcileOrderDeleteIdempotency(
  tx: TransactionClient,
  command: DeleteOrderCommand,
): Promise<OrderDeleteIdempotencyResult> {
  const requestShape = {
    actorUserId: command.currentUser.id,
    commandName: 'orders.delete',
    orderId: command.orderId,
    version: command.version,
  };
  const requestHash = hashRequest(requestShape);
  const inserted = await tx.query<IdempotencyRow>(
    `
    INSERT INTO command_idempotency_keys (
      idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status
    )
    VALUES ($1, 'orders.delete', $2, 'order', $3, $4, 'processing')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING idempotency_key, request_hash, response_json, status
    `,
    [command.idempotencyKey, Number(command.currentUser.id), String(command.orderId), requestHash],
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
    [command.idempotencyKey],
  );
  const row = existing.rows[0];

  if (!row) {
    throw new OrderDeleteIdempotencyInProgressError(command.idempotencyKey);
  }
  if (row.request_hash !== requestHash) {
    throw new OrderDeleteIdempotencyKeyReusedError(command.idempotencyKey);
  }
  if (row.status === 'completed' && row.response_json) {
    return { completedResponse: parseStoredDeleteResponse(row.response_json) };
  }
  if (row.status === 'failed') {
    throw new OrderDeleteIdempotencyFailedError(command.idempotencyKey);
  }

  throw new OrderDeleteIdempotencyInProgressError(command.idempotencyKey);
}

async function completeOrderDeleteIdempotency(
  tx: TransactionClient,
  idempotencyKey: string,
  response: DeleteOrderResponseDto,
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

async function reserveOrderRestoreIdempotency(
  tx: TransactionClient,
  command: RestoreOrderCommand,
): Promise<OrderRestoreIdempotencyResult> {
  const requestHash = hashOrderRestoreRequest(command);
  // Reserve in a separately committed transaction so the processing row survives
  // any later rollback of the business transaction. A parallel same-key request
  // therefore always sees the committed row and must take the hash/status path
  // instead of escaping through a fresh INSERT after rollback. If the worker
  // dies after reserve and before completion, stale-processing timeout covers it.
  const inserted = await tx.query<IdempotencyRow>(
    `
    INSERT INTO command_idempotency_keys (
      idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status
    )
    VALUES ($1, 'orders.restore', $2, 'order', $3, $4, 'processing')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING idempotency_key, request_hash, response_json, status, created_at
    `,
    [command.idempotencyKey, Number(command.currentUser.id), String(command.orderId), requestHash],
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
    throw new OrderRestoreIdempotencyInProgressError(command.idempotencyKey);
  }
  if (row.request_hash !== requestHash) {
    throw new OrderRestoreIdempotencyKeyReusedError(command.idempotencyKey);
  }
  if (row.status === 'completed' && row.response_json) {
    return { completedResponse: parseStoredRestoreResponse(row.response_json) };
  }
  if (row.status === 'failed') {
    throw new OrderRestoreIdempotencyFailedError(command.idempotencyKey);
  }
  if (row.status === 'processing') {
    const createdAtMs =
      row.created_at == null ? Number.NaN : Date.parse(String(row.created_at));
    const ageMs = Date.now() - createdAtMs;
    if (Number.isFinite(ageMs) && ageMs >= STALE_PROCESSING_MS) {
      await markOrderRestoreIdempotencyFailed(tx, command.idempotencyKey);
      throw new ApiError(
        409,
        'ORDER_RESTORE_IDEMPOTENCY_FAILED',
        'Предыдущее выполнение зависло, повторите с новым ключом',
      );
    }
  }

  throw new OrderRestoreIdempotencyInProgressError(command.idempotencyKey);
}

async function completeOrderRestoreIdempotency(
  tx: TransactionClient,
  idempotencyKey: string,
  response: RestoreOrderResponseDto,
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

async function markOrderRestoreIdempotencyFailed(
  tx: TransactionClient,
  idempotencyKey: string,
): Promise<void> {
  // Only processing may burn. A completed row can coexist with a late post-commit
  // failure in the caller and must remain replayable as completed.
  await tx.query(
    `
    UPDATE command_idempotency_keys
    SET status = 'failed'
    WHERE idempotency_key = $1
      AND status = 'processing'
    `,
    [idempotencyKey],
  );
}

function hashOrderRestoreRequest(command: RestoreOrderCommand): string {
  return hashRequest({
    actorUserId: command.currentUser.id,
    commandName: 'orders.restore',
    orderId: command.orderId,
    version: command.version,
    targetOrderName: command.orderName ?? null,
  });
}

async function writeOrderDeleteAudit(
  tx: TransactionClient,
  input: OrderDeleteAuditInput,
): Promise<string> {
  const beforeJson = orderDeleteBeforeJson(input.order);
  const afterJson = orderDeleteAfterJson(input.order, input.nextVersion);
  const diffJson = orderDeleteDiffJson(input.order.version, input.nextVersion);
  const metadataJson = orderDeleteMetadataJson(input);
  const result = await tx.query<AuditRow>(
    `
    INSERT INTO audit_log (
      event, entity_type, entity_id, user_id, request_id, source,
      related_order_id, related_client_id,
      before_json, after_json, diff_json, metadata_json
    )
    VALUES (
      'orders.delete', 'order', $1, $2, $3, $4,
      $5, $6,
      $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb
    )
    RETURNING audit_id
    `,
    [
      String(input.order.orderId),
      input.currentUser.id,
      input.requestId,
      SOURCE,
      input.order.orderId,
      input.order.clientId,
      JSON.stringify(beforeJson),
      JSON.stringify(afterJson),
      JSON.stringify(diffJson),
      JSON.stringify(metadataJson),
    ],
  );

  return result.rows[0].audit_id;
}

async function enqueueOrderDeleteOutbox(
  tx: TransactionClient,
  input: OrderDeleteOutboxInput,
): Promise<void> {
  await tx.query(
    `
    INSERT INTO outbox_events (
      event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
    )
    VALUES ($1, 'order', $2, $3::jsonb, $4)
    ON CONFLICT (idempotency_key) DO NOTHING
    `,
    [
      'order.deleted',
      String(input.order.orderId),
      JSON.stringify({
        source: SOURCE,
        eventType: 'order.deleted',
        idempotencyKey: input.idempotencyKey,
        outboxIdempotencyKey: `${input.idempotencyKey}:order.deleted`,
        actorUserId: input.currentUser.id,
        requestId: input.requestId,
        auditId: input.auditId,
        orderId: input.order.orderId,
        clientId: input.order.clientId,
        orderName: input.order.orderName,
        previousVersion: input.order.version,
        version: input.nextVersion,
        scope: {
          createdByUserId: input.order.createdByUserId,
          managerUserId: input.order.managerUserId,
        },
      }),
      `${input.idempotencyKey}:order.deleted`,
    ],
  );
}

async function writeOrderRestoreAudit(
  tx: TransactionClient,
  input: OrderRestoreAuditInput,
): Promise<string> {
  const beforeJson = orderRestoreBeforeJson(input.order);
  const afterJson = orderRestoreAfterJson(input.order, input.targetOrderName, input.nextVersion);
  const diffJson = orderRestoreDiffJson(input.order, input.targetOrderName, input.nextVersion);
  const metadataJson = orderRestoreMetadataJson(input);
  const result = await tx.query<AuditRow>(
    `
    INSERT INTO audit_log (
      event, entity_type, entity_id, user_id, request_id, source,
      related_order_id, related_client_id,
      before_json, after_json, diff_json, metadata_json
    )
    VALUES (
      'orders.restore', 'order', $1, $2, $3, $4,
      $5, $6,
      $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb
    )
    RETURNING audit_id
    `,
    [
      String(input.order.orderId),
      input.currentUser.id,
      input.requestId,
      SOURCE,
      input.order.orderId,
      input.order.clientId,
      JSON.stringify(beforeJson),
      JSON.stringify(afterJson),
      JSON.stringify(diffJson),
      JSON.stringify(metadataJson),
    ],
  );

  return result.rows[0].audit_id;
}

async function enqueueOrderRestoreOutbox(
  tx: TransactionClient,
  input: OrderRestoreOutboxInput,
): Promise<void> {
  await tx.query(
    `
    INSERT INTO outbox_events (
      event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
    )
    VALUES ($1, 'order', $2, $3::jsonb, $4)
    ON CONFLICT (idempotency_key) DO NOTHING
    `,
    [
      'order.restored',
      String(input.order.orderId),
      JSON.stringify({
        source: SOURCE,
        eventType: 'order.restored',
        idempotencyKey: input.idempotencyKey,
        outboxIdempotencyKey: `${input.idempotencyKey}:order.restored`,
        actorUserId: input.currentUser.id,
        requestId: input.requestId,
        auditId: input.auditId,
        orderId: input.order.orderId,
        clientId: input.order.clientId,
        orderName: input.targetOrderName,
        previousOrderName: input.order.orderName,
        previousVersion: input.order.version,
        version: input.nextVersion,
        scope: {
          createdByUserId: input.order.createdByUserId,
          managerUserId: input.order.managerUserId,
        },
      }),
      `${input.idempotencyKey}:order.restored`,
    ],
  );
}

function orderDeleteBeforeJson(order: LockedOrderDeleteRow): Record<string, unknown> {
  return {
    orderId: order.orderId,
    orderName: order.orderName,
    clientId: order.clientId,
    deleteFlag: false,
    version: order.version,
  };
}

function orderDeleteAfterJson(
  order: LockedOrderDeleteRow,
  nextVersion: number,
): Record<string, unknown> {
  return {
    ...orderDeleteBeforeJson(order),
    deleteFlag: true,
    version: nextVersion,
  };
}

function orderRestoreBeforeJson(order: LockedOrderRestoreRow): Record<string, unknown> {
  return {
    orderId: order.orderId,
    orderName: order.orderName,
    clientId: order.clientId,
    deleteFlag: true,
    deletedAt: order.deletedAt,
    deletedBy: order.deletedBy,
    version: order.version,
  };
}

function orderRestoreAfterJson(
  order: LockedOrderRestoreRow,
  targetOrderName: string,
  nextVersion: number,
): Record<string, unknown> {
  return {
    orderId: order.orderId,
    orderName: targetOrderName,
    clientId: order.clientId,
    deleteFlag: false,
    version: nextVersion,
  };
}

function orderDeleteDiffJson(previousVersion: number, nextVersion: number): Record<string, unknown> {
  return {
    deleteFlag: { from: false, to: true },
    version: { from: previousVersion, to: nextVersion },
  };
}

function orderRestoreDiffJson(
  order: LockedOrderRestoreRow,
  targetOrderName: string,
  nextVersion: number,
): Record<string, unknown> {
  return {
    deleteFlag: { from: true, to: false },
    version: { from: order.version, to: nextVersion },
    ...(order.orderName !== targetOrderName
      ? { orderName: { from: order.orderName, to: targetOrderName } }
      : {}),
  };
}

function orderDeleteMetadataJson(input: OrderDeleteAuditInput): Record<string, unknown> {
  return {
    source: SOURCE,
    commandName: 'orders.delete',
    actorUserId: input.currentUser.id,
    previousVersion: input.order.version,
    version: input.nextVersion,
  };
}

function orderRestoreMetadataJson(input: OrderRestoreAuditInput): Record<string, unknown> {
  return {
    source: SOURCE,
    commandName: 'orders.restore',
    actorUserId: input.currentUser.id,
    previousVersion: input.order.version,
    version: input.nextVersion,
  };
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

// row выбирается по command_name конкретной команды — union сужается контрактом ключа.
function parseStoredDeleteResponse(
  responseJson: OrderDto | DeleteOrderResponseDto | RestoreOrderResponseDto | string,
): DeleteOrderResponseDto {
  return typeof responseJson === 'string'
    ? (JSON.parse(responseJson) as DeleteOrderResponseDto)
    : (responseJson as DeleteOrderResponseDto);
}

function parseStoredCreateResponse(
  responseJson: OrderDto | DeleteOrderResponseDto | RestoreOrderResponseDto | string,
): OrderDto {
  return typeof responseJson === 'string' ? (JSON.parse(responseJson) as OrderDto) : (responseJson as OrderDto);
}

function parseStoredRestoreResponse(
  responseJson: OrderDto | DeleteOrderResponseDto | RestoreOrderResponseDto | string,
): RestoreOrderResponseDto {
  return typeof responseJson === 'string'
    ? (JSON.parse(responseJson) as RestoreOrderResponseDto)
    : (responseJson as RestoreOrderResponseDto);
}

function groupChildReferences(refs: readonly OrderChildReference[]) {
  const grouped = new Map<OrderChildReference['entityType'], number[]>();

  for (const ref of refs) {
    grouped.set(ref.entityType, [...(grouped.get(ref.entityType) ?? []), ref.id]);
  }

  return [...grouped.entries()].map(([entityType, ids]) => [entityType, [...new Set(ids)]] as const);
}

async function loadHdfConfig(tx: TransactionClient, orderId: number): Promise<OrderHdfConfigInput> {
  const result = await tx.query<HdfConfigRow>(
    `
    WITH settings AS (
      SELECT
        MAX(CASE WHEN setting_key = 'production.hdf.min_side_threshold_mm' THEN value_json::text END)::jsonb AS threshold_json,
        MAX(CASE WHEN setting_key = 'production.hdf.sheet_material_type_id' THEN value_json::text END)::jsonb AS material_json
      FROM app_settings
      WHERE setting_key IN ('production.hdf.min_side_threshold_mm', 'production.hdf.sheet_material_type_id')
        AND is_active = true
    ), parsed AS (
      SELECT
        CASE
          WHEN COALESCE(settings.threshold_json->>'value', '') ~ '^[0-9]+(\\.[0-9]+)?$'
            THEN (settings.threshold_json->>'value')::numeric
          ELSE NULL
        END AS global_threshold_mm,
        CASE
          WHEN COALESCE(settings.material_json->>'value', '') ~ '^[1-9][0-9]*$'
            THEN (settings.material_json->>'value')::bigint
          ELSE NULL
        END AS configured_material_id
      FROM settings
    )
    SELECT
      COALESCE(o.hdf_min_threshold_mm, parsed.global_threshold_mm) AS threshold_mm,
      valid_configured.sheet_material_type_id AS hdf_sheet_material_type_id,
      resolved.name AS hdf_sheet_material_name,
      state.revision AS config_revision
    FROM orders o
    CROSS JOIN parsed
    CROSS JOIN hdf_calculation_config_state state
    LEFT JOIN sheet_material_types valid_configured
      ON valid_configured.sheet_material_type_id = parsed.configured_material_id
     AND valid_configured.is_active = true
    LEFT JOIN sheet_material_types resolved
      ON resolved.sheet_material_type_id = valid_configured.sheet_material_type_id
    WHERE o.order_id = $1
    `,
    [orderId],
  );
  const row = result.rows[0];
  return {
    thresholdMm: toNullableNumber(row?.threshold_mm),
    hdfSheetMaterialTypeId: toNullableNumber(row?.hdf_sheet_material_type_id),
    hdfSheetMaterialName: row?.hdf_sheet_material_name ?? null,
    configRevision: Number(row?.config_revision ?? 1),
  };
}

async function loadHdfSourceRows(tx: TransactionClient, orderId: number): Promise<HdfSourceRow[]> {
  const result = await tx.query<HdfSourceRow>(
    `
    SELECT od.detail_id, od.detail_number, od.detail_name, od.height, od.width,
           od.quantity, od.sheet_material_type_id, smt.name AS sheet_material_name,
           od.milling_type_id, mt.milling_type_name, mt.hdf_enabled, mt.hdf_edge_mm,
           od.hdf_parameter_override_mm,
           od.production_status_id
    FROM order_details od
    LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = od.sheet_material_type_id
    LEFT JOIN milling_types mt ON mt.milling_type_id = od.milling_type_id
    WHERE od.order_id = $1 AND od.delete_flag = false
    ORDER BY od.detail_id
    FOR UPDATE OF od
    `,
    [orderId],
  );
  return result.rows;
}

async function loadExistingHdfRows(tx: TransactionClient, orderId: number): Promise<ExistingHdfRow[]> {
  const result = await tx.query<ExistingHdfRow>(
    `
    SELECT h.order_hdf_detail_id, h.source_order_detail_id, h.source_order_detail_id_snapshot,
           h.source_snapshot_hash, h.config_revision, h.status, h.production_status_id, h.production_status_locked,
           EXISTS (
             SELECT 1 FROM cut_job_item cji
             WHERE cji.order_hdf_detail_id = h.order_hdf_detail_id AND cji.is_active = true
           ) AS has_cut_link,
           EXISTS (
             SELECT 1 FROM bazis_cut_set_details b
             WHERE b.source_order_hdf_detail_id = h.order_hdf_detail_id
           ) AS has_bazis_link
    FROM order_hdf_details h
    WHERE h.order_id = $1 AND h.delete_flag = false
    ORDER BY h.order_hdf_detail_id
    FOR UPDATE
    `,
    [orderId],
  );
  return result.rows;
}

async function insertHdfDetail(
  tx: TransactionClient,
  input: { orderId: number; currentUser: CurrentUser },
  source: HdfSourceRow,
  calculated: ReturnType<typeof calculateOrderHdfDetail>,
  config: OrderHdfConfigInput,
): Promise<number> {
  const result = await tx.query<{ order_hdf_detail_id: string | number }>(
    `
    INSERT INTO order_hdf_details (
      order_id, source_order_detail_id, source_order_detail_id_snapshot,
      source_detail_number, source_detail_name, source_height_mm, source_width_mm,
      source_quantity, source_sheet_material_type_id, source_sheet_material_name,
      milling_type_id, milling_type_name, hdf_enabled, edge_mm, threshold_mm,
      hdf_sheet_material_type_id, hdf_sheet_material_name, hdf_height_mm, hdf_width_mm,
      quantity, area_m2, status, config_errors, source_snapshot_hash,
      source_snapshot_json, config_revision, production_status_id, production_status_locked,
      created_by, edited_by
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
      $11,$12,$13,$14,$15,$16,$17,$18,$19,
      $20,$21,$22,$23::jsonb,$24,$25::jsonb,$26,$27,false,$28,$28
    )
    RETURNING order_hdf_detail_id
    `,
    hdfDetailParams(input.orderId, source, calculated, config, actorUserId(input.currentUser)),
  );
  return Number(result.rows[0].order_hdf_detail_id);
}

async function updateHdfDetail(
  tx: TransactionClient,
  input: { orderId: number; currentUser: CurrentUser },
  hdfId: number,
  source: HdfSourceRow,
  calculated: ReturnType<typeof calculateOrderHdfDetail>,
  config: OrderHdfConfigInput,
  productionStatusLocked: boolean,
): Promise<void> {
  const params = hdfDetailParams(input.orderId, source, calculated, config, actorUserId(input.currentUser));
  await tx.query(
    `
    UPDATE order_hdf_details
    SET source_order_detail_id = $2,
        source_order_detail_id_snapshot = $3,
        source_detail_number = $4,
        source_detail_name = $5,
        source_height_mm = $6,
        source_width_mm = $7,
        source_quantity = $8,
        source_sheet_material_type_id = $9,
        source_sheet_material_name = $10,
        milling_type_id = $11,
        milling_type_name = $12,
        hdf_enabled = $13,
        edge_mm = $14,
        threshold_mm = $15,
        hdf_sheet_material_type_id = $16,
        hdf_sheet_material_name = $17,
        hdf_height_mm = $18,
        hdf_width_mm = $19,
        quantity = $20,
        area_m2 = $21,
        status = $22,
        config_errors = $23::jsonb,
        source_snapshot_hash = $24,
        source_snapshot_json = $25::jsonb,
        config_revision = $26,
        production_status_id = CASE WHEN $30::boolean THEN production_status_id ELSE $27 END,
        edited_by = $28,
        updated_at = now(),
        version = version + 1
    WHERE order_hdf_detail_id = $29 AND order_id = $1
    `,
    [...params, hdfId, productionStatusLocked],
  );
}

async function markHdfSourceChanged(
  tx: TransactionClient,
  hdfId: number,
  currentUser: CurrentUser,
  calculated: ReturnType<typeof calculateOrderHdfDetail>,
): Promise<void> {
  await tx.query(
    `
    UPDATE order_hdf_details
    SET status = 'source_changed',
        source_snapshot_hash = $2,
        source_snapshot_json = $3::jsonb,
        config_revision = $4,
        edited_by = $5,
        updated_at = now(),
        version = version + 1
    WHERE order_hdf_detail_id = $1
    `,
    [
      hdfId,
      calculated.sourceSnapshotHash,
      JSON.stringify(calculated.sourceSnapshotJson),
      calculated.configRevision,
      actorUserId(currentUser),
    ],
  );
}

async function softDeleteHdfRow(tx: TransactionClient, hdfId: number, currentUser: CurrentUser): Promise<void> {
  await tx.query(
    `
    UPDATE order_hdf_details
    SET delete_flag = true,
        deleted_at = now(),
        edited_by = $2,
        updated_at = now(),
        version = version + 1
    WHERE order_hdf_detail_id = $1 AND delete_flag = false
    `,
    [hdfId, actorUserId(currentUser)],
  );
}

function hdfDetailParams(
  orderId: number,
  source: HdfSourceRow,
  calculated: ReturnType<typeof calculateOrderHdfDetail>,
  config: OrderHdfConfigInput,
  actorId: number | null,
) {
  const sourceId = Number(source.detail_id);
  return [
    orderId,
    sourceId,
    sourceId,
    toNullableNumber(source.detail_number),
    source.detail_name,
    toNullableNumber(source.height),
    toNullableNumber(source.width),
    toNullableNumber(source.quantity),
    toNullableNumber(source.sheet_material_type_id),
    source.sheet_material_name,
    toNullableNumber(source.milling_type_id),
    source.milling_type_name,
    source.hdf_enabled === true,
    calculated.edgeMm,
    calculated.thresholdMm,
    config.hdfSheetMaterialTypeId,
    config.hdfSheetMaterialName,
    calculated.hdfHeightMm,
    calculated.hdfWidthMm,
    calculated.quantity,
    calculated.areaM2,
    calculated.status,
    JSON.stringify(calculated.configErrors),
    calculated.sourceSnapshotHash,
    JSON.stringify(calculated.sourceSnapshotJson),
    calculated.configRevision,
    toNullableNumber(source.production_status_id),
    actorId,
  ];
}

function actorUserId(user: CurrentUser): number | null {
  const parsed = Number(user.id);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function detailParams(id: number, orderId: number, detail: CalculatedOrderDetailDto) {
  return [id, orderId, ...detailParamsForInsertValues(detail)];
}

function detailParamsForInsert(orderId: number, detail: CalculatedOrderDetailDto) {
  return [orderId, ...detailParamsForInsertValues(detail)];
}

function detailParamsForInsertValues(detail: CalculatedOrderDetailDto) {
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
    detail.hdfParameterOverrideMm ?? null,
    detail.basisProject,
    detail.basisData,
    detail.basisDesignation,
    detail.basisProduct,
    detail.doweling === true,
  ];
}

function workshopParams(id: number, orderId: number, workshop: NormalizedSaveOrderWorkshopDto) {
  return [id, orderId, ...workshopParamsForInsertValues(workshop)];
}

function workshopParamsForInsert(orderId: number, workshop: NormalizedSaveOrderWorkshopDto) {
  return [orderId, ...workshopParamsForInsertValues(workshop)];
}

function workshopParamsForInsertValues(workshop: NormalizedSaveOrderWorkshopDto) {
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

function requirementParams(
  id: number,
  orderId: number,
  requirement: NormalizedSaveOrderRequirementDto,
) {
  return [id, orderId, ...requirementParamsForInsertValues(requirement)];
}

function requirementParamsForInsert(orderId: number, requirement: NormalizedSaveOrderRequirementDto) {
  return [orderId, ...requirementParamsForInsertValues(requirement)];
}

function requirementParamsForInsertValues(requirement: NormalizedSaveOrderRequirementDto) {
  return [
    requirement.resourceType,
    requirement.materialId,
    requirement.filmId,
    requirement.edgeTypeId,
    requirement.requiredQuantity,
    requirement.unitId,
    requirement.wastePercentage,
    requirement.finalQuantity,
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

async function deleteByIds(
  tx: TransactionClient,
  table: string,
  pk: string,
  orderId: number,
  ids: readonly number[],
): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  await tx.query(
    `
    DELETE FROM ${table}
    WHERE ${pk} = ANY($1::bigint[]) AND order_id = $2
    `,
    [ids, orderId],
  );
}

async function softDeleteByIds(
  tx: TransactionClient,
  table: string,
  pk: string,
  column: string,
  value: boolean,
  orderId: number,
  ids: readonly number[],
): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  const valueSql = value ? 'true' : 'false';

  await tx.query(
    `
    UPDATE ${table}
    SET ${column} = ${valueSql}
    WHERE ${pk} = ANY($1::bigint[]) AND order_id = $2
    `,
    [ids, orderId],
  );
}

function toNullableString(value: string | number | null | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}
