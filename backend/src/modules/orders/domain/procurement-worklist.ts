import type { OrderResourceKind, OrderResourceUnit } from '../application/order-resource-demand.types';
import type {
  ProcurementWorklistLineDto,
  ProcurementWorklistQuery,
  WorklistCoverage,
  WorklistGroupDto,
  WorklistSupplierDto,
  WorklistUrgency,
} from '../application/procurement-workspace.types';

/**
 * Единицы строк документов 1С и распределений (migr 197).
 * Пересчёт в единицу потребности — только здесь (план §4.4).
 */
export type ProcurementDocUnit = 'sheet' | 'm2' | 'lm' | 'pcs' | 'set';

export interface MaterialGeometry {
  /** Площадь листа, м²; null — размеры материала не заданы. */
  sheetAreaM2: number | null;
}

/** Количество в тысячных (как NUMERIC(14,3)); целые до 2^53 точны. */
export function toThousandths(value: number): number {
  return Math.round(value * 1000);
}

export function fromThousandths(value: number): number {
  return value / 1000;
}

export function sheetAreaM2(widthMm: unknown, heightMm: unknown): number | null {
  const width = Number(widthMm);
  const height = Number(heightMm);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return (width * height) / 1_000_000;
}

/**
 * Количество строки документа → единица потребности. null — несовместимо
 * (другие единицы или у материала нет размеров листа).
 */
export function toDemandUnit(
  quantity: number,
  docUnit: ProcurementDocUnit | null,
  demandUnit: OrderResourceUnit,
  geometry: MaterialGeometry,
): number | null {
  if (docUnit === demandUnit) return fromThousandths(toThousandths(quantity));
  if (docUnit === 'sheet' && demandUnit === 'm2' && geometry.sheetAreaM2 !== null) {
    return fromThousandths(toThousandths(quantity * geometry.sheetAreaM2));
  }
  return null;
}

/** Количество в единице потребности → единица строки документа, вниз до 0,001. */
export function toDocUnitFloor(
  quantity: number,
  demandUnit: OrderResourceUnit,
  docUnit: ProcurementDocUnit | null,
  geometry: MaterialGeometry,
): number | null {
  if (docUnit === demandUnit) return fromThousandths(Math.floor(quantity * 1000 + 1e-6));
  if (docUnit === 'sheet' && demandUnit === 'm2' && geometry.sheetAreaM2 !== null) {
    return fromThousandths(Math.floor((quantity / geometry.sheetAreaM2) * 1000 + 1e-6));
  }
  return null;
}

export function demandUnitOf(kind: OrderResourceKind): OrderResourceUnit {
  return kind === 'film' ? 'lm' : 'm2';
}

export interface CoverageInput {
  need: number | null;
  received: number;
  purchased: boolean;
  origin: 'manual' | 'onec' | null;
  hasActiveReceipts: boolean;
  demandChangedSinceMark: boolean;
  quantityAtMark: number | null;
  orderedOpen: number;
}

export interface CoverageResult {
  covered: number;
  deficit: number | null;
  coverage: WorklistCoverage;
  needsAction: boolean;
}

/**
 * Единая формула покрытия (план §4.1): ручная отметка без приходов покрывает
 * потребность (при росте после отметки — только до количества при отметке);
 * отметка, поставленная приходом, покрытием не считается.
 */
export function computeCoverage(input: CoverageInput): CoverageResult {
  if (input.need === null) {
    return { covered: input.received, deficit: null, coverage: 'no_data', needsAction: false };
  }
  const need = toThousandths(input.need);
  // Потребность изменилась после отметки: покрыто не больше, чем было при отметке; если количество
  // при отметке было неизвестно (раскроя ещё не было) — отметку нужно подтвердить заново (CR1-1).
  const manualCover = input.purchased && input.origin === 'manual' && !input.hasActiveReceipts
    ? (input.demandChangedSinceMark
      ? (input.quantityAtMark === null ? 0 : Math.min(need, toThousandths(input.quantityAtMark)))
      : need)
    : 0;
  const covered = Math.max(toThousandths(input.received), manualCover);
  const ordered = toThousandths(input.orderedOpen);
  const deficit = Math.max(0, need - covered - ordered);
  let coverage: WorklistCoverage;
  if (deficit === 0 && ordered === 0) coverage = 'covered';
  else if (deficit === 0) coverage = 'ordered';
  else if (covered > 0) coverage = 'partial';
  else coverage = 'none';
  return {
    covered: fromThousandths(covered),
    deficit: fromThousandths(deficit),
    coverage,
    needsAction: deficit > 0,
  };
}

/** YYYY-MM-DD минус n рабочих дней (пн–пт). */
export function subtractWorkingDays(dateOnly: string, days: number): string {
  const date = new Date(`${dateOnly}T00:00:00.000Z`);
  let left = Math.max(0, Math.trunc(days));
  while (left > 0) {
    date.setUTCDate(date.getUTCDate() - 1);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) left -= 1;
  }
  return date.toISOString().slice(0, 10);
}

export function daysBetween(fromDateOnly: string, toDateOnly: string): number {
  const from = Date.parse(`${fromDateOnly}T00:00:00.000Z`);
  const to = Date.parse(`${toDateOnly}T00:00:00.000Z`);
  return Math.round((to - from) / 86_400_000);
}

export function urgencyOf(
  dueDate: string | null,
  today: string,
  thresholds: { criticalDays: number; soonDays: number },
): { urgency: WorklistUrgency; daysLeft: number | null } {
  if (dueDate === null) return { urgency: 'no_date', daysLeft: null };
  const daysLeft = daysBetween(today, dueDate);
  if (daysLeft < 0) return { urgency: 'overdue', daysLeft };
  if (daysLeft <= thresholds.criticalDays) return { urgency: 'critical', daysLeft };
  if (daysLeft <= thresholds.soonDays) return { urgency: 'soon', daysLeft };
  return { urgency: 'normal', daysLeft };
}

export function isUrgent(line: Pick<ProcurementWorklistLineDto, 'urgency' | 'needsAction'>): boolean {
  return line.needsAction && (line.urgency === 'overdue' || line.urgency === 'critical' || line.urgency === 'soon');
}

/** «Сегодня» по часовому поясу производства. */
export function todayInAlmaty(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now);
}

export function addDays(dateOnly: string, days: number): string {
  const date = new Date(`${dateOnly}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export interface SupplierCandidate {
  key: string;
  name: string;
  firstSeenAt: string;
  id: number;
}

/**
 * Основной поставщик позиции (план §4.3): ручной из справочника материала,
 * иначе самый ранний записанный по приходам; остальные — списком.
 */
export function resolveSupplier(
  materialSupplier: { id: number; name: string } | null,
  recorded: SupplierCandidate[],
): WorklistSupplierDto {
  const ordered = [...recorded].sort((left, right) => left.firstSeenAt.localeCompare(right.firstSeenAt) || left.id - right.id);
  if (materialSupplier) {
    const key = `s:${materialSupplier.id}`;
    return {
      key,
      name: materialSupplier.name,
      source: 'material',
      others: ordered.filter((candidate) => candidate.key !== key).map(({ key: k, name }) => ({ key: k, name })),
    };
  }
  const [first, ...rest] = ordered;
  if (!first) return { key: 'none', name: 'Не указан', source: 'none', others: [] };
  return {
    key: first.key,
    name: first.name,
    source: 'first_receipt',
    others: rest.map(({ key, name }) => ({ key, name })),
  };
}

/** Фильтры запроса, кроме пресета: пресеты считаются поверх них (счётчики). */
export function matchesQuery(line: ProcurementWorklistLineDto, query: ProcurementWorklistQuery, onecDocOrders?: Set<string>): boolean {
  if (query.kind && line.kind !== query.kind) return false;
  if (query.supplierKey && line.supplier.key !== query.supplierKey) return false;
  if (query.coverage && query.coverage.length > 0 && !query.coverage.includes(line.coverage)) return false;
  if (query.dueFrom && (line.dueDate === null || line.dueDate < query.dueFrom)) return false;
  if (query.dueTo && (line.dueDate === null || line.dueDate > query.dueTo)) return false;
  if (onecDocOrders && !onecDocOrders.has(line.lineKey)) return false;
  if (query.search) {
    const needle = query.search.toLocaleLowerCase('ru');
    const haystack = [line.orderName, line.fullNumber, line.clientName ?? '', line.name, line.supplier.name]
      .join('\n').toLocaleLowerCase('ru');
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

export function matchesPreset(line: ProcurementWorklistLineDto, preset: ProcurementWorklistQuery['preset']): boolean {
  if (preset === 'action') return line.needsAction;
  if (preset === 'urgent') return isUrgent(line);
  return true;
}

const URGENCY_RANK: Record<WorklistUrgency, number> = { overdue: 0, critical: 1, soon: 2, normal: 3, no_date: 4 };

export function sortLines(lines: ProcurementWorklistLineDto[], sort: ProcurementWorklistQuery['sort']): ProcurementWorklistLineDto[] {
  const byOrder = (left: ProcurementWorklistLineDto, right: ProcurementWorklistLineDto) =>
    left.orderName.localeCompare(right.orderName, 'ru', { numeric: true }) || left.orderId - right.orderId
    || left.name.localeCompare(right.name, 'ru') || left.refId - right.refId;
  const byDue = (left: ProcurementWorklistLineDto, right: ProcurementWorklistLineDto) =>
    URGENCY_RANK[left.urgency] - URGENCY_RANK[right.urgency]
    || (left.dueDate ?? '9999').localeCompare(right.dueDate ?? '9999');
  return [...lines].sort((left, right) => {
    if (sort === 'deficit') return (right.deficit ?? -1) - (left.deficit ?? -1) || byDue(left, right) || byOrder(left, right);
    if (sort === 'order') return byOrder(left, right);
    if (sort === 'material') return left.name.localeCompare(right.name, 'ru') || left.refId - right.refId || byDue(left, right) || byOrder(left, right);
    return byDue(left, right) || byOrder(left, right);
  });
}

export function groupLines(lines: ProcurementWorklistLineDto[], groupBy: ProcurementWorklistQuery['groupBy']): WorklistGroupDto[] {
  if (groupBy === 'none') return [];
  const groups = new Map<string, WorklistGroupDto>();
  for (const line of lines) {
    const key = groupBy === 'supplier' ? line.supplier.key : line.resourceKey;
    const label = groupBy === 'supplier' ? line.supplier.name : line.name;
    const group = groups.get(key) ?? { key, label, linesCount: 0, deficitM2: 0, deficitLm: 0, lineKeys: [] };
    group.linesCount += 1;
    group.lineKeys.push(line.lineKey);
    if (line.deficit !== null) {
      if (line.unit === 'lm') group.deficitLm = fromThousandths(toThousandths(group.deficitLm + line.deficit));
      else group.deficitM2 = fromThousandths(toThousandths(group.deficitM2 + line.deficit));
    }
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) =>
    (left.key === 'none' ? 1 : 0) - (right.key === 'none' ? 1 : 0) || left.label.localeCompare(right.label, 'ru'));
}

export function sumDeficit(lines: ProcurementWorklistLineDto[], unit: OrderResourceUnit): number {
  return fromThousandths(lines.reduce((sum, line) =>
    sum + (line.unit === unit && line.deficit !== null ? toThousandths(line.deficit) : 0), 0));
}
