import type { OnecUnitCode } from '../../api/types/onecDocumentsApi.types';
import type { ProcurementWorklistLine, WorklistRequestRef } from '../../api/types/procurementWorkspaceApi.types';
import type {
  CreateSupplierRequestDraftsBody,
  CreateSupplierRequestDraftsResultDto,
  DraftSkipReason,
  SupplierRequestCardDto,
  SupplierRequestFulfillment,
  SupplierRequestPaymentLinkDto,
  SupplierRequestPossibleMatchDto,
  SupplierRequestPossiblePaymentDto,
  SupplierRequestReceiptLinkDto,
  SupplierRequestStatus,
  SupplierRequestSummaryDto,
} from '../../api/types/supplierRequestsApi.types';
import { onecUnitLabel } from '../onec_purchase_documents/onecDocumentsHelpers';

/**
 * Чистая логика вкладки «Заявки поставщикам» (план §5.5, §6): группировка черновика из
 * выделения, идемпотентный `requestId`, черновик-превью в sessionStorage, статусы/сверка,
 * пересчёт «на склад», сборка PATCH-тела и текста для поставщика. Компонент — только рендер.
 */

export const SUPPLIER_REQUEST_STATUS_LABELS: Record<SupplierRequestStatus, string> = {
  draft: 'Черновик',
  sent: 'Отправлена',
  closed: 'Закрыта',
  cancelled: 'Отменена',
};

export type RequestsStatusFilter = SupplierRequestStatus | 'all';

const quantityFormatter3 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });
const DEMAND_UNIT_LABELS: Record<'m2' | 'lm', string> = { m2: 'м²', lm: 'пог. м' };

/**
 * «7 лист» / «0,274 лист» / «12,5 м²»: до тысячных. Целым обязано быть только количество строки в листах —
 * доли заказов и «на склад» бывают дробными (CR2-5).
 */
export function formatRequestQuantity(quantity: number, unit: OnecUnitCode): string {
  return `${quantityFormatter3.format(quantity)} ${onecUnitLabel(unit, null)}`;
}

export function formatDemandQuantity(quantity: number, unit: 'm2' | 'lm'): string {
  return `${quantityFormatter3.format(quantity)} ${DEMAND_UNIT_LABELS[unit]}`;
}

export function roundTo3Number(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function isWholeSheetQuantity(unit: OnecUnitCode, quantity: number): boolean {
  return unit !== 'sheet' || Number.isInteger(quantity);
}

// ---------------------------------------------------------------------------
// Черновик заявок из выделения рабочего списка (превью на клиенте до создания).
// ---------------------------------------------------------------------------

export interface DraftPreviewItem {
  orderId: number;
  resourceKey: string;
  supplierKey: string;
  supplierName: string;
  materialName: string;
  deficit: number;
  unit: 'm2' | 'lm';
  fullNumber: string;
}

/** Из строк рабочего списка — только с непокрытым дефицитом (иначе заказывать нечего). */
export function buildDraftPreviewItems(lines: ProcurementWorklistLine[]): DraftPreviewItem[] {
  return lines
    .filter((line) => (line.deficit ?? 0) > 0)
    .map((line) => ({
      orderId: line.orderId,
      resourceKey: line.resourceKey,
      supplierKey: line.supplier.key,
      supplierName: line.supplier.name,
      materialName: line.name,
      deficit: line.deficit ?? 0,
      unit: line.unit,
      fullNumber: line.fullNumber,
    }));
}

export interface DraftPreviewMaterialGroup {
  resourceKey: string;
  materialName: string;
  unit: 'm2' | 'lm';
  deficitTotal: number;
  orders: string[];
}

export interface DraftPreviewSupplierGroup {
  supplierKey: string;
  supplierName: string;
  materials: DraftPreviewMaterialGroup[];
}

/** Превью черновика (§6): сгруппировано по поставщику, затем по материалу; заказы — без повторов. */
export function groupDraftPreviewBySupplier(items: DraftPreviewItem[]): DraftPreviewSupplierGroup[] {
  const bySupplier = new Map<string, { name: string; items: DraftPreviewItem[] }>();
  for (const item of items) {
    const bucket = bySupplier.get(item.supplierKey) ?? { name: item.supplierName, items: [] };
    bucket.items.push(item);
    bySupplier.set(item.supplierKey, bucket);
  }
  return [...bySupplier.entries()]
    .sort(([leftKey, left], [rightKey, right]) =>
      Number(leftKey === 'none') - Number(rightKey === 'none') || left.name.localeCompare(right.name, 'ru'))
    .map(([supplierKey, bucket]) => {
      const byMaterial = new Map<string, DraftPreviewMaterialGroup>();
      for (const item of bucket.items) {
        const existing = byMaterial.get(item.resourceKey);
        if (existing) {
          existing.deficitTotal = roundTo3Number(existing.deficitTotal + item.deficit);
          if (!existing.orders.includes(item.fullNumber)) existing.orders.push(item.fullNumber);
        } else {
          byMaterial.set(item.resourceKey, {
            resourceKey: item.resourceKey,
            materialName: item.materialName,
            unit: item.unit,
            deficitTotal: item.deficit,
            orders: [item.fullNumber],
          });
        }
      }
      return {
        supplierKey,
        supplierName: bucket.name,
        materials: [...byMaterial.values()].sort((a, b) => a.materialName.localeCompare(b.materialName, 'ru')),
      };
    });
}

/** Отпечаток набора позиций — для решения «повтор той же попытки» / «выделение изменилось». */
export function draftPreviewSignature(items: DraftPreviewItem[]): string {
  return [...items].map((item) => `${item.orderId}:${item.resourceKey}`).sort().join(',');
}

export interface DraftRequestIdState {
  signature: string;
  requestId: string;
}

/**
 * Идемпотентный `requestId` (план §5.5): один UUID на попытку «Создать», переиспользуется
 * при повторе после сетевой ошибки; новый — только когда изменилось выделение.
 */
export function resolveDraftRequestId(
  items: DraftPreviewItem[],
  previous: DraftRequestIdState | null,
  generateId: () => string,
): DraftRequestIdState {
  const signature = draftPreviewSignature(items);
  if (previous && previous.signature === signature) return previous;
  return { signature, requestId: generateId() };
}

/** Тело `POST drafts`: заказ+материал без повторов. */
export function buildDraftsBody(items: DraftPreviewItem[], requestId: string): CreateSupplierRequestDraftsBody {
  const seen = new Set<string>();
  const dedup: Array<{ orderId: number; resourceKey: string }> = [];
  for (const item of items) {
    const key = `${item.orderId}:${item.resourceKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push({ orderId: item.orderId, resourceKey: item.resourceKey });
  }
  return { requestId, items: dedup };
}

export const DRAFT_SKIP_REASON_LABELS: Record<DraftSkipReason, string> = {
  not_in_order: 'этого материала уже нет в заказе',
  no_deficit: 'дефицита больше нет',
  no_data: 'нет данных о потребности',
  order_closed: 'заказ закрыт или выдан',
  in_draft: 'уже в черновике заявки',
};

export interface DraftsResultSummary {
  createdMessage: string;
  skippedMessage: string | null;
}

export function summarizeDraftsResult(result: CreateSupplierRequestDraftsResultDto): DraftsResultSummary {
  const created = result.requests;
  const createdMessage = created.length === 0
    ? 'Заявки не созданы'
    : `Создано заявок: ${created.length} (${created.map((request) => request.requestNumber).join(', ')})`;
  if (result.skipped.length === 0) return { createdMessage, skippedMessage: null };
  const byReason = new Map<DraftSkipReason, number>();
  for (const item of result.skipped) byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1);
  const skippedMessage = `Пропущено ${result.skipped.length}: ${[...byReason.entries()]
    .map(([reason, count]) => `${count} — ${DRAFT_SKIP_REASON_LABELS[reason]}`)
    .join(', ')}`;
  return { createdMessage, skippedMessage };
}

// ---------------------------------------------------------------------------
// Превью черновика в sessionStorage — передача выделения из рабочего списка на эту
// вкладку (план §6). По образцу `allocationSuggestionModel.ts` (свой storage — тестируемо).
// ---------------------------------------------------------------------------

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const DRAFT_PREVIEW_STORAGE_KEY = 'procurement.supplierRequests.draftPreview';

/** Превью и ключ повтора — свои у каждого пользователя вкладки (CR4-1): другой пользователь их не увидит. */
function userKey(key: string, userId: string): string {
  return `${key}:${userId}`;
}

function safeSessionStorage(): StorageLike | undefined {
  try {
    return typeof globalThis !== 'undefined' && globalThis.sessionStorage ? globalThis.sessionStorage : undefined;
  } catch {
    return undefined;
  }
}

function isDraftPreviewItem(value: unknown): value is DraftPreviewItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.orderId === 'number'
    && typeof item.resourceKey === 'string'
    && typeof item.supplierKey === 'string'
    && typeof item.supplierName === 'string'
    && typeof item.materialName === 'string'
    && typeof item.deficit === 'number'
    && (item.unit === 'm2' || item.unit === 'lm')
    && typeof item.fullNumber === 'string';
}

export function saveDraftPreview(userId: string, items: DraftPreviewItem[], storage: StorageLike | undefined = safeSessionStorage()): void {
  try {
    storage?.setItem(userKey(DRAFT_PREVIEW_STORAGE_KEY, userId), JSON.stringify(items));
  } catch {
    /* хранилище недоступно — черновик просто не переживёт переход между вкладками */
  }
}

export function loadDraftPreview(userId: string, storage: StorageLike | undefined = safeSessionStorage()): DraftPreviewItem[] | null {
  try {
    const raw = storage?.getItem(userKey(DRAFT_PREVIEW_STORAGE_KEY, userId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isDraftPreviewItem)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearDraftPreview(userId: string, storage: StorageLike | undefined = safeSessionStorage()): void {
  try {
    storage?.removeItem(userKey(DRAFT_PREVIEW_STORAGE_KEY, userId));
    storage?.removeItem(userKey(DRAFT_REQUEST_ID_STORAGE_KEY, userId));
  } catch {
    /* нечего чистить — хранилище недоступно */
  }
}

/**
 * Ключ повтора сохраняется ДО отправки (CR2-3): если ответ потерян и раздел перемонтирован или страница
 * обновлена, повтор с тем же выделением уходит с тем же requestId и получает сохранённый результат.
 */
export const DRAFT_REQUEST_ID_STORAGE_KEY = 'procurement.supplierRequests.draftRequestId';

export function saveDraftRequestId(userId: string, state: DraftRequestIdState, storage: StorageLike | undefined = safeSessionStorage()): void {
  try {
    storage?.setItem(userKey(DRAFT_REQUEST_ID_STORAGE_KEY, userId), JSON.stringify(state));
  } catch {
    /* без хранилища повтор после перезагрузки получит новый ключ */
  }
}

export function loadDraftRequestId(userId: string, storage: StorageLike | undefined = safeSessionStorage()): DraftRequestIdState | null {
  try {
    const raw = storage?.getItem(userKey(DRAFT_REQUEST_ID_STORAGE_KEY, userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DraftRequestIdState>;
    return typeof parsed?.signature === 'string' && typeof parsed?.requestId === 'string'
      ? { signature: parsed.signature, requestId: parsed.requestId }
      : null;
  } catch {
    return null;
  }
}

/** Отправка черновика: поставщик задан, если ключ не «none» (поставщик из 1С — c:/n: — тоже поставщик; CR2-1). */
export function hasRequestSupplier(card: { supplierKey: string }): boolean {
  return card.supplierKey !== 'none';
}

// ---------------------------------------------------------------------------
// Список заявок: фильтр по статусу, теги ссылок в рабочем списке, сверка.
// ---------------------------------------------------------------------------

export function statusFilterToParam(filter: RequestsStatusFilter): string | undefined {
  return filter === 'all' ? undefined : filter;
}

export interface RequestsStatusCounts {
  draft: number;
  sent: number;
  closed: number;
  cancelled: number;
  all: number;
}

export function requestsStatusCounts(counts: Record<SupplierRequestStatus, number>): RequestsStatusCounts {
  return { ...counts, all: counts.draft + counts.sent + counts.closed + counts.cancelled };
}

export interface RequestRefTag {
  tone: 'none' | 'info';
  label: string;
}

/**
 * Тег в рабочем списке рядом с покрытием (план §6, ф.3б): draft → «в черновике», sent → «заказано»
 * (+ «пришло X из Y», если по заявке уже есть привязанные приходы).
 */
export function requestRefTag(ref: WorklistRequestRef): RequestRefTag {
  if (ref.status !== 'sent') return { tone: 'none', label: `в черновике ${ref.requestNumber}` };
  const fulfilled = ref.fulfilled ?? 0;
  const suffix = fulfilled > 0 ? ` · пришло ${formatRequestQuantity(fulfilled, ref.unit)} из ${formatRequestQuantity(ref.quantity, ref.unit)}` : '';
  return { tone: 'info', label: `заказано · ${ref.requestNumber}${suffix}` };
}

export type StepState = 'done' | 'part' | 'todo';

export interface RequestSteps {
  request: StepState;
  receipt: StepState;
  payment: StepState;
}

export const REQUEST_STEP_LABELS = ['Заявка', 'Приход', 'Оплата'] as const;

/**
 * Сверка «заявка → приход → оплата» (§5.5, ф.3б/ф.3б-2): «Приход» — по receiptState заявки (done/partial/none →
 * done/part/todo); «Оплата» — по paymentState (paid → part: полноты нет, в заявке нет цен; none/hidden → todo).
 * Старый backend без receiptState/paymentState — трактуется как 'none'/'hidden'.
 */
export function computeRequestSteps(
  status: SupplierRequestStatus,
  receiptState: 'none' | 'partial' | 'done' = 'none',
  paymentState: SupplierRequestSummaryDto['paymentState'] = 'hidden',
): RequestSteps {
  return {
    request: status === 'sent' || status === 'closed' ? 'done' : 'todo',
    receipt: receiptState === 'done' ? 'done' : receiptState === 'partial' ? 'part' : 'todo',
    payment: paymentStepInfo(paymentState, undefined).state,
  };
}

export function stepIcon(state: StepState): string {
  return state === 'done' ? '✓' : state === 'part' ? '◐' : '○';
}

export function hiddenOrdersLabel(count: number): string | null {
  return count > 0 ? `ещё ${count} вне доступа` : null;
}

export function formatLineItemText(line: { name: string; quantity: number; unit: OnecUnitCode }): string {
  return `${line.name} — ${formatRequestQuantity(line.quantity, line.unit)}`;
}

// ---------------------------------------------------------------------------
// Привязка приходов 1С к заказам заявки (ф.3б): статус исполнения, привязанные приходы,
// «Возможные совпадения» — привязать/отвязать в карточке.
// ---------------------------------------------------------------------------

export interface FulfillmentTag {
  tone: 'none' | 'warn' | 'ok';
  label: string;
}

export const FULFILLMENT_LABELS: Record<SupplierRequestFulfillment, string> = {
  waiting: 'Ждём',
  partial: 'Частично',
  received: 'Получено',
};

/** Тег «Ждём / Частично / Получено» у заказа строки заявки; без значения (старый backend) — «Ждём». */
export function fulfillmentTag(state: SupplierRequestFulfillment | undefined): FulfillmentTag {
  const value = state ?? 'waiting';
  const tone: FulfillmentTag['tone'] = value === 'received' ? 'ok' : value === 'partial' ? 'warn' : 'none';
  return { tone, label: FULFILLMENT_LABELS[value] };
}

/** «Приход 16756 от 02.09.2026 — 1 лист» — строка привязанного прихода под заказом заявки. */
export function receiptLineLabel(receipt: Pick<SupplierRequestReceiptLinkDto, 'documentNumber' | 'documentDate' | 'quantity'>, unit: OnecUnitCode): string {
  return `Приход ${receipt.documentNumber} от ${formatDateOnly(receipt.documentDate)} — ${formatRequestQuantity(receipt.quantity, unit)}`;
}

/** Максимум для «Привязать»: не больше, чем не привязано в приходе, и не больше остатка по заказу заявки. */
export function possibleMatchMaxQuantity(
  order: { quantity: number; fulfilled?: number },
  match: Pick<SupplierRequestPossibleMatchDto, 'unlinkedQuantity'>,
): number {
  const remaining = order.quantity - (order.fulfilled ?? 0);
  return Math.max(0, roundTo3Number(Math.min(match.unlinkedQuantity, remaining)));
}

/** Значение по умолчанию в поле «Привязать»: предложение сервера, но не больше пересчитанного максимума. */
export function possibleMatchDefaultQuantity(
  order: { quantity: number; fulfilled?: number },
  match: Pick<SupplierRequestPossibleMatchDto, 'unlinkedQuantity' | 'suggestedQuantity'>,
): number {
  return roundTo3Number(Math.min(match.suggestedQuantity, possibleMatchMaxQuantity(order, match)));
}

// ---------------------------------------------------------------------------
// Оплаты 1С → заявки поставщикам (ф.3б-2, видно только с finance.view): форматирование сумм по
// валютам (без смешения), «возможные оплаты» (по аналогии с приходами) и шаг «Оплата» сверки.
// ---------------------------------------------------------------------------

export function roundTo2Number(value: number): number {
  return Math.round(value * 100) / 100;
}

const amountFormatter2 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

/** ₸ для KZT, иначе — код валюты как есть (разные валюты не смешиваются одним символом). */
export function currencyLabel(currency: string): string {
  const code = currency.trim().toUpperCase();
  return code === 'KZT' ? '₸' : code;
}

export function formatPaymentAmount(amount: number, currency: string): string {
  return `${amountFormatter2.format(amount)} ${currencyLabel(currency)}`;
}

/**
 * «50 000 ₸ + 120 USD»: суммы разных валют никогда не складываются (R3-3) — каждая форматируется
 * отдельно и соединяется « + »; KZT (основная валюта) — первой, остальные — по алфавиту кода.
 * Нулевые/отсутствующие валюты не показываются; пустой набор — null (строку «Оплачено:» не рисовать).
 */
export function formatPaidSummary(paid: Record<string, number>): string | null {
  const entries = Object.entries(paid).filter(([, amount]) => amount > 0);
  if (entries.length === 0) return null;
  entries.sort(([leftCurrency], [rightCurrency]) => {
    if (leftCurrency === rightCurrency) return 0;
    if (leftCurrency === 'KZT') return -1;
    if (rightCurrency === 'KZT') return 1;
    return leftCurrency.localeCompare(rightCurrency);
  });
  return entries.map(([currency, amount]) => formatPaymentAmount(amount, currency)).join(' + ');
}

/**
 * Максимум для «Привязать оплату»: не больше непривязанной суммы прихода оплаты. Верхней границы по
 * заказу заявки нет (в заявке нет цен, §5.5 R2-4) — в отличие от приходов, где есть остаток по количеству.
 */
export function possiblePaymentMaxAmount(possiblePayment: Pick<SupplierRequestPossiblePaymentDto, 'unlinkedAmount'>): number {
  return Math.max(0, roundTo2Number(possiblePayment.unlinkedAmount));
}

/** Значение по умолчанию в поле «Привязать оплату» — вся непривязанная сумма (верхней границы по заявке нет). */
export function possiblePaymentDefaultAmount(possiblePayment: Pick<SupplierRequestPossiblePaymentDto, 'unlinkedAmount'>): number {
  return possiblePaymentMaxAmount(possiblePayment);
}

/** Кнопка «Привязать оплату» доступна только для суммы из (0, max]. */
export function canLinkPaymentAmount(amount: number, max: number): boolean {
  return amount > 0 && amount <= max;
}

/** «Оплата 123 от 01.10.2026 — 20 000 ₸» — строка привязанной оплаты под заказом заявки. */
export function paymentLineLabel(payment: Pick<SupplierRequestPaymentLinkDto, 'documentNumber' | 'documentDate' | 'amount' | 'currency'>): string {
  return `Оплата ${payment.documentNumber} от ${formatDateOnly(payment.documentDate)} — ${formatPaymentAmount(payment.amount, payment.currency)}`;
}

/** Суммы оплат видны — т.е. у пользователя есть finance.view (старый backend без paymentState — трактуется как «hidden»). */
export function canSeePayments(paymentState: SupplierRequestSummaryDto['paymentState'] | undefined): boolean {
  return paymentState === 'none' || paymentState === 'paid';
}

export interface StepInfo {
  state: StepState;
  tooltip?: string;
}

/**
 * Шаг «Оплата» сверки (§5.5 ф.3б-2): 'paid' → ◐ (не «✓» — полноты нет, в заявке нет цен для сравнения);
 * 'none' → ○ без подсказки; 'hidden'/старый backend → ○ с подсказкой про право на финансы.
 */
export function paymentStepInfo(
  paymentState: SupplierRequestSummaryDto['paymentState'] | undefined,
  paid: Record<string, number> | undefined,
): StepInfo {
  if (paymentState === 'paid') {
    const summary = formatPaidSummary(paid ?? {});
    return { state: 'part', tooltip: summary ? `оплачено: ${summary}` : undefined };
  }
  if (paymentState === 'none') return { state: 'todo' };
  return { state: 'todo', tooltip: 'суммы видны с правом на финансы' };
}

// ---------------------------------------------------------------------------
// Карточка: «на склад», правка строк, PATCH-тело, текст для поставщика.
// ---------------------------------------------------------------------------

const STOCK_EPSILON = 0.0005;

/** «На склад» = количество строки − Σ заказов (видимых + скрытых вне scope, §5.5). */
export function computeLineStock(quantity: number, orderQuantities: number[], hiddenOrdersQuantity = 0): number {
  const ordered = orderQuantities.reduce((sum, value) => sum + value, 0) + hiddenOrdersQuantity;
  return roundTo3Number(quantity - ordered);
}

export function isStockNegative(stock: number): boolean {
  return stock < -STOCK_EPSILON;
}

export interface LineEditState {
  lineId: number;
  quantity: number;
  orders: Array<{ lineOrderId: number; quantity: number }>;
}

export interface UpdatePatchInput {
  expectedVersion: number;
  comment?: string | null;
  expectedDate?: string | null;
  supplierId?: number | null;
  lines?: LineEditState[];
}

/** PATCH-тело (план §5.5): полная замена строк, числа — округлены до тысячных. */
export function buildUpdatePatchBody(input: UpdatePatchInput): {
  expectedVersion: number;
  comment?: string | null;
  expectedDate?: string | null;
  supplierId?: number | null;
  lines?: Array<{ lineId: number; quantity: number; orders: Array<{ lineOrderId: number; quantity: number }> }>;
} {
  const body: ReturnType<typeof buildUpdatePatchBody> = { expectedVersion: input.expectedVersion };
  if (input.comment !== undefined) body.comment = input.comment;
  if (input.expectedDate !== undefined) body.expectedDate = input.expectedDate;
  if (input.supplierId !== undefined) body.supplierId = input.supplierId;
  if (input.lines) {
    body.lines = input.lines.map((line) => ({
      lineId: line.lineId,
      quantity: roundTo3Number(line.quantity),
      orders: line.orders.map((order) => ({ lineOrderId: order.lineOrderId, quantity: roundTo3Number(order.quantity) })),
    }));
  }
  return body;
}

export const SUPPLIER_REQUEST_ERROR_MESSAGES: Record<string, string> = {
  SUPPLIER_REQUEST_NOT_EDITABLE: 'Менять можно только черновик заявки',
  SUPPLIER_REQUEST_SUPPLIER_REQUIRED: 'Укажите поставщика перед отправкой заявки',
  SUPPLIER_REQUEST_INVALID_TRANSITION: 'Этот переход статуса недоступен',
  SUPPLIER_REQUEST_EMPTY: 'В заявке должна остаться хотя бы одна строка. Чтобы убрать всё — отмените заявку',
  SUPPLIER_REQUEST_WHOLE_SHEETS: 'Листы заказываются целыми',
  SUPPLIER_REQUEST_QUANTITY_BELOW_ORDERS: 'Количество строки меньше суммы по заказам',
  SUPPLIER_REQUEST_LINE_HAS_HIDDEN_ORDERS: 'В строке есть заказы вне вашего доступа — удалить её нельзя',
  SUPPLIER_REQUEST_LINE_UNKNOWN: 'Строка заявки не найдена — обновите заявку',
  SUPPLIER_REQUEST_LINE_ORDER_UNKNOWN: 'Заказ строки заявки не найден — обновите заявку',
  SUPPLIER_REQUEST_NOT_FOUND: 'Заявка не найдена',
  IDEMPOTENCY_KEY_REUSED: 'Повтор с другим содержимым — обновите страницу и попробуйте снова',
  PERMISSION_DENIED: 'Недостаточно прав для этой операции',
  // Привязка приходов к заявкам (ф.3б) — «Привязать» / «Отвязать» в карточке.
  SUPPLIER_REQUEST_NOT_SENT: 'Привязать приход можно только к отправленной заявке',
  SUPPLIER_REQUEST_SUPPLIER_MISMATCH: 'Поставщик прихода не совпадает с поставщиком заявки',
  SUPPLIER_REQUEST_LINK_EXCEEDS_REQUEST: 'Больше, чем заказано в заявке',
  SUPPLIER_REQUEST_LINK_EXCEEDS_ALLOCATION: 'Связей с заявками больше, чем распределено по приходу',
  SUPPLIER_REQUEST_LINK_UNIT: 'Единицы прихода и заявки несовместимы',
  SUPPLIER_REQUEST_LINK_OTHER_ORDER: 'Строка заявки относится к другому заказу или материалу',
  SUPPLIER_REQUEST_LINK_EXISTS: 'Приход уже привязан к этой строке заявки с другим количеством. Отвяжите и привяжите заново',
  SUPPLIER_REQUEST_LINK_DUPLICATE: 'Заказ строки заявки указан дважды',
  SUPPLIER_REQUEST_LINE_ORDER_NOT_FOUND: 'Строка заявки не найдена — обновите заявку',
  SUPPLIER_REQUEST_LINK_NOT_FOUND: 'Связь с заявкой не найдена — обновите заявку',
  SUPPLIER_REQUEST_LINK_RECEIPTS_ONLY: 'К заявке привязывается приход; оплаты — позже',
  // Привязка оплат к заявкам (ф.3б-2) — «Привязать оплату» / «Отвязать» в карточке (finance.view).
  SUPPLIER_REQUEST_LINK_MEASURE: 'Неверная величина связи: приход — количеством, оплата — суммой',
  SUPPLIER_REQUESTS_DISABLED: 'Заявки поставщикам пока выключены',
  ONEC_ALLOCATION_NOT_FOUND: 'Распределение не найдено',
  ONEC_ALLOCATION_REMOVED: 'Распределение уже снято',
  PROCUREMENT_VERSION_CONFLICT: 'Закуп материала уже изменил другой пользователь. Обновите карточку',
};

/** Отказ 403 именно из-за отсутствия finance.view (сервер шлёт общий код PERMISSION_DENIED + details.requiredPermissions). */
function isFinancePermissionDenied(error: { code?: string; details?: unknown } | null | undefined): boolean {
  if (!error || error.code !== 'PERMISSION_DENIED') return false;
  const details = error.details as { requiredPermissions?: unknown } | undefined;
  return Array.isArray(details?.requiredPermissions) && details.requiredPermissions.includes('finance.view');
}

/** Сообщение об ошибке команды заявки — код важнее общего message сервера, если он известен. */
export function supplierRequestErrorMessage(error: { code?: string; message?: string; details?: unknown } | null | undefined): string {
  if (!error) return 'Не удалось выполнить операцию';
  if (isFinancePermissionDenied(error)) return 'Нужно право на финансы (finance.view)';
  const known = error.code ? SUPPLIER_REQUEST_ERROR_MESSAGES[error.code] : undefined;
  return known ?? error.message ?? 'Не удалось выполнить операцию';
}

function formatDateOnly(value: string): string {
  const [year, month, day] = value.split('-');
  return year && month && day ? `${day}.${month}.${year}` : value;
}

/** Текст «Скопировать для поставщика» (план §6): заявка, позиции, срок, комментарий. */
export function buildSupplierCopyText(card: Pick<SupplierRequestCardDto, 'requestNumber' | 'supplierName' | 'lineItems' | 'expectedDate' | 'comment'>): string {
  const lines = [
    `Заявка ${card.requestNumber} · ${card.supplierName}`,
    ...card.lineItems.map((line) => formatLineItemText(line)),
  ];
  if (card.expectedDate) lines.push(`Ожидаем к: ${formatDateOnly(card.expectedDate)}`);
  if (card.comment) lines.push(card.comment);
  return lines.join('\n');
}

export interface RequestFormState {
  supplierTouched: boolean;
  comment: string;
  expectedDate: string | null;
  lineEdits: Record<number, { quantity: number; orders: Record<number, number> }>;
}

/** Есть ли несохранённые правки черновика относительно карточки (CR3-2). */
export function hasUnsavedRequestChanges(
  card: { comment: string | null; expectedDate: string | null },
  form: RequestFormState,
  baseline: Record<number, { quantity: number; orders: Record<number, number> }>,
): boolean {
  if (form.supplierTouched) return true;
  if ((form.comment.trim() || null) !== (card.comment ?? null)) return true;
  if ((form.expectedDate ?? null) !== (card.expectedDate ?? null)) return true;
  const normalize = (edits: RequestFormState['lineEdits']) => JSON.stringify(Object.keys(edits).map(Number).sort((a, b) => a - b).map((lineId) => [
    lineId,
    roundTo3Number(edits[lineId].quantity),
    Object.keys(edits[lineId].orders).map(Number).sort((a, b) => a - b).map((orderId) => [orderId, roundTo3Number(edits[lineId].orders[orderId])]),
  ]));
  return normalize(form.lineEdits) !== normalize(baseline);
}
