import { ApiError } from '../../../common/errors/api-error';
import type { OnecUnitCode } from '../application/onec-documents.types';
import type { OrderResourceKind, OrderResourceSource } from '../application/order-resource-demand.types';
import type { WorklistSupplierDto } from '../application/procurement-workspace.types';
import {
  SUPPLIER_KEY_NONE,
  SUPPLIER_REQUEST_LINE_ORDERS_LIMIT,
  SUPPLIER_REQUEST_LINES_LIMIT,
  type DraftSkipReason,
  type SupplierRequestStatus,
  type SupplierRequestTransition,
} from '../application/supplier-requests.types';
import { fromThousandths, toThousandths } from './procurement-worklist';

/** Номер заявки 'YY-XXXX' (В-5): год создания в Asia/Almaty, счётчик на год; больше 9999 — 5 цифр. */
export function formatRequestNumber(year: number, value: number): string {
  return `${String(year % 100).padStart(2, '0')}-${String(value).padStart(4, '0')}`;
}

export function almatyYear(now: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty', year: 'numeric' }).format(now));
}

/** Строка рабочего списка, из которой собирается черновик (только нужные поля). */
export interface DraftSourceLine {
  orderId: number;
  resourceKey: string;
  kind: OrderResourceKind;
  refId: number;
  name: string;
  demandSource: OrderResourceSource;
  deficit: number | null;
  need: number | null;
  supplier: WorklistSupplierDto;
  /** Площадь листа (листовые); null — размеры не заданы, заявка в м². */
  sheetAreaM2: number | null;
}

export interface DraftPlanLine {
  kind: OrderResourceKind;
  refId: number;
  resourceKey: string;
  name: string;
  unit: OnecUnitCode;
  /** В тысячных единицы строки. */
  quantity: number;
  stockQuantity: number;
  orders: Array<{ orderId: number; resourceKey: string; quantity: number }>;
}

export interface DraftPlanRequest {
  supplierKey: string;
  supplierId: number | null;
  supplierName: string;
  lines: DraftPlanLine[];
}

export const NO_SUPPLIER_NAME = 'Поставщик не указан';

/**
 * Черновики из выделения (§5.5): по заявке на поставщика позиции (основной поставщик рабочего списка),
 * по строке на материал. Количество заказа = дефицит (§4.1) + запас на обрезки (только для потребности по
 * площади, как в автоподборе); листы — вверх до 0,001 листа на заказ и вверх до целого листа на строку, разница
 * уходит в «на склад». Детерминированно.
 */
export function planSupplierRequestDrafts(
  lines: DraftSourceLine[],
  wastePercent: number,
): { requests: DraftPlanRequest[]; skipped: Array<{ orderId: number; resourceKey: string; reason: DraftSkipReason }> } {
  const skipped: Array<{ orderId: number; resourceKey: string; reason: DraftSkipReason }> = [];
  const wasteFactor = 1 + Math.max(0, wastePercent) / 100;
  const bySupplier = new Map<string, { supplierId: number | null; supplierName: string; byResource: Map<string, DraftPlanLine> }>();

  for (const line of [...lines].sort((a, b) => a.orderId - b.orderId || a.resourceKey.localeCompare(b.resourceKey))) {
    if (line.need === null || line.deficit === null) { skipped.push({ orderId: line.orderId, resourceKey: line.resourceKey, reason: 'no_data' }); continue; }
    const deficit = toThousandths(line.deficit);
    if (deficit <= 0) { skipped.push({ orderId: line.orderId, resourceKey: line.resourceKey, reason: 'no_deficit' }); continue; }
    const withWaste = line.demandSource === 'area' ? Math.round(deficit * wasteFactor) : deficit;
    const unit: OnecUnitCode = line.kind === 'film' ? 'lm' : line.sheetAreaM2 !== null ? 'sheet' : 'm2';
    const quantity = unit === 'sheet' ? Math.ceil(withWaste / line.sheetAreaM2! - 1e-6) : withWaste;

    const supplierKey = line.supplier.key;
    const supplierId = supplierKey.startsWith('s:') ? Number(supplierKey.slice(2)) : null;
    const group = bySupplier.get(supplierKey) ?? {
      supplierId,
      supplierName: supplierKey === SUPPLIER_KEY_NONE ? NO_SUPPLIER_NAME : line.supplier.name,
      byResource: new Map<string, DraftPlanLine>(),
    };
    bySupplier.set(supplierKey, group);
    const planLine = group.byResource.get(line.resourceKey) ?? {
      kind: line.kind, refId: line.refId, resourceKey: line.resourceKey, name: line.name, unit, quantity: 0, stockQuantity: 0, orders: [],
    };
    group.byResource.set(line.resourceKey, planLine);
    planLine.orders.push({ orderId: line.orderId, resourceKey: line.resourceKey, quantity });
  }

  const requests: DraftPlanRequest[] = [...bySupplier.entries()]
    .map(([supplierKey, group]) => ({
      supplierKey,
      supplierId: group.supplierId,
      supplierName: group.supplierName,
      lines: [...group.byResource.values()]
        .sort((a, b) => a.name.localeCompare(b.name, 'ru') || a.resourceKey.localeCompare(b.resourceKey))
        .map((planLine) => {
          const ordered = planLine.orders.reduce((sum, order) => sum + order.quantity, 0);
          const quantity = planLine.unit === 'sheet' ? Math.ceil(ordered / 1000) * 1000 : ordered;
          return { ...planLine, quantity, stockQuantity: quantity - ordered };
        }),
    }))
    .sort((a, b) => Number(a.supplierKey === SUPPLIER_KEY_NONE) - Number(b.supplierKey === SUPPLIER_KEY_NONE)
      || a.supplierName.localeCompare(b.supplierName, 'ru') || a.supplierKey.localeCompare(b.supplierKey));
  return { requests, skipped };
}

/** Черновик должен помещаться в одну правку (CR1-3): не больше строк и заказов в строке, чем принимает PATCH. */
export function assertDraftLimits(requests: DraftPlanRequest[]): void {
  for (const request of requests) {
    if (request.lines.length > SUPPLIER_REQUEST_LINES_LIMIT) {
      throw new ApiError(422, 'SUPPLIER_REQUEST_TOO_MANY_LINES', `В одной заявке не больше ${SUPPLIER_REQUEST_LINES_LIMIT} материалов. Выделите меньше позиций этого поставщика`, {
        supplierName: request.supplierName, lines: request.lines.length, limit: SUPPLIER_REQUEST_LINES_LIMIT,
      });
    }
    const crowded = request.lines.find((line) => line.orders.length > SUPPLIER_REQUEST_LINE_ORDERS_LIMIT);
    if (crowded) {
      throw new ApiError(422, 'SUPPLIER_REQUEST_TOO_MANY_LINES', `В строке заявки не больше ${SUPPLIER_REQUEST_LINE_ORDERS_LIMIT} заказов`, {
        supplierName: request.supplierName, material: crowded.name, limit: SUPPLIER_REQUEST_LINE_ORDERS_LIMIT,
      });
    }
  }
}

/** Переход статуса (R1-8): 'noop' — уже в целевом статусе; недопустимый переход — 409. */
export function nextStatus(current: SupplierRequestStatus, transition: SupplierRequestTransition): SupplierRequestStatus | 'noop' {
  const target: Record<SupplierRequestTransition, SupplierRequestStatus> = { send: 'sent', close: 'closed', cancel: 'cancelled' };
  if (current === target[transition]) return 'noop';
  const allowed: Record<SupplierRequestTransition, SupplierRequestStatus[]> = { send: ['draft'], close: ['sent'], cancel: ['draft', 'sent'] };
  if (!allowed[transition].includes(current)) {
    throw new ApiError(409, 'SUPPLIER_REQUEST_INVALID_TRANSITION', invalidTransitionMessage(current, transition), { status: current, transition });
  }
  return target[transition];
}

function invalidTransitionMessage(current: SupplierRequestStatus, transition: SupplierRequestTransition): string {
  const status: Record<SupplierRequestStatus, string> = { draft: 'черновик', sent: 'отправлена', closed: 'закрыта', cancelled: 'отменена' };
  const action: Record<SupplierRequestTransition, string> = { send: 'отправить', close: 'закрыть', cancel: 'отменить' };
  return `Заявку в статусе «${status[current]}» нельзя ${action[transition]}`;
}

export interface CurrentRequestLine {
  lineId: number;
  quantity: number;
  stockQuantity: number;
  unit: OnecUnitCode;
  orders: Array<{ lineOrderId: number; quantity: number; visible: boolean }>;
}

export interface NormalizedPatchLine {
  lineId: number;
  quantity: number;
  stockQuantity: number;
  orders: Array<{ lineOrderId: number; quantity: number }>;
}

/**
 * Правка строк черновика — полная замена: строки/заказы, которых нет в списке, удаляются. Количества — в
 * тысячных единицы строки; листы — только целые на строку. «На склад» = количество − Σ заказов (≥ 0).
 * Заказы вне scope пользователь не видит — их нельзя ни удалить, ни изменить: сохраняются как есть.
 */
export function normalizePatchLines(
  current: CurrentRequestLine[],
  patch: Array<{ lineId: number; quantity: number; orders: Array<{ lineOrderId: number; quantity: number }> }>,
): NormalizedPatchLine[] {
  if (patch.length === 0) {
    throw new ApiError(422, 'SUPPLIER_REQUEST_EMPTY', 'В заявке должна остаться хотя бы одна строка. Чтобы убрать всё — отмените заявку');
  }
  const byId = new Map(current.map((line) => [line.lineId, line]));
  const seenLines = new Set<number>();
  const result: NormalizedPatchLine[] = [];
  for (const line of patch) {
    const existing = byId.get(line.lineId);
    if (!existing || seenLines.has(line.lineId)) {
      throw new ApiError(422, 'SUPPLIER_REQUEST_LINE_UNKNOWN', 'Строка заявки не найдена или указана дважды', { lineId: line.lineId });
    }
    seenLines.add(line.lineId);
    const quantity = toThousandths(line.quantity);
    if (existing.unit === 'sheet' && quantity % 1000 !== 0) {
      throw new ApiError(422, 'SUPPLIER_REQUEST_WHOLE_SHEETS', 'Листы заказываются целыми', { lineId: line.lineId });
    }
    const ordersById = new Map(existing.orders.map((order) => [order.lineOrderId, order]));
    const seenOrders = new Set<number>();
    const orders: Array<{ lineOrderId: number; quantity: number }> = [];
    for (const order of line.orders) {
      const known = ordersById.get(order.lineOrderId);
      if (!known || !known.visible || seenOrders.has(order.lineOrderId)) {
        throw new ApiError(422, 'SUPPLIER_REQUEST_LINE_ORDER_UNKNOWN', 'Заказ строки заявки не найден или указан дважды', { lineOrderId: order.lineOrderId });
      }
      seenOrders.add(order.lineOrderId);
      orders.push({ lineOrderId: order.lineOrderId, quantity: toThousandths(order.quantity) });
    }
    // Заказы вне scope: сохраняются без изменений.
    for (const hidden of existing.orders.filter((order) => !order.visible)) orders.push({ lineOrderId: hidden.lineOrderId, quantity: hidden.quantity });
    const ordered = orders.reduce((sum, order) => sum + order.quantity, 0);
    if (quantity <= 0 || ordered > quantity) {
      throw new ApiError(422, 'SUPPLIER_REQUEST_QUANTITY_BELOW_ORDERS', 'Количество строки меньше суммы по заказам', {
        lineId: line.lineId, quantity: fromThousandths(quantity), ordered: fromThousandths(ordered),
      });
    }
    result.push({ lineId: line.lineId, quantity, stockQuantity: quantity - ordered, orders });
  }
  // Строка с заказами вне scope не может быть удалена целиком.
  for (const line of current) {
    if (!seenLines.has(line.lineId) && line.orders.some((order) => !order.visible)) {
      throw new ApiError(422, 'SUPPLIER_REQUEST_LINE_HAS_HIDDEN_ORDERS', 'В строке есть заказы вне вашего доступа — удалить её нельзя', { lineId: line.lineId });
    }
  }
  return result;
}

export function samePatch(current: CurrentRequestLine[], next: NormalizedPatchLine[]): boolean {
  if (current.length !== next.length) return false;
  const byId = new Map(current.map((line) => [line.lineId, line]));
  return next.every((line) => {
    const existing = byId.get(line.lineId);
    if (!existing || existing.quantity !== line.quantity || existing.stockQuantity !== line.stockQuantity) return false;
    if (existing.orders.length !== line.orders.length) return false;
    const orders = new Map(existing.orders.map((order) => [order.lineOrderId, order.quantity]));
    return line.orders.every((order) => orders.get(order.lineOrderId) === order.quantity);
  });
}
