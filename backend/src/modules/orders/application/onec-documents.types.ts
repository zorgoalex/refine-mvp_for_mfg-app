import type { CurrentUser } from '../../../permissions/current-user';
import type { OrderResourceCapabilitiesDto, OrderResourceDemandLineDto, OrderResourceKind } from './order-resource-demand.types';

export type OnecDocKind = 'purchase_receipt' | 'cash_outflow' | 'bank_outflow';

/**
 * Виды документов 1С, с которыми работает закуп. Общий слой onec_documents получает и другие виды (расход, списания,
 * перемещения — потребитель склад); все пути чтения и команд закупа явно ограничены этим списком: чужой вид —
 * «не найден», а не «оплата».
 */
export const PROCUREMENT_DOC_KINDS: readonly OnecDocKind[] = ['purchase_receipt', 'cash_outflow', 'bank_outflow'];
export type OnecDocumentsTab = 'receipts' | 'payments';
export type OnecAllocationRole = 'receipt' | 'payment';
export type OnecUnitCode = 'sheet' | 'm2' | 'lm' | 'pcs' | 'set';

export interface OnecDocumentListQuery {
  tab: OnecDocumentsTab;
  page: number;
  pageSize: number;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  /** Только документы без активных распределений. */
  unlinkedOnly?: boolean;
  /** Только проведённые и не удалённые в 1С. */
  postedOnly?: boolean;
}

export interface OnecDocumentOrderRefDto {
  orderId: number;
  orderName: string;
}

export interface OnecDocumentListItemDto {
  documentId: number;
  kind: OnecDocKind;
  number: string;
  date: string;
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
  allocationState: 'none' | 'partial' | 'full';
  /** Заказы в scope пользователя; остальные — только счётчиком. */
  orders: OnecDocumentOrderRefDto[];
  hiddenOrdersCount: number;
  resourceKinds: OrderResourceKind[];
}

export interface OnecDocumentListResponseDto {
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
  createdAt: string;
  createdByName: string | null;
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
  material: { resourceKey: string; kind: OrderResourceKind; refId: number; name: string } | null;
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
  loadedAt: string;
  lines: OnecDocumentLineDto[];
}

export interface OnecDocumentCardResponseDto {
  data: OnecDocumentCardDto;
  capabilities: OrderResourceCapabilitiesDto;
  amountsVisible: boolean;
}

export interface AddOnecAllocationCommand {
  currentUser: CurrentUser;
  documentId: number;
  lineId: number;
  orderId: number;
  resourceKey: string;
  quantity?: number;
  amount?: number;
  expectedVersion: number;
  expectedDemandFingerprint: string;
  requestId: string;
}

export interface RemoveOnecAllocationCommand {
  currentUser: CurrentUser;
  documentId: number;
  lineId: number;
  allocationId: number;
  expectedVersion: number;
  requestId: string;
}

export interface OnecAllocationResultDto {
  changed: boolean;
  allocationId: number;
  orderId: number;
  resourceKey: string;
  line: OrderResourceDemandLineDto;
}

export interface OnecDocumentReadOptions {
  procurementEnabled: boolean;
  canSeeAmounts: boolean;
  /** BACKEND_PROCUREMENT_WORKSPACE_ENABLED — для capabilities.supplyWorkspace (кнопка «Подобрать заказы»). */
  supplyWorkspaceEnabled?: boolean;
}

/** Групповое распределение прихода на несколько заказов (экран снабжения, фаза 2, план §5.4). */
export const ONEC_ALLOCATION_BATCH_LIMIT = 100;

export interface BatchOnecAllocationItem {
  lineId: number;
  orderId: number;
  resourceKey: string;
  /** Итоговое количество НОВОГО распределения, в единице строки документа. */
  quantity: number;
  expectedVersion: number;
  expectedDemandFingerprint: string;
  /** Единица строки документа, в которой считано предложение (CR3-1). */
  expectedDocUnit: OnecUnitCode | null;
  /** Площадь листа материала (м²), по которой пересчитано предложение; null — не листовой/нет размеров. */
  expectedSheetAreaM2: number | null;
  /** Связи нового распределения с заказами строк отправленных заявок (ф.3б): количество — в единице строки заявки. */
  requestLinks?: Array<{ lineOrderId: number; quantity: number }>;
}

export interface BatchOnecAllocationCommand {
  currentUser: CurrentUser;
  documentId: number;
  requestId: string;
  /** 'suggested' — из автоподбора, 'manual' — набрано вручную. */
  origin: 'suggested' | 'manual';
  items: BatchOnecAllocationItem[];
}

export interface BatchOnecAllocationFailure {
  index: number;
  code: string;
  message: string;
}

export interface BatchOnecAllocationResultDto {
  changed: boolean;
  results: Array<{ index: number; allocationId: number; noop: boolean }>;
  /** Актуальные строки потребности затронутых заказов (по orderId|resourceKey). */
  lines: Array<{ orderId: number; line: OrderResourceDemandLineDto }>;
}

export interface AllocationSuggestionCandidateDto {
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
   * Разбиение предложенного количества по открытым строкам отправленных заявок (ф.3б) — отправляются в batch как
   * requestLinks; количество — в единице строки заявки. Пусто — приход без ссылки на заявку.
   */
  requestLinks: Array<{ lineOrderId: number; supplierRequestId: number; requestNumber: string; quantity: number; unit: OnecUnitCode }>;
}

export interface AllocationSuggestionLineDto {
  lineId: number;
  lineNo: number;
  nomenclatureName: string | null;
  material: { resourceKey: string; kind: OrderResourceKind; refId: number; name: string } | null;
  docUnit: OnecUnitCode | null;
  demandUnit: 'm2' | 'lm' | null;
  /** Площадь листа, м² — для пересчёта «листы ↔ м²» на клиенте. */
  sheetAreaM2: number | null;
  capacityInDocUnit: number;
  remainingInDocUnit: number;
  /** Почему строка не участвует в автоподборе (null — участвует). */
  skipReason: 'removed_in_onec' | 'onec_conflict' | 'not_mapped' | 'incompatible_unit' | 'fully_allocated' | null;
  alreadyAllocated: Array<{ orderId: number; orderName: string; quantityInDocUnit: number }>;
  candidates: AllocationSuggestionCandidateDto[];
  surplusInDocUnit: number;
}

export interface AllocationSuggestionsResponseDto {
  documentId: number;
  number: string;
  date: string;
  supplierName: string | null;
  wastePercent: number;
  /** Не больше стольких предложенных распределений — лимит одной групповой команды. */
  proposalLimit: number;
  /** true — кандидатов больше лимита: остаток распределяется следующим подбором. */
  proposalLimitReached: boolean;
  lines: AllocationSuggestionLineDto[];
}
