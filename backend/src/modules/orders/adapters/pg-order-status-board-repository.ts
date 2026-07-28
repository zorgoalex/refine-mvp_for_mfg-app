import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { ROLE_POLICIES, type Scope } from '../../../permissions/policies/role-policies';
import { allowsScope } from '../../../permissions/policies/scope';
import type {
  GetOrderStatusBoardCommand,
  OrderStatusBoardQuery,
  OrderStatusBoardRepositoryPort,
} from '../application/order-status-board.types';
import type {
  OrderStatusBoardCardDto,
  OrderStatusBoardColumnDto,
  OrderStatusBoardResponseDto,
  OrderStatusBoardType,
} from '../dto/order-status-board.dto';
import { parseOrderSearchInput } from './pg-order-read-repository';

const CURSOR_VERSION = 1;
const UNASSIGNED_COLUMN = 'unassigned';
const ORDER_PRIORITY_MIN = 0;
const ORDER_PRIORITY_MAX = 100;

interface BoardCursor {
  v: typeof CURSOR_VERSION;
  board: OrderStatusBoardType;
  column: string;
  filterKey: string;
  priority: number;
  plannedCompletionDate: string | null;
  orderId: number;
}

interface BoardRow extends QueryResultRow {
  status_key: string;
  status_id: string | number | null;
  status_code: string | null;
  status_name: string;
  status_color: string | null;
  status_sort_order: string | number;
  status_is_active: boolean;
  total_count: string | number | null;
  row_number: string | number | null;
  order_id: string | number | null;
  order_name: string | null;
  full_number: string | null;
  client_id: string | number | null;
  client_name: string | null;
  priority: string | number | null;
  planned_completion_date: string | Date | null;
  past_planned_date: boolean | null;
  order_status_id: string | number | null;
  order_status_name: string | null;
  production_status_id: string | number | null;
  production_status_name: string | null;
  production_status_from_details_enabled: boolean | null;
  payment_status_id: string | number | null;
  payment_status_name: string | null;
  final_amount: string | number | null;
  paid_amount: string | number | null;
  parts_count: string | number | null;
  total_area: string | number | null;
  manager_id: string | number | null;
  manager_name: string | null;
  created_by: string | number | null;
  current_user_assigned: boolean | null;
  updated_at: string | Date | null;
  version: string | number | null;
}

export class PgOrderStatusBoardRepository implements OrderStatusBoardRepositoryPort {
  constructor(private readonly database: DatabaseClient) {}

  async getBoard(command: GetOrderStatusBoardCommand): Promise<OrderStatusBoardResponseDto> {
    const filterKey = createOrderStatusBoardFilterKey(command.query);
    const cursor = command.query.cursor
      ? decodeAndValidateCursor(command.query.cursor, command.query, filterKey)
      : null;
    const params: unknown[] = [];
    const statusKeySql =
      command.query.board === 'order'
        ? 'o.order_status_id::text'
        : `COALESCE(o.production_status_id::text, '${UNASSIGNED_COLUMN}')`;
    const policy = ROLE_POLICIES[command.currentUser.role];
    const needsAssignment =
      command.query.onlyMyOrders ||
      policy.orders.view === 'assigned' ||
      policy.productionTasks.update === 'assigned';
    const needsActor = needsAssignment || policy.orders.view === 'own';
    const actorIndex = needsActor
      ? params.push(normalizeActorUserId(command.currentUser.id))
      : null;
    const assignedSql = needsAssignment
      ? assignmentExistsSql(requireActorIndex(actorIndex))
      : 'FALSE';
    const boardFilterJoinSql =
      command.query.board === 'order'
        ? 'JOIN order_statuses board_order_status ON board_order_status.order_status_id = o.order_status_id'
        : command.query.includeDone
          ? ''
          : `LEFT JOIN production_statuses board_production_status
              ON board_production_status.production_status_id = o.production_status_id`;
    const filters = [
      'o.delete_flag = false',
      buildReadScopePredicate(
        policy.orders.view,
        actorIndex,
        assignedSql,
      ),
    ];
    if (command.query.board === 'order') {
      filters.push(visibleOrderStatusSql('board_order_status'));
    } else if (!command.query.includeDone) {
      filters.push(`(
        o.production_status_id IS NULL
        OR ${visibleProductionStatusSql('board_production_status')}
      )`);
    }

    appendUserFilters(filters, params, command.query, actorIndex, assignedSql);
    const filterJoinsSql = command.query.search
      ? `
        JOIN projects mp ON mp.project_id = o.project_id
        LEFT JOIN clients c ON c.client_id = o.client_id`
      : '';

    const columnIndex = command.query.column
      ? params.push(command.query.column)
      : null;
    const cursorPredicate = cursor
      ? buildCursorPredicate(params, cursor)
      : 'TRUE';
    const limitIndex = params.push(command.query.limit + 1);
    const statusCatalogSql = buildStatusCatalogSql(command.query, params);
    const selectedColumnPredicate =
      columnIndex === null ? 'TRUE' : `status_key = $${columnIndex}`;

    const result = await this.database.query<BoardRow>(
      `
      WITH status_catalog AS (
        ${statusCatalogSql}
      ),
      all_filtered AS (
        SELECT
          ${statusKeySql} AS status_key,
          o.order_id,
          COALESCE(o.priority, 100) AS priority,
          o.planned_completion_date,
          ${assignedSql} AS current_user_assigned
        FROM orders o
        ${boardFilterJoinSql}
        ${filterJoinsSql}
        WHERE ${filters.join('\n          AND ')}
      ),
      selected_column AS (
        SELECT *
        FROM all_filtered
        WHERE ${selectedColumnPredicate}
      ),
      totals AS (
        SELECT status_key, COUNT(*)::int AS total_count
        FROM selected_column
        GROUP BY status_key
      ),
      eligible AS (
        SELECT *
        FROM selected_column
        WHERE ${cursorPredicate}
      ),
      ranked AS (
        SELECT
          eligible.*,
          ROW_NUMBER() OVER (
            PARTITION BY status_key
            ORDER BY priority ASC, planned_completion_date ASC NULLS LAST, order_id DESC
          ) AS row_number
        FROM eligible
      )
      SELECT
        catalog.status_key,
        catalog.status_id,
        catalog.status_code,
        catalog.status_name,
        catalog.status_color,
        catalog.status_sort_order,
        catalog.status_is_active,
        totals.total_count,
        ranked.row_number,
        o.order_id,
        o.order_name,
        (mp.code || '-' || o.order_name) AS full_number,
        o.client_id,
        c.client_name,
        ranked.priority,
        ranked.planned_completion_date,
        (ranked.planned_completion_date < CURRENT_DATE) AS past_planned_date,
        o.order_status_id,
        os.order_status_name,
        o.production_status_id,
        prod_s.production_status_name,
        o.production_status_from_details_enabled,
        o.payment_status_id,
        pay_s.payment_status_name,
        o.final_amount,
        o.paid_amount,
        o.parts_count,
        o.total_area,
        o.manager_id,
        COALESCE(manager_employee.full_name, manager_user.full_name, manager_user.username)
          AS manager_name,
        o.created_by,
        ranked.current_user_assigned,
        o.updated_at,
        o.version
      FROM status_catalog catalog
      LEFT JOIN totals ON totals.status_key = catalog.status_key
      LEFT JOIN ranked
        ON ranked.status_key = catalog.status_key
       AND ranked.row_number <= $${limitIndex}
      LEFT JOIN orders o ON o.order_id = ranked.order_id
      LEFT JOIN projects mp ON mp.project_id = o.project_id
      LEFT JOIN clients c ON c.client_id = o.client_id
      LEFT JOIN order_statuses os ON os.order_status_id = o.order_status_id
      LEFT JOIN production_statuses prod_s
        ON prod_s.production_status_id = o.production_status_id
      LEFT JOIN payment_statuses pay_s ON pay_s.payment_status_id = o.payment_status_id
      LEFT JOIN users manager_user ON manager_user.user_id = o.manager_id
      LEFT JOIN employees manager_employee
        ON manager_employee.employee_id = manager_user.employee_id
      ORDER BY
        catalog.status_sort_order ASC,
        catalog.status_id ASC NULLS FIRST,
        ranked.row_number ASC NULLS LAST
      `,
      params,
    );

    const columns = mapBoardColumns(
      result.rows,
      command.currentUser,
      command.query,
      filterKey,
    );
    if (command.query.column && columns.length === 0) {
      throw new ApiError(422, 'BOARD_COLUMN_NOT_FOUND', 'Колонка статуса не найдена', {
        board: command.query.board,
        column: command.query.column,
      });
    }

    return {
      board: command.query.board,
      generatedAt: new Date().toISOString(),
      filterKey,
      financialsVisible: true,
      columns,
    };
  }
}

function appendUserFilters(
  filters: string[],
  params: unknown[],
  query: OrderStatusBoardQuery,
  actorIndex: number | null,
  assignedSql: string,
): void {
  if (query.search) {
    const search = parseOrderSearchInput(query.search);
    const plainIndex = params.push(`%${search.plain}%`);
    const searchClauses = [
      `o.order_name ILIKE $${plainIndex}`,
      `c.client_name::text ILIKE $${plainIndex}`,
    ];

    if (search.codePrefix !== null) {
      searchClauses.push(`mp.code ILIKE $${params.push(`${search.codePrefix}%`)}`);
      searchClauses.push(`(mp.code || '-' || o.order_name) ILIKE $${plainIndex}`);
    }
    if (search.codeExact !== null && search.namePrefix !== null) {
      const codeIndex = params.push(search.codeExact);
      const nameIndex = params.push(`${search.namePrefix}%`);
      searchClauses.push(`(mp.code = $${codeIndex} AND o.order_name ILIKE $${nameIndex})`);
    }
    filters.push(`(${searchClauses.join(' OR ')})`);
  }

  if (query.onlyMyOrders) {
    const requiredActorIndex = requireActorIndex(actorIndex);
    filters.push(`(
      o.created_by = $${requiredActorIndex}
      OR o.manager_id = $${requiredActorIndex}
      OR ${assignedSql}
    )`);
  }
  if (query.overdueOnly) {
    filters.push('o.planned_completion_date < CURRENT_DATE');
  }
  if (query.plannedFrom) {
    filters.push(`o.planned_completion_date >= $${params.push(query.plannedFrom)}::date`);
  }
  if (query.plannedTo) {
    filters.push(`o.planned_completion_date <= $${params.push(query.plannedTo)}::date`);
  }
}

function buildReadScopePredicate(
  scope: Scope,
  actorIndex: number | null,
  assignedSql: string,
): string {
  switch (scope) {
    case 'all':
      return 'TRUE';
    case 'own': {
      const requiredActorIndex = requireActorIndex(actorIndex);
      return `(o.created_by = $${requiredActorIndex} OR o.manager_id = $${requiredActorIndex})`;
    }
    case 'assigned':
      return assignedSql;
    case 'none':
      return 'FALSE';
  }
}

function requireActorIndex(actorIndex: number | null): number {
  if (actorIndex === null) {
    throw new Error('Actor SQL parameter is required');
  }
  return actorIndex;
}

function assignmentExistsSql(actorIndex: number): string {
  return `EXISTS (
    SELECT 1
    FROM order_workshops assigned_ow
    JOIN users assigned_user
      ON assigned_user.employee_id = assigned_ow.responsible_employee_id
    WHERE assigned_ow.order_id = o.order_id
      AND assigned_ow.delete_flag = false
      AND assigned_ow.responsible_employee_id IS NOT NULL
      AND assigned_user.is_active = true
      AND assigned_user.user_id = $${actorIndex}
  )`;
}

function buildStatusCatalogSql(query: OrderStatusBoardQuery, params: unknown[]): string {
  if (query.board === 'order') {
    const where = query.column
      ? `os.order_status_id = $${params.push(Number(query.column))}`
      : `(
          COALESCE(os.is_active, true) = true
          OR EXISTS (
            SELECT 1 FROM orders catalog_order
            WHERE catalog_order.delete_flag = false
              AND catalog_order.order_status_id = os.order_status_id
          )
        )`;
    return `
      SELECT
        os.order_status_id::text AS status_key,
        os.order_status_id AS status_id,
        NULL::text AS status_code,
        os.order_status_name AS status_name,
        os.color AS status_color,
        COALESCE(os.sort_order, 0) AS status_sort_order,
        COALESCE(os.is_active, true) AS status_is_active
      FROM order_statuses os
      WHERE ${where}
        AND ${visibleOrderStatusSql('os')}
    `;
  }

  const includeUnassigned = query.column === undefined || query.column === UNASSIGNED_COLUMN;
  const productionWhere =
    query.column === undefined
      ? `(
          COALESCE(ps.is_active, true) = true
          OR EXISTS (
            SELECT 1 FROM orders catalog_order
            WHERE catalog_order.delete_flag = false
              AND catalog_order.production_status_id = ps.production_status_id
          )
        )`
      : query.column === UNASSIGNED_COLUMN
        ? 'FALSE'
        : `ps.production_status_id = $${params.push(Number(query.column))}`;

  return `
    SELECT
      '${UNASSIGNED_COLUMN}'::text AS status_key,
      NULL::bigint AS status_id,
      '${UNASSIGNED_COLUMN}'::text AS status_code,
      'Без статуса'::text AS status_name,
      '#8c8c8c'::text AS status_color,
      0::int AS status_sort_order,
      true AS status_is_active
    WHERE ${includeUnassigned ? 'TRUE' : 'FALSE'}
    UNION ALL
    SELECT
      ps.production_status_id::text AS status_key,
      ps.production_status_id AS status_id,
      ps.production_status_code AS status_code,
      ps.production_status_name AS status_name,
      ps.color AS status_color,
      COALESCE(ps.sort_order, 0) AS status_sort_order,
      COALESCE(ps.is_active, true) AS status_is_active
    FROM production_statuses ps
    WHERE ${productionWhere}
      ${query.includeDone ? '' : `AND ${visibleProductionStatusSql('ps')}`}
  `;
}

function visibleOrderStatusSql(alias: string): string {
  return `LOWER(BTRIM(${alias}.order_status_name)) NOT IN ('завершен', 'завершён')`;
}

function visibleProductionStatusSql(alias: string): string {
  return `NOT (
    LOWER(BTRIM(COALESCE(${alias}.production_status_name, ''))) IN ('done', 'завершено')
    OR LOWER(BTRIM(COALESCE(${alias}.production_status_code, ''))) ~ '^(done|zaversheno)(_|$)'
  )`;
}

function buildCursorPredicate(params: unknown[], cursor: BoardCursor): string {
  const priorityIndex = params.push(cursor.priority);
  const dateIndex = params.push(cursor.plannedCompletionDate);
  const orderIdIndex = params.push(cursor.orderId);

  return `(
    priority > $${priorityIndex}
    OR (
      priority = $${priorityIndex}
      AND (
        (
          $${dateIndex}::date IS NOT NULL
          AND (
            planned_completion_date > $${dateIndex}::date
            OR planned_completion_date IS NULL
          )
        )
        OR (
          planned_completion_date IS NOT DISTINCT FROM $${dateIndex}::date
          AND order_id < $${orderIdIndex}
        )
      )
    )
  )`;
}

function mapBoardColumns(
  rows: BoardRow[],
  currentUser: CurrentUser,
  query: OrderStatusBoardQuery,
  filterKey: string,
): OrderStatusBoardColumnDto[] {
  const columns = new Map<string, { column: OrderStatusBoardColumnDto; rawCards: OrderStatusBoardCardDto[] }>();

  for (const row of rows) {
    let entry = columns.get(row.status_key);
    if (!entry) {
      entry = {
        column: {
          key: row.status_key,
          status: {
            id: toNullableNumber(row.status_id),
            code: row.status_code,
            name: row.status_name,
            color: row.status_color,
            sortOrder: toNumber(row.status_sort_order),
            isActive: row.status_is_active !== false,
          },
          total: toNumber(row.total_count),
          cards: [],
          nextCursor: null,
        },
        rawCards: [],
      };
      columns.set(row.status_key, entry);
    }

    if (row.order_id !== null) {
      entry.rawCards.push(mapBoardCard(row, currentUser));
    }
  }

  return Array.from(columns.values()).map(({ column, rawCards }) => {
    const hasMore = rawCards.length > query.limit;
    const cards = rawCards.slice(0, query.limit);
    const lastCard = cards.at(-1);
    return {
      ...column,
      cards,
      nextCursor:
        hasMore && lastCard
          ? encodeCursor({
              v: CURSOR_VERSION,
              board: query.board,
              column: column.key,
              filterKey,
              priority: lastCard.priority,
              plannedCompletionDate: lastCard.plannedCompletionDate,
              orderId: lastCard.orderId,
            })
          : null,
    };
  });
}

function mapBoardCard(row: BoardRow, currentUser: CurrentUser): OrderStatusBoardCardDto {
  const createdBy = nullableString(row.created_by);
  const managerUserId = nullableString(row.manager_id);
  const assigned = row.current_user_assigned === true;
  const policy = ROLE_POLICIES[currentUser.role];
  const scopedEntity = {
    createdByUserId: createdBy,
    managerUserId,
    assignedUserIds: assigned ? [currentUser.id] : [],
  };
  const canUpdateOrder =
    currentUser.permissions.includes('orders.update') &&
    allowsScope(currentUser, policy.orders.update, scopedEntity);
  const canChangeOrderStatus =
    canUpdateOrder && currentUser.permissions.includes('orders.change_status');
  const canChangeProductionStatus =
    currentUser.permissions.includes('orders.change_production_status') &&
    (
      canUpdateOrder ||
      (policy.productionTasks.update === 'assigned' && assigned)
    );
  const finalAmount = toNullableNumber(row.final_amount);
  const paidAmount = toNullableNumber(row.paid_amount);

  return {
    orderId: toNumber(row.order_id),
    orderName: row.order_name ?? '',
    fullNumber: row.full_number ?? '',
    clientId: toNumber(row.client_id),
    clientName: row.client_name,
    priority: toNumber(row.priority),
    plannedCompletionDate: toDateOnly(row.planned_completion_date),
    pastPlannedDate: row.past_planned_date === true,
    orderStatusId: toNumber(row.order_status_id),
    orderStatusName: row.order_status_name ?? '',
    productionStatusId: toNullableNumber(row.production_status_id),
    productionStatusName: row.production_status_name,
    productionStatusFromDetailsEnabled:
      row.production_status_from_details_enabled !== false,
    paymentStatusId: toNullableNumber(row.payment_status_id),
    paymentStatusName: row.payment_status_name,
    finalAmount,
    paidAmount,
    debtAmount:
      finalAmount === null ? null : roundMoney(finalAmount - (paidAmount ?? 0)),
    partsCount: toNumber(row.parts_count),
    totalArea: toNumber(row.total_area),
    managerId: toNullableNumber(row.manager_id),
    managerName: row.manager_name,
    updatedAt: toIsoString(row.updated_at),
    version: toNumber(row.version),
    canChangeOrderStatus,
    canChangeProductionStatus,
  };
}

export function createOrderStatusBoardFilterKey(query: OrderStatusBoardQuery): string {
  const canonical = JSON.stringify({
    search: query.search?.trim() ?? null,
    onlyMyOrders: query.onlyMyOrders,
    overdueOnly: query.overdueOnly,
    includeDone: query.includeDone === true,
    plannedFrom: query.plannedFrom ?? null,
    plannedTo: query.plannedTo ?? null,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function decodeAndValidateCursor(
  raw: string,
  query: OrderStatusBoardQuery,
  filterKey: string,
): BoardCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }

  if (!isBoardCursor(parsed)) {
    throw invalidCursor();
  }
  if (
    parsed.board !== query.board ||
    parsed.column !== query.column ||
    parsed.filterKey !== filterKey
  ) {
    throw new ApiError(422, 'BOARD_CURSOR_MISMATCH', 'Курсор не соответствует доске или фильтрам');
  }
  return parsed;
}

function isBoardCursor(value: unknown): value is BoardCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cursor = value as Partial<BoardCursor>;
  return (
    cursor.v === CURSOR_VERSION &&
    (cursor.board === 'order' || cursor.board === 'production') &&
    typeof cursor.column === 'string' &&
    typeof cursor.filterKey === 'string' &&
    Number.isInteger(cursor.priority) &&
    Number(cursor.priority) >= ORDER_PRIORITY_MIN &&
    Number(cursor.priority) <= ORDER_PRIORITY_MAX &&
    (
      cursor.plannedCompletionDate === null ||
      (
        typeof cursor.plannedCompletionDate === 'string' &&
        isValidDateOnly(cursor.plannedCompletionDate)
      )
    ) &&
    Number.isSafeInteger(cursor.orderId) &&
    Number(cursor.orderId) > 0
  );
}

function isValidDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) {
    return false;
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
  );
}

function encodeCursor(cursor: BoardCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function invalidCursor(): ApiError {
  return new ApiError(422, 'BOARD_CURSOR_INVALID', 'Некорректный курсор доски');
}

function normalizeActorUserId(value: string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : -1;
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  return Number(value);
}

function toNullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  return Number(value);
}

function nullableString(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function toDateOnly(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

function toIsoString(value: string | Date | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
