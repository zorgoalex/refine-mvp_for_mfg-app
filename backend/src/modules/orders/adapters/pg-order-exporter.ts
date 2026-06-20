import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import { OrderAccessPolicy } from '../../../permissions/policies/order-access.policy';
import { OrderNotFoundError } from '../errors/order.errors';
import type { ExportOrderCommand, OrderExportPort } from '../application/order-export.types';
import type { ExportOrderResponseDto } from '../dto/export-order.dto';

const DEFAULT_REQUEST_ID = 'order-export';
const SOURCE = 'backend-orders-command';

type FetchLike = typeof fetch;

export interface PgOrderExporterOptions {
  gasWebappUrl: string;
  gasApiKey: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

interface OrderExportHeaderRow extends QueryResultRow {
  order_id: string | number;
  order_name: string;
  order_date: string | Date;
  client_id: string | number | null;
  client_name: string | null;
  client_phone: string | null;
  total_area: string | number | null;
  planned_completion_date: string | Date | null;
  order_status_name: string | null;
  payment_status_name: string | null;
  issue_date: string | Date | null;
  production_status_name: string | null;
  manager_id: string | number | null;
  created_by: string | number | null;
  material_name: string | null;
}

interface OrderExportDetailRow extends QueryResultRow {
  detail_number: string | number | null;
  height: string | number | null;
  width: string | number | null;
  quantity: string | number | null;
  milling_type_name: string | null;
  edge_type_name: string | null;
  note: string | null;
  milling_cost_per_sqm: string | number | null;
  film_name: string | null;
  material_name: string | null;
}

interface OrderExportPaymentRow extends QueryResultRow {
  type_paid_name: string | null;
  payment_date: string | Date | null;
  amount: string | number | null;
}

interface DowelingExportRow extends QueryResultRow {
  doweling_order_name: string | null;
  design_engineer_name: string | null;
}

interface GasExportResponse {
  success?: boolean;
  error?: string;
  fileName?: string;
  folder?: string | null;
  xlsxUrl?: string | null;
  externalId?: string | null;
  fileId?: string | null;
  id?: string | null;
}

export class PgOrderExporter implements OrderExportPort {
  private readonly fetchImpl: FetchLike;
  private readonly orderPolicy = new OrderAccessPolicy();

  constructor(
    private readonly database: DatabaseService,
    private readonly options: PgOrderExporterOptions,
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async exportToGoogleDrive(command: ExportOrderCommand): Promise<ExportOrderResponseDto> {
    const { payload, clientId } = await this.database.transaction(async (tx) => {
      const { payload, clientId } = await this.buildPayload(tx, command);
      await this.writeAuditStart(tx, command);
      return { payload, clientId };
    });
    const gasResponse = await this.callGas(payload);

    await auditService.record(this.database, {
      event: 'orders.export',
      entityType: 'order',
      entityId: command.orderId,
      actorUserId: toNullableUserId(command.currentUser.id),
      actorUsername: command.currentUser.username,
      actorRole: command.currentUser.role,
      requestId: command.requestId ?? DEFAULT_REQUEST_ID,
      source: SOURCE,
      relatedOrderId: command.orderId,
      relatedClientId: clientId ?? null,
      metadata: {
        target: 'google-drive',
        fileName: gasResponse.fileName ?? command.request.fileName ?? payload.fileName,
        xlsxUrlPresent: Boolean(gasResponse.xlsxUrl),
      },
    });

    return {
      success: true,
      fileName: gasResponse.fileName ?? command.request.fileName ?? payload.fileName,
      folder: gasResponse.folder ?? null,
      xlsxUrl: gasResponse.xlsxUrl ?? null,
      externalId: gasResponse.externalId ?? gasResponse.fileId ?? gasResponse.id ?? null,
    };
  }

  private async buildPayload(tx: TransactionClient, command: ExportOrderCommand) {
    const header = await readHeader(tx, command.orderId);
    if (!header) {
      throw new OrderNotFoundError(command.orderId);
    }
    if (
      !this.orderPolicy.canExport(command.currentUser, {
        orderId: command.orderId,
        managerUserId: toNullableString(header.manager_id),
        createdByUserId: toNullableString(header.created_by),
      })
    ) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: ['orders.export'],
      });
    }

    const details = await readDetails(tx, command.orderId);
    const payments = await readPayments(tx, command.orderId);
    const doweling = await readDoweling(tx, command.orderId);
    const orderDate = parseDate(header.order_date);
    const fileName = command.request.fileName ?? generateExportFileName(header);
    const clientId = header.client_id != null ? Number(header.client_id) : null;

    const payload = {
      apiKey: this.options.gasApiKey,
      fileName,
      orderName: header.order_name,
      orderId: String(header.order_id),
      prisadkaName: doweling?.doweling_order_name ?? '',
      prisadkaDesignerName: doweling?.design_engineer_name ?? '',
      orderDate: formatDateForPayload(header.order_date),
      clientName: header.client_name ?? 'Не указан',
      clientPhone: header.client_phone ?? '',
      millingSummary: commonValue(details, (detail) => detail.milling_type_name),
      edgeSummary: commonValue(details, (detail) => detail.edge_type_name),
      filmSummary: commonValue(details, (detail) => detail.film_name),
      // SP3: header-only sheet order (no details) falls back to the header material.
      materialSummary:
        details.length > 0
          ? commonValue(details, (detail) => detail.material_name)
          : header.material_name ?? '',
      orderYear: orderDate.getFullYear(),
      orderMonth: orderDate.getMonth() + 1,
      items: details.map((detail) => ({
        detailNumber: toNumber(detail.detail_number ?? 0),
        height: toNumber(detail.height ?? 0),
        width: toNumber(detail.width ?? 0),
        quantity: toNumber(detail.quantity ?? 1),
        itemType: detail.milling_type_name ?? '',
        edge: detail.edge_type_name ?? '',
        note: detail.note ?? '',
        price: toNumber(detail.milling_cost_per_sqm ?? 0),
        film: detail.film_name ?? '',
      })),
      payments: payments.map((payment) => ({
        paymentType: payment.type_paid_name ?? '',
        paymentDate: formatDateForPayload(payment.payment_date),
        amount: toNumber(payment.amount ?? 0),
      })),
      totalArea: toNumber(header.total_area ?? 0),
      plannedCompletionDate: formatDateForPayload(header.planned_completion_date),
      orderStatusName: header.order_status_name ?? '',
      paymentStatusName: header.payment_status_name ?? '',
      issueDate: formatDateForPayload(header.issue_date),
      productionStatusName: header.production_status_name ?? '',
    };

    return { payload, clientId };
  }

  private async callGas(payload: Record<string, unknown>): Promise<GasExportResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const response = await this.fetchImpl(this.options.gasWebappUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new ApiError(502, 'EXPORT_PROVIDER_ERROR', 'Google Drive export provider failed', {
          status: response.status,
        });
      }

      const data = (await response.json()) as GasExportResponse;
      if (!data.success) {
        throw new ApiError(502, 'EXPORT_PROVIDER_ERROR', 'Google Drive export provider failed', {
          providerError: data.error ?? 'unknown',
        });
      }

      return data;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }

      const name = error instanceof Error ? error.name : '';
      if (name === 'AbortError') {
        throw new ApiError(504, 'EXPORT_PROVIDER_TIMEOUT', 'Google Drive export provider timed out');
      }

      throw new ApiError(502, 'EXPORT_PROVIDER_ERROR', 'Google Drive export provider failed');
    } finally {
      clearTimeout(timeout);
    }
  }

  private async writeAuditStart(tx: TransactionClient, command: ExportOrderCommand): Promise<void> {
    await auditService.record(tx, {
      event: 'orders.export.requested',
      entityType: 'order',
      entityId: command.orderId,
      actorUserId: toNullableUserId(command.currentUser.id),
      actorUsername: command.currentUser.username,
      actorRole: command.currentUser.role,
      requestId: command.requestId ?? DEFAULT_REQUEST_ID,
      source: SOURCE,
      relatedOrderId: command.orderId,
      metadata: { target: 'google-drive' },
    });
  }
}

async function readHeader(
  database: DatabaseClient,
  orderId: number,
): Promise<OrderExportHeaderRow | null> {
  const result = await database.query<OrderExportHeaderRow>(
    `
    SELECT
      o.order_id, o.order_name, o.order_date, o.client_id, c.client_name,
      phone.client_phone,
      o.total_area, o.planned_completion_date,
      os.order_status_name, ps.payment_status_name,
      o.issue_date, prod.production_status_name,
      o.manager_id, o.created_by,
      -- SP3: order header material = COALESCE(sheet name, material name) so a
      -- header-only sheet order exports its header material.
      COALESCE(hsmt.name, hm.material_name) AS material_name
    FROM orders o
    LEFT JOIN clients c ON c.client_id = o.client_id
    LEFT JOIN order_statuses os ON os.order_status_id = o.order_status_id
    LEFT JOIN payment_statuses ps ON ps.payment_status_id = o.payment_status_id
    LEFT JOIN production_statuses prod ON prod.production_status_id = o.production_status_id
    LEFT JOIN materials hm ON hm.material_id = o.material_id
    LEFT JOIN sheet_material_types hsmt ON hsmt.sheet_material_type_id = o.sheet_material_type_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(
        MAX(cp.phone_number) FILTER (WHERE cp.is_primary = true),
        MIN(cp.phone_number)
      ) AS client_phone
      FROM client_phones cp
      WHERE cp.client_id = o.client_id
    ) phone ON true
    WHERE o.order_id = $1 AND o.delete_flag = false
    `,
    [orderId],
  );

  return result.rows[0] ?? null;
}

async function readDetails(database: DatabaseClient, orderId: number): Promise<OrderExportDetailRow[]> {
  const result = await database.query<OrderExportDetailRow>(
    `
    SELECT
      od.detail_number, od.height, od.width, od.quantity, od.note,
      od.milling_cost_per_sqm,
      mt.milling_type_name, et.edge_type_name, f.film_name,
      -- SP3: server-resolved display name = COALESCE(sheet name, material name).
      -- Runs as the backend (no RBAC issue); a sheet detail exports the sheet
      -- name, never the hidden synthetic shadow material name.
      COALESCE(smt.name, m.material_name) AS material_name
    FROM order_details od
    LEFT JOIN milling_types mt ON mt.milling_type_id = od.milling_type_id
    LEFT JOIN edge_types et ON et.edge_type_id = od.edge_type_id
    LEFT JOIN films f ON f.film_id = od.film_id
    LEFT JOIN materials m ON m.material_id = od.material_id
    LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = od.sheet_material_type_id
    WHERE od.order_id = $1 AND od.delete_flag = false
    ORDER BY od.detail_number ASC, od.detail_id ASC
    `,
    [orderId],
  );

  return result.rows;
}

async function readPayments(database: DatabaseClient, orderId: number): Promise<OrderExportPaymentRow[]> {
  const result = await database.query<OrderExportPaymentRow>(
    `
    SELECT pt.type_paid_name, p.payment_date, p.amount
    FROM payments p
    LEFT JOIN payment_types pt ON pt.type_paid_id = p.type_paid_id
    WHERE p.order_id = $1 AND p.delete_flag = false
    ORDER BY p.payment_date ASC, p.payment_id ASC
    `,
    [orderId],
  );

  return result.rows;
}

async function readDoweling(
  database: DatabaseClient,
  orderId: number,
): Promise<DowelingExportRow | null> {
  const result = await database.query<DowelingExportRow>(
    `
    SELECT d.doweling_order_name, e.full_name AS design_engineer_name
    FROM doweling_orders d
    LEFT JOIN order_doweling_links odl ON odl.doweling_order_id = d.doweling_order_id
    LEFT JOIN employees e ON e.employee_id = d.design_engineer_id
    WHERE (d.order_id = $1 OR odl.order_id = $1) AND d.delete_flag = false
    ORDER BY d.doweling_order_id DESC
    LIMIT 1
    `,
    [orderId],
  );

  return result.rows[0] ?? null;
}

function commonValue<T>(items: readonly T[], getValue: (item: T) => string | null): string {
  const values = items.map(getValue).filter((value): value is string => Boolean(value));
  if (values.length === 0) {
    return '';
  }

  return values.every((value) => value === values[0]) ? values[0] : '';
}

function formatDateForPayload(value: string | Date | null): string {
  if (!value) {
    return '';
  }

  const date = parseDate(value);
  return [
    String(date.getDate()).padStart(2, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getFullYear()),
  ].join('.');
}

function parseDate(value: string | Date): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(500, 'INVALID_DATABASE_VALUE', 'Order export date value is invalid');
  }

  return date;
}

function generateExportFileName(header: OrderExportHeaderRow): string {
  const date = parseDate(header.order_date);
  const datePart = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
  const safeOrderName = sanitizeFilePart(header.order_name || `order-${header.order_id}`);
  const safeClient = sanitizeFilePart(header.client_name ?? 'client');

  return `${datePart}_${safeOrderName}_${safeClient}.xlsx`;
}

function sanitizeFilePart(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

function toNumber(value: string | number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new ApiError(500, 'INVALID_DATABASE_VALUE', 'Order export numeric value is invalid');
  }

  return numeric;
}

function toNullableUserId(value: string): number | null {
  const userId = Number(value);
  return Number.isInteger(userId) && userId > 0 ? userId : null;
}

function toNullableString(value: string | number | null): string | null {
  return value === null ? null : String(value);
}
