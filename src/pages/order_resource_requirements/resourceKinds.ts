import type {
  OrderResourceCapabilitiesDto,
  OrderResourceCardLineDto,
  OrderResourceDemandLineDto,
  OrderResourceDemandResponse,
  OrderResourceDetailRefDto,
  OrderResourceOnecDocRefDto,
} from '../../api/types/orderApi.types';

export type OrderResourceDemandRow = OrderResourceDemandResponse['data'][number];

export type ResourceKind = 'sheet_material' | 'film';
export type ResourceUnit = 'm2' | 'lm';
/** Откуда взято количество: готовый раскрой, площадь деталей или данных нет. */
export type ResourceSource = 'cut' | 'area' | 'none';

/** Состояние отметки «Закуплено» одной строки потребности (API v2). */
export interface ResourceProcurementState {
  purchased: boolean;
  /** 0 — записи закупа ещё нет. */
  version: number;
  origin: 'manual' | 'onec' | null;
  markedAt: string | null;
  markedByName: string | null;
  quantityAtMark: number | null;
  /** Потребность изменилась после отметки. */
  changedSinceMark: boolean;
}

/** Ссылка на документ 1С в едином виде строки потребности (фаза 3). */
export type ResourceOnecDocRef = OrderResourceOnecDocRefDto;

export interface ResourceOnecDocRefs {
  receipts: ResourceOnecDocRef[];
  payments: ResourceOnecDocRef[];
}

export const EMPTY_ONEC_DOC_REFS: ResourceOnecDocRefs = { receipts: [], payments: [] };

export interface ResourceDemandLine {
  resourceKey: string;
  kind: ResourceKind;
  refId: number;
  name: string;
  supplierLabel: string | null;
  /** null — количество не посчитано (например, нет готового раскроя). */
  quantity: number | null;
  unit: ResourceUnit;
  secondaryText: string | null;
  detailsCount: number;
  source: ResourceSource;
  /**
   * Отсутствует (undefined/null) у строк, полученных адаптером старого API —
   * там нет отметки закупа. У строк API v2 — состояние закупа этой строки.
   */
  procurement?: ResourceProcurementState | null;
  /** Хеш вычисленной потребности; нужен для команды отметки закупа. Только API v2. */
  demandFingerprint?: string;
  /** Отметка закупа есть, а материал заказу больше не нужен. Только API v2. */
  orphan?: boolean;
  /** Детали, из которых складывается потребность строки. Только карточка (capabilities.cardDetails). */
  details?: OrderResourceDetailRefDto[];
  /** Документы 1С, распределённые на закуп строки. Только при `capabilities.onecDocuments`. */
  onec?: ResourceOnecDocRefs;
  /** Снять «Закуплено» нельзя: есть приход из проведённого документа 1С. Только при `capabilities.onecDocuments`. */
  lockedByOnec?: boolean;
}

/** Документы 1С строки потребности, всегда непустой массив-заглушка вместо undefined. */
export function resourceLineOnecDocs(line: ResourceDemandLine): ResourceOnecDocRefs {
  return line.onec ?? EMPTY_ONEC_DOC_REFS;
}

export function resourceLineHasOnecDocs(line: ResourceDemandLine): boolean {
  const docs = resourceLineOnecDocs(line);
  return docs.receipts.length > 0 || docs.payments.length > 0;
}

export interface ResourceKindMeta {
  kind: ResourceKind;
  label: string;
  shortLabel: string;
  letter: string;
  unit: ResourceUnit;
  color: { light: string; dark: string };
}

/**
 * Реестр типов ресурсов. Новый тип (кромка, фурнитура) добавляется записью здесь
 * и веткой адаптера `resourceDemandLines`; виды списка и карточки строятся по реестру.
 */
export const RESOURCE_KINDS: readonly ResourceKindMeta[] = [
  {
    kind: 'sheet_material',
    label: 'Листовые материалы',
    shortLabel: 'Листовые',
    letter: 'Л',
    unit: 'm2',
    color: { light: '#a0661c', dark: '#e0a45a' },
  },
  {
    kind: 'film',
    label: 'Плёнка',
    shortLabel: 'Плёнка',
    letter: 'П',
    unit: 'lm',
    color: { light: '#0e8f84', dark: '#4fd1c2' },
  },
];

export const RESOURCE_KIND_BY_KEY: Record<ResourceKind, ResourceKindMeta> = Object.fromEntries(
  RESOURCE_KINDS.map((meta) => [meta.kind, meta]),
) as Record<ResourceKind, ResourceKindMeta>;

export const SOURCE_LABELS: Record<ResourceSource, string> = {
  cut: 'по раскрою',
  area: 'по площади',
  none: 'нет раскроя',
};

const areaFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const meterFormatter = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export const UNIT_LABELS: Record<ResourceUnit, string> = {
  m2: 'м²',
  lm: 'пог. м',
};

export function formatResourceQuantity(value: number, unit: ResourceUnit): string {
  const formatter = unit === 'lm' ? meterFormatter : areaFormatter;
  return `${formatter.format(value)} ${UNIT_LABELS[unit]}`;
}

export function formatArea(value: number): string {
  return `${areaFormatter.format(value)} м²`;
}

/**
 * Единые строки потребности заказа. При наличии `row.lines` (API v2, ответ с
 * `capabilities`) использует их напрямую — с отметкой закупа, отпечатком
 * потребности и признаком «осиротела». Иначе — адаптер старого API
 * (`sheetMaterials`/`films`), совместимый со смешанным деплоем.
 */
export function resourceDemandLines(row: OrderResourceDemandRow): ResourceDemandLine[] {
  if (row.lines) return row.lines.map(mapBackendResourceLine);
  return legacyResourceDemandLines(row);
}

/** Строки из API v2 в единый вид, включая закуп/отпечаток/деталей (карточка). */
export function mapBackendResourceLine(
  line: OrderResourceDemandLineDto | OrderResourceCardLineDto,
): ResourceDemandLine {
  return {
    resourceKey: line.resourceKey,
    kind: line.kind,
    refId: line.refId,
    name: line.name,
    supplierLabel: line.supplierName
      ? `${line.kind === 'film' ? 'Производитель' : 'Поставщик'}: ${line.supplierName}`
      : null,
    quantity: line.quantity,
    unit: line.unit,
    secondaryText: line.kind === 'film' ? formatArea(line.areaM2) : null,
    detailsCount: line.detailsCount,
    source: line.source,
    procurement: {
      purchased: line.procurement.purchased,
      version: line.procurement.version,
      origin: line.procurement.origin,
      markedAt: line.procurement.markedAt,
      markedByName: line.procurement.markedBy?.name ?? null,
      quantityAtMark: line.procurement.quantityAtMark,
      changedSinceMark: line.procurement.changedSinceMark,
    },
    demandFingerprint: line.demandFingerprint,
    orphan: line.orphan,
    onec: line.onec ?? EMPTY_ONEC_DOC_REFS,
    lockedByOnec: line.lockedByOnec ?? false,
    ...('details' in line ? { details: line.details } : {}),
  };
}

/** Адаптер старого ответа API (`sheetMaterials`/`films`) в единые строки потребности. */
function legacyResourceDemandLines(row: OrderResourceDemandRow): ResourceDemandLine[] {
  const sheetLines = row.sheetMaterials.map<ResourceDemandLine>((material) => ({
    resourceKey: `sheet_material:${material.sheetMaterialTypeId}`,
    kind: 'sheet_material',
    refId: material.sheetMaterialTypeId,
    name: material.name,
    supplierLabel: material.supplierName ? `Поставщик: ${material.supplierName}` : null,
    quantity: material.totalArea,
    unit: 'm2',
    secondaryText: null,
    detailsCount: material.detailsCount,
    source: 'area',
  }));
  const filmLines = row.films.map<ResourceDemandLine>((film) => ({
    resourceKey: `film:${film.filmId}`,
    kind: 'film',
    refId: film.filmId,
    name: film.name,
    supplierLabel: film.vendorName ? `Производитель: ${film.vendorName}` : null,
    quantity: film.hasCutData ? film.linearMeters : null,
    unit: 'lm',
    secondaryText: formatArea(film.totalArea),
    detailsCount: film.detailsCount,
    source: film.hasCutData ? 'cut' : 'none',
  }));
  return [...sheetLines, ...filmLines];
}

export function linesOfKind(lines: ResourceDemandLine[], kind: ResourceKind): ResourceDemandLine[] {
  return lines.filter((line) => line.kind === kind);
}

export interface ResourceKindTotal {
  count: number;
  total: number;
  /** Строки без посчитанного количества; в сумму не входят. */
  missingCount: number;
}

export function resourceKindTotal(lines: ResourceDemandLine[], kind: ResourceKind): ResourceKindTotal {
  const kindLines = linesOfKind(lines, kind);
  return kindLines.reduce<ResourceKindTotal>(
    (acc, line) => (line.quantity == null
      ? { ...acc, missingCount: acc.missingCount + 1 }
      : { ...acc, total: acc.total + line.quantity }),
    { count: kindLines.length, total: 0, missingCount: 0 },
  );
}

export function formatKindTotal(total: ResourceKindTotal, kind: ResourceKind): string {
  if (total.count === 0) return '—';
  if (total.count === total.missingCount) return '—';
  return formatResourceQuantity(total.total, RESOURCE_KIND_BY_KEY[kind].unit);
}

export function formatLineQuantity(line: ResourceDemandLine): string {
  if (line.quantity == null) return line.kind === 'film' ? 'Нет готового раскроя' : '—';
  return formatResourceQuantity(line.quantity, line.unit);
}

/** Русское склонение по числу: 1 заказ, 2 заказа, 5 заказов. */
export function pluralRu(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${count} ${few}`;
  return `${count} ${many}`;
}

export function positionsLabel(count: number): string {
  return pluralRu(count, 'позиция', 'позиции', 'позиций');
}

export function ordersLabel(count: number): string {
  return pluralRu(count, 'заказ', 'заказа', 'заказов');
}

/**
 * Итог материала в сводке «По материалам». Если количество не посчитано ни в
 * одном заказе (например, у плёнки нигде нет готового раскроя), показываем «—»,
 * а не «0,0 пог. м».
 */
export function formatAggregateTotal(row: {
  totalQuantity: number;
  unit: ResourceUnit;
  ordersCount: number;
  noDataOrders: number;
}): string {
  if (row.ordersCount > 0 && row.noDataOrders >= row.ordersCount) return '—';
  return formatResourceQuantity(row.totalQuantity, row.unit);
}

export function orderDisplayName(row: OrderResourceDemandRow): string {
  return row.orderName?.trim() || `#${row.orderId}`;
}

/** Возможности, которые показывает старый backend (без ключа `capabilities` в ответе): все выключены — фаза 1 as-is. */
export const NO_RESOURCE_CAPABILITIES: OrderResourceCapabilitiesDto = {
  procurement: false,
  byMaterial: false,
  cardDetails: false,
  onecDocuments: false,
};

/** Старый backend без `capabilities` в ответе → все возможности выключены (фаза 1). */
export function resolveResourceCapabilities(
  capabilities: OrderResourceCapabilitiesDto | undefined | null,
): OrderResourceCapabilitiesDto {
  return capabilities ?? NO_RESOURCE_CAPABILITIES;
}

/** До 100 заказов — лимит групповой отметки закупа (см. backend RESOURCE_PROCUREMENT_BULK_LIMIT). */
export const RESOURCE_PROCUREMENT_BULK_LIMIT = 100;

export function canBulkMarkParticipants(participantsCount: number): boolean {
  return participantsCount > 0 && participantsCount <= RESOURCE_PROCUREMENT_BULK_LIMIT;
}

/**
 * Сохранённый выбор подрежима «По материалам» в «Панели» откатывается к
 * «По заказам», если у текущего ответа backend нет соответствующей возможности
 * (старый backend или выключенный флаг).
 */
export function resolvePanelSubMode<T extends 'orders' | 'materials'>(
  stored: T,
  byMaterialCapability: boolean,
): 'orders' | 'materials' {
  return byMaterialCapability ? stored : 'orders';
}

export function resourceKindLabel(kind: ResourceKind): string {
  return RESOURCE_KIND_BY_KEY[kind].label;
}

export function procurementProgressText(summary: { total: number; purchased: number } | undefined | null): string {
  if (!summary || summary.total === 0) return '—';
  return `Закуплено ${summary.purchased} из ${summary.total}`;
}

/** Тултип чекбокса «Закуплено»: «Отметил <имя>, <дата>» — форматирование даты делает вызывающая сторона. */
export function procurementMarkedTooltip(markedByName: string | null, formattedDate: string | null): string | null {
  if (!markedByName && !formattedDate) return null;
  const name = markedByName ?? 'неизвестный пользователь';
  return formattedDate ? `Отметил ${name}, ${formattedDate}` : `Отметил ${name}`;
}

/** Данные карточки годятся только для того заказа, который сейчас показан. */
export function matchingCardData<T extends { orderId: number }>(data: T | null | undefined, orderId: number): T | null {
  return data && data.orderId === orderId ? data : null;
}

/** Сводка годится для групповой отметки, только если загружена для текущих фильтров и не грузится заново. */
export function isAggregateCurrent(loading: boolean, dataKey: string | null, queryKey: string): boolean {
  return !loading && dataKey !== null && dataKey === queryKey;
}

export interface ByMaterialPeriod {
  dateFrom?: string;
  dateTo?: string;
  /** Период подставлен по умолчанию (последний месяц), а не выбран пользователем. */
  isDefault: boolean;
}

/**
 * Период сводки «По материалам»: выбранный в фильтре важнее; если не выбран
 * ни один край — последний месяц, иначе сводка по всем заказам почти всегда
 * упирается в лимит 500 заказов.
 */
export function resolveByMaterialPeriod(
  userFrom: string | undefined,
  userTo: string | undefined,
  defaultFrom: string,
  defaultTo: string,
): ByMaterialPeriod {
  if (userFrom || userTo) {
    return { ...(userFrom ? { dateFrom: userFrom } : {}), ...(userTo ? { dateTo: userTo } : {}), isDefault: false };
  }
  return { dateFrom: defaultFrom, dateTo: defaultTo, isDefault: true };
}
