import type { OnecDocumentState } from '../domain/onec-document-state';
import type { CurrentUser } from '../../../permissions/current-user';

export interface OrderResourceDemandQuery {
  page: number;
  pageSize: number;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  sheetMaterialTypeId?: number;
  filmId?: number;
  supplierId?: number;
  vendorId?: number;
  /** Только заказы, у которых есть хотя бы один незакупленный материал. */
  unpurchasedOnly?: boolean;
  /** Только заказы, на которые распределён этот документ 1С (активные распределения). */
  onecDocumentId?: number;
  /** Фильтр заголовка «Заказ»: только эти заказы. */
  orderIds?: number[];
  /** Фильтр заголовка «Дата заказа»: эти даты и/или заказы без даты. */
  orderDates?: ResourceDemandValueFilter<string>;
  /** Фильтр заголовка «Листовые материалы»: заказы с любым из материалов и/или без листовых. */
  sheetMaterialTypeIds?: ResourceDemandValueFilter<number>;
  /** Фильтр заголовка «Плёнка»: заказы с любой из плёнок и/или без плёнки. */
  filmIds?: ResourceDemandValueFilter<number>;
  /**
   * Фильтр заголовка «Поставщик»: ключи основного поставщика позиции (`s:<id>`, `c:…`, `n:…`, `none` — без поставщика).
   * Заказ подходит, если хоть один его материал — от выбранного поставщика; в ответе остаются только такие материалы.
   */
  supplierKeys?: string[];
  /** `supplierKeys` — исключённые поставщики («все, кроме»: длинный выбор передаётся дополнением). */
  supplierKeysExclude?: boolean;
  /** Только заказы, у которых есть готовый раскрой плёнки на ванне (метры посчитаны). */
  readyCutsOnly?: boolean;
  /** Оплата: `any_paid` — частично или полностью оплачен, `fully_paid` — только полностью. */
  payment?: OrderResourcePaymentFilter;
  /** Сортировка списка по всем страницам; без неё — дата заказа, новые сверху. */
  sort?: OrderResourceDemandSort;
}

export type OrderResourceDemandSortKey = 'order' | 'date' | 'sheetMaterials' | 'films';

export interface OrderResourceDemandSort {
  key: OrderResourceDemandSortKey;
  direction: 'asc' | 'desc';
}

export interface ResourceDemandValueFilter<T> {
  /** Выбранные значения; при `exclude` — исключённые («все, кроме»). */
  values: T[];
  /** Включить заказы без значения (без даты / без листовых / без плёнки). */
  includeEmpty: boolean;
  /** «Все, кроме `values`»: длинный выбор передаётся дополнением, чтобы уложиться в лимит значений. */
  exclude?: boolean;
}

export type OrderResourcePaymentFilter = 'any_paid' | 'fully_paid';

/** Ключ «без поставщика» в фильтре и в `supplierKey` строки. */
export const RESOURCE_SUPPLIER_NONE_KEY = 'none';
/** Лимит значений в одном фильтре заголовка. */
export const RESOURCE_HEADER_FILTER_VALUES_LIMIT = 500;
/** Лимит заказов в вариантах фильтра «Заказ». */
export const RESOURCE_FILTER_ORDER_OPTIONS_LIMIT = 300;

export interface OrderSheetMaterialDemandDto {
  sheetMaterialTypeId: number;
  name: string;
  totalArea: number;
  detailsCount: number;
  supplierId: number | null;
  supplierName: string | null;
}

export interface OrderFilmDemandDto {
  filmId: number;
  name: string;
  totalArea: number;
  detailsCount: number;
  linearMeters: number;
  sheets: number;
  hasCutData: boolean;
  vendorId: number | null;
  vendorName: string | null;
  /** Основной поставщик плёнки (первый выбранный, иначе по приходам 1С); производитель — vendorName, справочно. */
  supplierName: string | null;
}

export type OrderResourceKind = 'sheet_material' | 'film';
export type OrderResourceUnit = 'm2' | 'lm';
/** Откуда количество: готовый раскрой, площадь деталей или нет данных. */
export type OrderResourceSource = 'cut' | 'area' | 'none';

export interface OrderResourceProcurementDto {
  purchased: boolean;
  /** 0 — записи закупа ещё нет. */
  version: number;
  origin: 'manual' | 'onec' | null;
  markedAt: string | null;
  markedBy: { userId: number; name: string } | null;
  quantityAtMark: number | null;
  unitAtMark: OrderResourceUnit | null;
  /** Потребность изменилась после отметки «Закуплено». */
  changedSinceMark: boolean;
}

export interface OrderResourceDemandLineDto {
  resourceKey: string;
  kind: OrderResourceKind;
  refId: number;
  name: string;
  /**
   * Прежний смысл (его читает прежний интерфейс): листовой — поставщик, плёнка — производитель, у «сироты»-плёнки null.
   * Поставщик позиции — `mainSupplierName`.
   */
  supplierName: string | null;
  /** Основной поставщик позиции (с migr 280; правило «Экрана снабжения»); null — не указан. */
  mainSupplierName: string | null;
  /** Есть `mainSupplierName` — поставщик позиции (признак backend с migr 280). */
  supplierRole: 'supplier';
  /** Ключ основного поставщика (как в фильтре «Поставщик»); `none` — поставщик не указан. */
  supplierKey: string;
  /** null — количество не посчитано (нет готового раскроя у плёнки). */
  quantity: number | null;
  unit: OrderResourceUnit;
  areaM2: number;
  detailsCount: number;
  source: OrderResourceSource;
  demandFingerprint: string;
  /** Отметка закупа есть, а материал заказу больше не нужен. */
  orphan: boolean;
  procurement: OrderResourceProcurementDto;
  /** Документы 1С, распределённые на этот закуп (активные распределения). */
  onec: { receipts: OrderResourceOnecDocRefDto[]; payments: OrderResourceOnecDocRefDto[] };
  /** Снять «Закуплено» нельзя: есть приход из проведённого документа 1С. */
  lockedByOnec: boolean;
}

export interface OrderResourceOnecDocRefDto {
  documentId: number;
  allocationId: number;
  kind: 'purchase_receipt' | 'cash_outflow' | 'bank_outflow';
  number: string;
  date: string;
  quantity: number | null;
  /** null без права finance.view. */
  amount: number | null;
  linkOrigin: 'auto' | 'manual' | 'suggested';
  posted: boolean;
  deletedInOnec: boolean;
  /** Состояние документа 1С: active/conflict — действует; остальные — в итоги не входят (показывается со статусом). */
  documentState: OnecDocumentState;
}

export interface OrderProcurementSummaryDto {
  total: number;
  purchased: number;
  orphanPurchased: number;
}

export interface OrderResourceCapabilitiesDto {
  procurement: boolean;
  byMaterial: boolean;
  cardDetails: boolean;
  onecDocuments: boolean;
  /** Вкладка «Экран снабжения»: BACKEND_PROCUREMENT_WORKSPACE_ENABLED и флаг закупа. */
  supplyWorkspace: boolean;
  /**
   * Backend сам применяет фильтры заголовков, «Готовые раскрои», «Оплату» и «Поставщика» (по всем страницам).
   * Без признака (прежний backend) интерфейс эти фильтры не показывает: их параметры были бы молча проигнорированы.
   */
  serverFilters: boolean;
  /** Сервер сортирует список по `sort`/`sortOrder` (по всем страницам). */
  serverSort: boolean;
}

export interface OrderResourceDemandDto {
  orderId: number;
  orderName: string;
  fullNumber: string;
  orderDate: string | null;
  projectCode: string;
  clientName: string | null;
  updatedAt: string;
  sheetMaterials: OrderSheetMaterialDemandDto[];
  films: OrderFilmDemandDto[];
  lines: OrderResourceDemandLineDto[];
  procurementSummary: OrderProcurementSummaryDto;
}

export interface OrderResourceDemandResponseDto {
  data: OrderResourceDemandDto[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  refreshedAt: string;
  capabilities: OrderResourceCapabilitiesDto;
}

export interface OrderResourceDetailRefDto {
  source: 'detail' | 'hdf';
  id: number;
  detailNumber: number | null;
  name: string | null;
  heightMm: number | null;
  widthMm: number | null;
  quantity: number | null;
}

export interface OrderResourceCardLineDto extends OrderResourceDemandLineDto {
  details: OrderResourceDetailRefDto[];
}

export interface OrderResourceCardDto extends Omit<OrderResourceDemandDto, 'lines'> {
  lines: OrderResourceCardLineDto[];
}

export interface OrderResourceCardResponseDto {
  data: OrderResourceCardDto;
  refreshedAt: string;
  capabilities: OrderResourceCapabilitiesDto;
}

export interface OrderResourceMaterialParticipantDto {
  orderId: number;
  orderName: string;
  purchased: boolean;
  version: number;
  demandFingerprint: string;
}

export interface OrderResourceMaterialAggregateDto {
  resourceKey: string;
  kind: OrderResourceKind;
  refId: number;
  name: string;
  /** Как у строки: прежний смысл (у плёнки — производитель); поставщик — `mainSupplierName`. */
  supplierName: string | null;
  mainSupplierName: string | null;
  supplierRole: 'supplier';
  unit: OrderResourceUnit;
  totalQuantity: number;
  ordersCount: number;
  detailsCount: number;
  noDataOrders: number;
  purchasedOrders: number;
  participants: OrderResourceMaterialParticipantDto[];
}

export interface OrderResourceByMaterialResponseDto {
  data: OrderResourceMaterialAggregateDto[];
  ordersCount: number;
  refreshedAt: string;
  capabilities: OrderResourceCapabilitiesDto;
}

/** Документ 1С, распределённый на заказы текущей выборки списка потребностей. */
export interface OrderResourceOnecDocumentOptionDto {
  documentId: number;
  kind: 'purchase_receipt' | 'cash_outflow' | 'bank_outflow';
  number: string;
  date: string;
  ordersCount: number;
}

export interface OrderResourceOnecDocumentOptionsResponseDto {
  data: OrderResourceOnecDocumentOptionDto[];
  /** Документов больше лимита — показаны самые свежие. */
  truncated: boolean;
}

/** Лимит вариантов фильтра «Документ 1С». */
export const RESOURCE_ONEC_DOCUMENT_OPTIONS_LIMIT = 200;

/**
 * Варианты фильтров заголовков: по всем заказам выборки (все страницы, фильтры панели и scope), без учёта самих
 * фильтров заголовков — список значений не сужается от выбора в соседней колонке.
 */
export interface OrderResourceFilterOptionsResponseDto {
  orders: Array<{ orderId: number; orderName: string; projectCode: string; clientName: string | null }>;
  /** Заказов больше лимита — показаны самые свежие. */
  ordersTruncated: boolean;
  dates: string[];
  hasEmptyDate: boolean;
  sheetMaterials: Array<{ id: number; name: string }>;
  hasNoSheetMaterials: boolean;
  films: Array<{ id: number; name: string }>;
  hasNoFilms: boolean;
  /** Основные поставщики материалов выборки; `none` — есть материалы без поставщика. */
  suppliers: Array<{ key: string; name: string }>;
}

export interface ListOrderResourceDemandsCommand {
  currentUser: CurrentUser;
  query: OrderResourceDemandQuery;
}

export interface GetOrderResourceCardCommand {
  currentUser: CurrentUser;
  orderId: number;
}

export interface OrderResourceReadOptions {
  /** Флаг BACKEND_RESOURCE_PROCUREMENT_ENABLED: без него таблица закупа не читается. */
  procurementEnabled: boolean;
  /** Право finance.view: суммы документов 1С. Без него — null. */
  canSeeAmounts?: boolean;
  /** Флаг BACKEND_PROCUREMENT_WORKSPACE_ENABLED (только для capabilities). */
  supplyWorkspaceEnabled?: boolean;
}

export interface OrderResourceDemandRepositoryPort {
  list(command: ListOrderResourceDemandsCommand, options: OrderResourceReadOptions): Promise<OrderResourceDemandResponseDto>;
  getCard(command: GetOrderResourceCardCommand, options: OrderResourceReadOptions): Promise<OrderResourceCardResponseDto>;
  listByMaterial(
    command: ListOrderResourceDemandsCommand,
    options: OrderResourceReadOptions,
  ): Promise<OrderResourceByMaterialResponseDto>;
  listOnecDocumentOptions(
    command: ListOrderResourceDemandsCommand,
    options: OrderResourceReadOptions,
  ): Promise<OrderResourceOnecDocumentOptionsResponseDto>;
  listFilterOptions(
    command: ListOrderResourceDemandsCommand,
    options: OrderResourceReadOptions,
  ): Promise<OrderResourceFilterOptionsResponseDto>;
}

/** Лимит заказов для агрегата «по материалам» (R1-8). */
export const RESOURCE_BY_MATERIAL_ORDER_LIMIT = 500;
/** Лимит заказов в групповой отметке закупа. */
export const RESOURCE_PROCUREMENT_BULK_LIMIT = 100;

export interface SetOrderResourceProcurementInput {
  purchased: boolean;
  expectedVersion: number;
  expectedDemandFingerprint: string;
}

export interface SetOrderResourceProcurementCommand extends SetOrderResourceProcurementInput {
  currentUser: CurrentUser;
  orderId: number;
  resourceKey: string;
  requestId: string;
}

export interface BulkOrderResourceProcurementCommand {
  currentUser: CurrentUser;
  resourceKey: string;
  purchased: boolean;
  items: Array<{ orderId: number; expectedVersion: number; expectedDemandFingerprint: string }>;
  requestId: string;
}

export interface OrderResourceProcurementResultDto {
  orderId: number;
  resourceKey: string;
  changed: boolean;
  line: OrderResourceDemandLineDto;
}

export interface BulkOrderResourceProcurementResultDto {
  results: OrderResourceProcurementResultDto[];
}
