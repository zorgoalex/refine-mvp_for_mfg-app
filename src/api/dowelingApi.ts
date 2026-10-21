import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  CreateDowelingOrderRequest,
  CreateDowelingOrderResponse,
  UpdateDowelingOrderRequest,
  UpdateDowelingOrderResponse,
} from './types/dowelingApi.types';

/**
 * Backend-owned doweling commands (CLAUDE.md principle 2/3): create (optionally linked to an order) and change of the
 * doweling card go through audited backend commands, never a page-level Hasura write. Auth token is auto-attached by
 * httpClient.
 */
export const dowelingApi = {
  create(request: CreateDowelingOrderRequest): Promise<CreateDowelingOrderResponse> {
    return httpClient.post<CreateDowelingOrderResponse>(apiRoutes.dowelingOrders.create, request);
  },
  update(dowelingOrderId: number, request: UpdateDowelingOrderRequest): Promise<UpdateDowelingOrderResponse> {
    return httpClient.patch<UpdateDowelingOrderResponse>(apiRoutes.dowelingOrders.update(dowelingOrderId), request);
  },
};

/** Generate a per-command idempotency key (mirror createProductionActionIdempotencyKey). */
export function createDowelingIdempotencyKey(prefix = 'doweling-quick-create'): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return `${prefix}:${uuid}`;
}

export interface BuildCreateDowelingInput {
  dowelingOrderName: string;
  designEngineerId: number;
  /** Only when the user may edit money; otherwise omitted and the server uses «Не оплачен». */
  paymentStatusId?: number | null;
  idempotencyKey: string;
  /** Quick-create from an order: the order the new doweling order is linked to (same transaction). */
  orderId?: number | null;
  dowelingOrderDate?: string | null;
  productionStatusId?: number | null;
  operatorId?: number | null;
}

/**
 * Pure mapper form values → backend request DTO. Trims the name (server also trims, but keep the wire
 * payload clean). Unit-testable without React.
 */
export function buildCreateDowelingRequest(input: BuildCreateDowelingInput): CreateDowelingOrderRequest {
  const request: CreateDowelingOrderRequest = {
    dowelingOrderName: input.dowelingOrderName.trim(),
    designEngineerId: input.designEngineerId,
    idempotencyKey: input.idempotencyKey,
  };
  if (input.paymentStatusId) request.paymentStatusId = input.paymentStatusId;
  if (input.orderId) request.orderId = input.orderId;
  if (input.dowelingOrderDate) request.dowelingOrderDate = input.dowelingOrderDate;
  if (input.productionStatusId) request.productionStatusId = input.productionStatusId;
  if (input.operatorId) request.operatorId = input.operatorId;
  return request;
}

/** Values of the doweling card form (`Редактирование присадки`). Dates are `YYYY-MM-DD` strings here. */
export interface DowelingCardValues {
  doweling_order_name?: string | null;
  doweling_order_date?: string | null;
  payment_status_id?: number | string | null;
  production_status_id?: number | string | null;
  design_engineer_id?: number | string | null;
  operator_id?: number | string | null;
  issue_date?: string | null;
  payment_date?: string | null;
  parts_count?: number | string | null;
  total_amount?: number | string | null;
  final_amount?: number | string | null;
  discount?: number | string | null;
  surcharge?: number | string | null;
  paid_amount?: number | string | null;
  link_cad_file?: string | null;
  link_pdf_file?: string | null;
  ref_key_1c?: string | null;
  is_active?: boolean | null;
  order_ids?: Array<number | string> | null;
}

const toNumberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const textOrNull = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? '').trim();
  return trimmed ? trimmed : null;
};

/**
 * Pure mapper of the doweling card → `PATCH /doweling-orders/:id`. The card sends the full state with the version it was
 * loaded with; an inactive doweling order is linked to no order. Money (payment status, amounts, payment date) goes
 * only with `sendMoney` — the user may edit money, the money is shown and it was loaded (access groups «финансы»);
 * without it the server keeps the money as it is.
 */
export function buildUpdateDowelingRequest(
  values: DowelingCardValues,
  context: { expectedVersion: number; fallbackDate: string; baseOrderIds: number[]; sendMoney: boolean },
): UpdateDowelingOrderRequest {
  const isActive = values.is_active !== false;
  const orderIds = isActive
    ? [...new Set((values.order_ids ?? []).map(toNumberOrNull).filter((id): id is number => id !== null && id > 0))]
    : [];
  const money = context.sendMoney
    ? {
        paymentStatusId: toNumberOrNull(values.payment_status_id) ?? 0,
        paymentDate: values.payment_date || null,
        totalAmount: toNumberOrNull(values.total_amount),
        finalAmount: toNumberOrNull(values.final_amount),
        discount: toNumberOrNull(values.discount) ?? 0,
        surcharge: toNumberOrNull(values.surcharge) ?? 0,
        paidAmount: toNumberOrNull(values.paid_amount) ?? 0,
      }
    : {};
  return {
    expectedVersion: context.expectedVersion,
    dowelingOrderName: String(values.doweling_order_name ?? '').trim(),
    dowelingOrderDate: values.doweling_order_date || context.fallbackDate,
    designEngineerId: toNumberOrNull(values.design_engineer_id) ?? 0,
    productionStatusId: toNumberOrNull(values.production_status_id),
    operatorId: toNumberOrNull(values.operator_id),
    issueDate: values.issue_date || null,
    partsCount: toNumberOrNull(values.parts_count) ?? 0,
    ...money,
    linkCadFile: textOrNull(values.link_cad_file),
    linkPdfFile: textOrNull(values.link_pdf_file),
    refKey1c: textOrNull(values.ref_key_1c),
    isActive,
    orderIds,
    baseOrderIds: [...new Set(context.baseOrderIds)].sort((a, b) => a - b),
  };
}
