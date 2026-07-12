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
  OrderCreateIdempotencyResult,
  OrderChildReference,
  OrderDeleteAuditInput,
  OrderDeleteOutboxInput,
  OrderDeleteIdempotencyResult,
  OrderSaveAuditEvent,
  OrderTransactionManagerPort,
  OrderWriteUnitOfWork,
  SaveContext,
  SheetReferenceValidationInput,
  StoredOrderSheetState,
} from '../application/order-transaction.types';
// VARIANT B: dead after shadow removal — delete in follow-up
// (shadow-material module retained as a no-op for one release; types removed here)
import {
  validateSheetReferences as validateSheetReferencesShared,
  validateNoShadowInjection as validateNoShadowInjectionShared,
} from '../domain/sheet-order-validation';
import type { DeleteOrderResponseDto, OrderDto } from '../dto/order.dto';
import type {
  CalculatedOrderDetailDto,
  NormalizedSaveOrderDowelingLinkDto,
  NormalizedSaveOrderHeaderDto,
  NormalizedSaveOrderPaymentDto,
  NormalizedSaveOrderRequirementDto,
  NormalizedSaveOrderWorkshopDto,
  OrderTotalsDto,
} from '../dto/save-order.dto';
import {
  OrderDeleteIdempotencyFailedError,
  OrderDeleteIdempotencyInProgressError,
  OrderDeleteIdempotencyKeyReusedError,
  OrderNameDuplicateError,
} from '../errors/order.errors';
import type { SaveOrderDto } from '../dto/save-order.dto';
import {
  ProjectArchivedError,
  ProjectClientMismatchError,
  ProjectNotFoundError,
} from '../../projects/errors/projects.errors';

const CHILD_TABLES = {
  detail: { table: 'order_details', pk: 'detail_id' },
  payment: { table: 'payments', pk: 'payment_id' },
  workshop: { table: 'order_workshops', pk: 'order_workshop_id' },
  requirement: { table: 'order_resource_requirements', pk: 'requirement_id' },
  dowelingLink: { table: 'order_doweling_links', pk: 'order_doweling_link_id' },
} as const;

const SOURCE = 'backend-orders-command';

interface IdempotencyRow {
  idempotency_key: string;
  request_hash: string;
  response_json: OrderDto | DeleteOrderResponseDto | string | null;
  status: string;
}

interface LockedOrderDeleteDbRow {
  order_id: string | number;
  order_name: string;
  client_id: string | number | null;
  version: string | number;
  created_by: string | number | null;
  manager_id: string | number | null;
}

interface AuditRow {
  audit_id: string;
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
      handler(new PgOrderWriteUnitOfWork(tx, this.sheetOrdersReads)),
    );
  }
}

class PgOrderWriteUnitOfWork implements OrderWriteUnitOfWork {
  // VARIANT B: dead after shadow removal — delete in follow-up
  private saveContext: SaveContext | null = null;

  constructor(
    private readonly tx: TransactionClient,
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
      `SELECT sheet_material_type_id, sheet_eligible FROM orders WHERE order_id = $1`,
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

  async lockOrderName(orderName: string): Promise<void> {
    const normalized = orderName.trim().toLowerCase();
    // Advisory xact lock по нормализованному имени: два конкурентных сохранения
    // одного номера сериализуются, второй видит первого после его коммита.
    // Хэш-коллизия имён лишь добавляет ложную сериализацию — корректность цела.
    await this.tx.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('order_name:' || $1, 0))`,
      [normalized],
    );
  }

  async assertOrderNameAvailable(input: { orderName: string; excludeOrderId?: number }): Promise<void> {
    const normalized = input.orderName.trim().toLowerCase();
    const duplicate = await this.tx.query<{ order_id: string | number; order_name: string }>(
      `
      SELECT order_id, order_name
      FROM orders
      WHERE lower(trim(order_name)) = $1
        AND delete_flag = false
        AND ($2::bigint IS NULL OR order_id <> $2)
      ORDER BY order_id
      LIMIT 1
      `,
      [normalized, input.excludeOrderId ?? null],
    );
    const row = duplicate.rows[0];
    if (!row) {
      return;
    }

    const suggestion = await this.tx.query<{ next: string | null }>(
      `
      SELECT (COALESCE(MAX(order_name::bigint), 0) + 1)::text AS next
      FROM orders
      WHERE order_name ~ '^\\d{1,15}$' AND delete_flag = false
      `,
    );
    throw new OrderNameDuplicateError({
      existingOrderId: Number(row.order_id),
      orderName: input.orderName.trim(),
      suggestedOrderName: suggestion.rows[0]?.next ?? null,
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
      WHERE o.order_id = $1
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
      WHERE project_id = $1
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
             sheet_material_type_id AS "sheetMaterialTypeId", sheet_eligible AS "sheetEligible"
      FROM orders
      WHERE order_id = $1
      `,
      [orderId],
    );
    return result.rows[0] ?? null;
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
      const result = await this.tx.query<{ count: string | number }>(
        `
        SELECT COUNT(*)::int AS count
        FROM ${table.table}
        WHERE ${table.pk} = ANY($1::bigint[]) AND order_id = $2
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
        sheet_material_type_id, project_id, version
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8,
        $9,
        $10, $11, $12, $13,
        $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23, $24,
        $25, $26, $27, $28, $29, $30, $31, $32, 1
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
        input.header.productionStatusFromDetailsEnabled,
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
    // production_status_from_details_enabled is intentionally NOT updated here — it is owned by the
    // production-status-mode backend commands (audit/outbox/version). Creation still sets it (createOrderHeader).
    await this.tx.query(
      `
      UPDATE orders
      SET order_name = $2,
          client_id = $3,
          order_date = $4,
          priority = $5,
          manager_id = $6,
          order_status_id = $7,
          production_status_id = $8,
          planned_completion_date = $9,
          completion_date = $10,
          issue_date = $11,
          discount = $12,
          surcharge = $13,
          total_amount = $14,
          final_amount = $15,
          link_cutting_file = $16,
          link_cutting_image_file = $17,
          link_cad_file = $18,
          link_pdf_file = $19,
          notes = $20,
          material_id = $21,
          milling_type_id = $22,
          edge_type_id = $23,
          film_id = $24,
          ref_key_1c = $25,
          sheet_material_type_id = $26
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
        input.header.productionStatusId ?? null,
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
              basis_project = $25, basis_data = $26, basis_designation = $27
          WHERE detail_id = $1 AND order_id = $2
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
            sheet_material_type_id, basis_project, basis_data, basis_designation
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
          RETURNING detail_id
          `,
          detailParamsForInsert(orderId, effective),
        );
        detail.id = Number(inserted.rows[0]?.detail_id);
      }
    }
  }

  async deleteDetails(orderId: number, ids: readonly number[]): Promise<void> {
    await deleteByIds(this.tx, 'order_details', 'detail_id', orderId, ids);
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

  async softDeleteOrder(input: { orderId: number; previousVersion: number }): Promise<number> {
    const nextVersion = input.previousVersion + 1;
    const result = await this.tx.query<{ version: string | number }>(
      `
      UPDATE orders
      SET delete_flag = true,
          version = $2
      WHERE order_id = $1 AND delete_flag = false
      RETURNING version
      `,
      [input.orderId, nextVersion],
    );

    if (!result.rows[0]) {
      throw new ApiError(500, 'ORDER_DELETE_FAILED', 'Не удалось удалить заказ');
    }

    return Number(result.rows[0].version);
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

  async writeOrderDeleteAudit(input: OrderDeleteAuditInput): Promise<string> {
    return writeOrderDeleteAudit(this.tx, input);
  }

  async enqueueOrderDeleteOutbox(input: OrderDeleteOutboxInput): Promise<void> {
    await enqueueOrderDeleteOutbox(this.tx, input);
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

function orderDeleteDiffJson(previousVersion: number, nextVersion: number): Record<string, unknown> {
  return {
    deleteFlag: { from: false, to: true },
    version: { from: previousVersion, to: nextVersion },
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
  responseJson: OrderDto | DeleteOrderResponseDto | string,
): DeleteOrderResponseDto {
  return typeof responseJson === 'string'
    ? (JSON.parse(responseJson) as DeleteOrderResponseDto)
    : (responseJson as DeleteOrderResponseDto);
}

function parseStoredCreateResponse(
  responseJson: OrderDto | DeleteOrderResponseDto | string,
): OrderDto {
  return typeof responseJson === 'string' ? (JSON.parse(responseJson) as OrderDto) : (responseJson as OrderDto);
}

function groupChildReferences(refs: readonly OrderChildReference[]) {
  const grouped = new Map<OrderChildReference['entityType'], number[]>();

  for (const ref of refs) {
    grouped.set(ref.entityType, [...(grouped.get(ref.entityType) ?? []), ref.id]);
  }

  return [...grouped.entries()].map(([entityType, ids]) => [entityType, [...new Set(ids)]] as const);
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
    detail.basisProject,
    detail.basisData,
    detail.basisDesignation,
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
