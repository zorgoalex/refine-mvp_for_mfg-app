import type { DateOnlyString, IsoDateTimeString, OrderResourceCapabilitiesDto, OrderResourceDemandLineDto, OrderResourceKind } from './orderApi.types';

export type OnecDocKind = 'purchase_receipt' | 'cash_outflow' | 'bank_outflow';
export type OnecDocumentsTab = 'receipts' | 'payments';
export type OnecAllocationRole = 'receipt' | 'payment';
export type OnecUnitCode = 'sheet' | 'm2' | 'lm' | 'pcs' | 'set';
export type OnecAllocationState = 'none' | 'partial' | 'full';

export interface OnecDocumentListParams {
  tab: OnecDocumentsTab;
  page?: number;
  pageSize?: number;
  search?: string;
  dateFrom?: DateOnlyString;
  dateTo?: DateOnlyString;
  /** Только документы без активных распределений. */
  unlinkedOnly?: boolean;
  /** Только проведённые и не удалённые в 1С. */
  postedOnly?: boolean;
  /** Только приходы: `open` — не распределён или частично, `full` — полностью. Старый backend параметр отклоняет (422). */
  allocation?: 'open' | 'full';
  /** Добавить краткий состав строк (`lineSummary`). */
  withLines?: boolean;
  /** Только документы поставщиков из справочника ERP (связанных с контрагентом 1С). */
  knownSupplierOnly?: boolean;
}

export interface OnecDocumentLineSummaryDto {
  lineNo: number;
  name: string;
  quantity: number;
  unitName: string | null;
}

export interface OnecDocumentOrderRefDto {
  orderId: number;
  orderName: string;
}

export interface OnecDocumentListItemDto {
  documentId: number;
  kind: OnecDocKind;
  number: string;
  date: DateOnlyString;
  counterpartyName: string | null;
  supplierName: string | null;
  /** null без права finance.view. */
  amount: number | null;
  currency: string;
  posted: boolean;
  deletedInOnec: boolean;
  /** Нет в последней выгрузке 1С — только диагностика, распределения не запрещает. */
  missingInSource: boolean;
  linesCount: number;
  allocationState: OnecAllocationState;
  /** Заказы в scope пользователя; остальные — только счётчиком. */
  orders: OnecDocumentOrderRefDto[];
  hiddenOrdersCount: number;
  resourceKinds: OrderResourceKind[];
  /** Первые строки документа — только при `withLines`. */
  lineSummary?: OnecDocumentLineSummaryDto[];
  lineSummaryMore?: number;
}

export interface OnecDocumentListResponse {
  data: OnecDocumentListItemDto[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  capabilities: OrderResourceCapabilitiesDto;
  amountsVisible: boolean;
}

export interface OnecAllocationDto {
  allocationId: number;
  orderId: number;
  orderName: string;
  resourceKey: string;
  role: OnecAllocationRole;
  quantity: number | null;
  /** null без права finance.view. */
  amount: number | null;
  origin: 'auto' | 'manual' | 'suggested';
  /** Версия закупа материала заказа — expectedVersion для снятия распределения. */
  procurementVersion: number;
  createdAt: IsoDateTimeString;
  createdByName: string | null;
}

export interface OnecDocumentLineMaterialRefDto {
  resourceKey: string;
  kind: OrderResourceKind;
  refId: number;
  name: string;
}

export interface OnecDocumentLineDto {
  lineId: number;
  lineNo: number;
  nomenclatureName: string | null;
  quantity: number;
  unitName: string | null;
  unitCode: OnecUnitCode | null;
  price: number | null;
  amount: number | null;
  isDocumentTotal: boolean;
  material: OnecDocumentLineMaterialRefDto | null;
  /** Сумма активных распределений (количество для прихода, сумма для оплаты; для оплаты без finance.view — null). */
  allocated: number | null;
  remaining: number | null;
  /** Строка удалена в 1С (хранится ради истории распределений) — новые распределения запрещены. */
  removedInOnec: boolean;
  /** Изменение 1С не применено из-за распределений (код конфликта) — новые распределения запрещены. */
  onecConflict: string | null;
  allocations: OnecAllocationDto[];
  hiddenAllocationsCount: number;
}

export interface OnecDocumentCardDto extends Omit<OnecDocumentListItemDto, 'orders' | 'hiddenOrdersCount' | 'linesCount'> {
  sourceCode: string;
  comment: string | null;
  loadedAt: IsoDateTimeString;
  lines: OnecDocumentLineDto[];
}

export interface OnecDocumentCardResponse {
  data: OnecDocumentCardDto;
  capabilities: OrderResourceCapabilitiesDto;
  amountsVisible: boolean;
}

export interface AddOnecAllocationRequest {
  orderId: number;
  resourceKey: string;
  quantity?: number;
  amount?: number;
  expectedVersion: number;
  expectedDemandFingerprint: string;
}

export interface RemoveOnecAllocationRequest {
  expectedVersion: number;
}

export interface OnecAllocationResultDto {
  changed: boolean;
  allocationId: number;
  orderId: number;
  resourceKey: string;
  line: OrderResourceDemandLineDto;
}

/** Автоподбор заказов для прихода 1С (экран снабжения, фаза 2). Количества — в единице строки (`docUnit`) и потребности. */
export interface AllocationSuggestionCandidate {
  orderId: number;
  orderName: string;
  fullNumber: string;
  clientName: string | null;
  dueDate: string | null;
  urgency: 'overdue' | 'critical' | 'soon' | 'normal' | 'no_date';
  daysLeft: number | null;
  demandUnit: 'm2' | 'lm';
  needInDemandUnit: number;
  deficitInDemandUnit: number;
  proposedInDocUnit: number;
  proposedInDemandUnit: number;
  reasons: Array<{ code: 'onec_order' | 'request' | 'due' | 'unmarked' | 'supplier' | 'closes'; label: string; tone: 'info' | 'error' | 'warning' | 'success' | 'default' }>;
  purchased: boolean;
  procurementVersion: number;
  demandFingerprint: string;
  /**
   * Разбиение предложенного количества по открытым строкам отправленных заявок поставщикам (ф.3б): отправляется в
   * batch как requestLinks; количество — в единице строки заявки. Старый backend поле не присылает — трактовать как [].
   */
  requestLinks?: Array<{ lineOrderId: number; supplierRequestId: number; requestNumber: string; quantity: number; unit: OnecUnitCode }>;
}

export interface AllocationSuggestionLine {
  lineId: number;
  lineNo: number;
  nomenclatureName: string | null;
  material: { resourceKey: string; kind: 'sheet_material' | 'film'; refId: number; name: string } | null;
  docUnit: OnecUnitCode | null;
  demandUnit: 'm2' | 'lm' | null;
  sheetAreaM2: number | null;
  capacityInDocUnit: number;
  remainingInDocUnit: number;
  skipReason: 'removed_in_onec' | 'onec_conflict' | 'not_mapped' | 'incompatible_unit' | 'fully_allocated' | null;
  alreadyAllocated: Array<{ orderId: number; orderName: string; quantityInDocUnit: number }>;
  candidates: AllocationSuggestionCandidate[];
  surplusInDocUnit: number;
}

export interface AllocationSuggestionsResponse {
  documentId: number;
  number: string;
  date: string;
  supplierName: string | null;
  wastePercent: number;
  proposalLimit: number;
  proposalLimitReached: boolean;
  lines: AllocationSuggestionLine[];
}

export interface BatchOnecAllocationRequest {
  requestId: string;
  origin: 'suggested' | 'manual';
  items: Array<{
    lineId: number;
    orderId: number;
    resourceKey: string;
    /** Итоговое количество нового распределения в единице строки документа, до 3 знаков. */
    quantity: number;
    expectedVersion: number;
    expectedDemandFingerprint: string;
    /** Контекст пересчёта единиц предложения — сверяется сервером. */
    expectedDocUnit: OnecUnitCode | null;
    expectedSheetAreaM2: number | null;
    /** Связи нового распределения с заказами строк отправленных заявок (ф.3б); количество — в единице строки заявки. */
    requestLinks?: Array<{ lineOrderId: number; quantity: number }>;
  }>;
}

export interface BatchOnecAllocationResponse {
  changed: boolean;
  results: Array<{ index: number; allocationId: number; noop: boolean }>;
}

/** 409 ONEC_ALLOCATION_BATCH_CONFLICT: details.failures — по элементам запроса. */
export interface BatchOnecAllocationFailure {
  index: number;
  code: string;
  message: string;
}

/** «Привязать к заявке» / «Отвязать» (ф.3б, ф.3б-2) — тело команды и результат. */
export interface RequestLinkRequest {
  lineOrderId: number;
  /** Приход: в единице строки заявки, до 3 знаков. Ровно одно из quantity/amount. */
  quantity?: number;
  /** Оплата (ф.3б-2, finance.view): сумма в валюте документа, до 2 знаков. Ровно одно из quantity/amount. */
  amount?: number;
  /** Версия закупа распределения. */
  expectedVersion: number;
}

export interface UnlinkRequestLinkRequest {
  expectedVersion: number;
}

export interface RequestLinkResultDto {
  changed: boolean;
  linkId: number;
  allocationId: number;
  procurementVersion: number;
  /** 'unknown' — поставщика документа и заявки не сравнить. */
  supplierCheck?: 'match' | 'unknown';
}
