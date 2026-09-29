import type { BulkOrderResourceProcurementRequest } from '../../api/types/orderApi.types';
import type {
  ProcurementWorklistLine,
  ProcurementWorklistParams,
  WorklistCoverage,
  WorklistGroupBy,
  WorklistPreset,
  WorklistSort,
  WorklistUrgency,
} from '../../api/types/procurementWorkspaceApi.types';

/** Состояние рабочего списка — целиком в адресе страницы (план §5.1). */
export interface WorklistState {
  preset: WorklistPreset;
  groupBy: WorklistGroupBy;
  sort: WorklistSort;
  search: string;
  dueFrom: string | null;
  dueTo: string | null;
  kind: 'sheet_material' | 'film' | null;
  supplierKey: string | null;
  coverage: WorklistCoverage[];
  onecDocumentId: number | null;
}

export const DEFAULT_WORKLIST_STATE: WorklistState = {
  preset: 'action',
  groupBy: 'none',
  sort: 'due',
  search: '',
  dueFrom: null,
  dueTo: null,
  kind: null,
  supplierKey: null,
  coverage: [],
  onecDocumentId: null,
};

/** Параметры адреса экрана снабжения; остальные (вкладка «Потребность заказов») не трогаются. */
export const WORKLIST_URL_KEYS = ['preset', 'groupBy', 'sort', 'q', 'dueFrom', 'dueTo', 'kind', 'supplier', 'coverage', 'wlDoc'] as const;

const PRESETS: readonly WorklistPreset[] = ['action', 'urgent', 'all'];
const GROUPS: readonly WorklistGroupBy[] = ['none', 'supplier', 'material'];
const SORTS: readonly WorklistSort[] = ['due', 'deficit', 'order', 'material'];
const COVERAGES: readonly WorklistCoverage[] = ['covered', 'partial', 'ordered', 'none', 'no_data'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function parseWorklistSearch(params: URLSearchParams): WorklistState {
  const doc = Number(params.get('wlDoc'));
  const supplier = params.get('supplier');
  const kind = params.get('kind');
  return {
    preset: pick(params.get('preset'), PRESETS, DEFAULT_WORKLIST_STATE.preset),
    groupBy: pick(params.get('groupBy'), GROUPS, DEFAULT_WORKLIST_STATE.groupBy),
    sort: pick(params.get('sort'), SORTS, DEFAULT_WORKLIST_STATE.sort),
    search: (params.get('q') ?? '').slice(0, 200),
    dueFrom: DATE_RE.test(params.get('dueFrom') ?? '') ? params.get('dueFrom') : null,
    dueTo: DATE_RE.test(params.get('dueTo') ?? '') ? params.get('dueTo') : null,
    kind: kind === 'sheet_material' || kind === 'film' ? kind : null,
    supplierKey: supplier && /^(none|[scn]:.+)$/.test(supplier) && supplier.length <= 300 ? supplier : null,
    coverage: [...new Set((params.get('coverage') ?? '').split(',').filter((item): item is WorklistCoverage =>
      (COVERAGES as readonly string[]).includes(item)))],
    onecDocumentId: Number.isSafeInteger(doc) && doc > 0 ? doc : null,
  };
}

/** Пишет состояние в адрес, сохраняя чужие параметры; значения по умолчанию не пишутся. */
export function writeWorklistSearch(current: URLSearchParams, state: WorklistState): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const key of WORKLIST_URL_KEYS) next.delete(key);
  const set = (key: string, value: string | null, fallback?: string) => {
    if (value && value !== fallback) next.set(key, value);
  };
  set('preset', state.preset, DEFAULT_WORKLIST_STATE.preset);
  set('groupBy', state.groupBy, DEFAULT_WORKLIST_STATE.groupBy);
  set('sort', state.sort, DEFAULT_WORKLIST_STATE.sort);
  set('q', state.search.trim() || null);
  set('dueFrom', state.dueFrom);
  set('dueTo', state.dueTo);
  set('kind', state.kind);
  set('supplier', state.supplierKey);
  set('coverage', state.coverage.length > 0 ? state.coverage.join(',') : null);
  set('wlDoc', state.onecDocumentId === null ? null : String(state.onecDocumentId));
  return next;
}

/** Представление сохраняется как query-строка только параметров рабочего списка. */
export function stateToViewQuery(state: WorklistState): string {
  return writeWorklistSearch(new URLSearchParams(), state).toString();
}

export function stateFromViewQuery(query: string): WorklistState {
  return parseWorklistSearch(new URLSearchParams(query));
}

export function toApiParams(state: WorklistState): ProcurementWorklistParams {
  return {
    preset: state.preset,
    groupBy: state.groupBy,
    sort: state.sort,
    ...(state.search.trim() ? { search: state.search.trim() } : {}),
    ...(state.dueFrom ? { dueFrom: state.dueFrom } : {}),
    ...(state.dueTo ? { dueTo: state.dueTo } : {}),
    ...(state.kind ? { kind: state.kind } : {}),
    ...(state.supplierKey ? { supplierKey: state.supplierKey } : {}),
    ...(state.coverage.length > 0 ? { coverage: state.coverage.join(',') } : {}),
    ...(state.onecDocumentId !== null ? { onecDocumentId: state.onecDocumentId } : {}),
  };
}

export const BULK_MARK_LIMIT = 100;

export interface BulkMarkPlan {
  requests: Array<BulkOrderResourceProcurementRequest & { materialName: string }>;
  /** Материалы, где выделено больше заказов, чем принимает одна групповая команда. */
  tooLarge: Array<{ resourceKey: string; materialName: string; count: number }>;
  alreadyPurchased: number;
}

/**
 * Групповая отметка «Закуплено» (R1-10): существующая команда принимает один материал,
 * поэтому выделение разбивается по материалам — атомарно только внутри материала.
 */
export function planBulkMarks(lines: ProcurementWorklistLine[]): BulkMarkPlan {
  const byMaterial = new Map<string, ProcurementWorklistLine[]>();
  let alreadyPurchased = 0;
  for (const line of lines) {
    if (line.purchased) { alreadyPurchased += 1; continue; }
    const list = byMaterial.get(line.resourceKey) ?? [];
    list.push(line);
    byMaterial.set(line.resourceKey, list);
  }
  const requests: BulkMarkPlan['requests'] = [];
  const tooLarge: BulkMarkPlan['tooLarge'] = [];
  for (const [resourceKey, group] of [...byMaterial.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (group.length > BULK_MARK_LIMIT) {
      tooLarge.push({ resourceKey, materialName: group[0].name, count: group.length });
      continue;
    }
    requests.push({
      resourceKey,
      materialName: group[0].name,
      purchased: true,
      items: group
        .sort((left, right) => left.orderId - right.orderId)
        .map((line) => ({ orderId: line.orderId, expectedVersion: line.procurementVersion, expectedDemandFingerprint: line.demandFingerprint })),
    });
  }
  return { requests, tooLarge, alreadyPurchased };
}

/** «Выделить группу» ↔ «Снять выделение»: кнопка знает, выделена ли группа целиком. */
export function isGroupSelected(lineKeys: string[], selected: ReadonlySet<string>): boolean {
  return lineKeys.length > 0 && lineKeys.every((key) => selected.has(key));
}

export function toggleGroupSelection(lineKeys: string[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  if (isGroupSelected(lineKeys, selected)) lineKeys.forEach((key) => next.delete(key));
  else lineKeys.forEach((key) => next.add(key));
  return next;
}

export const COVERAGE_LABELS: Record<WorklistCoverage, { label: string; color: string }> = {
  covered: { label: 'Покрыто', color: 'success' },
  partial: { label: 'Частично', color: 'warning' },
  ordered: { label: 'Заказано', color: 'processing' },
  none: { label: 'Не покрыто', color: 'error' },
  no_data: { label: 'Нет данных', color: 'default' },
};

export const URGENCY_COLORS: Record<WorklistUrgency, string> = {
  overdue: 'error',
  critical: 'error',
  soon: 'warning',
  normal: 'default',
  no_date: 'default',
};

export function dueText(line: Pick<ProcurementWorklistLine, 'daysLeft' | 'urgency'>): string {
  if (line.urgency === 'no_date' || line.daysLeft === null) return 'без срока';
  if (line.daysLeft < 0) return `просрочено на ${-line.daysLeft} дн.`;
  if (line.daysLeft === 0) return 'сегодня';
  return `через ${line.daysLeft} дн.`;
}

export function unitLabel(unit: 'm2' | 'lm'): string {
  return unit === 'm2' ? 'м²' : 'пог. м';
}

export function formatQuantity(value: number | null, unit: 'm2' | 'lm'): string {
  if (value === null) return '—';
  const digits = unit === 'lm' ? 1 : 2;
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value)} ${unitLabel(unit)}`;
}

export function formatDate(value: string | null): string {
  if (!value) return '—';
  const [year, month, day] = value.split('-');
  return `${day}.${month}.${year}`;
}

/** Строки выгрузки в Excel — ровно то, что видно в списке. */
export function worklistExportRows(lines: ProcurementWorklistLine[]): Array<Record<string, string | number>> {
  return lines.map((line) => ({
    'Нужно к': formatDate(line.dueDate),
    'Срок': dueText(line),
    'Заказ': line.fullNumber,
    'Клиент': line.clientName ?? '',
    'Материал': line.name,
    'Поставщик': line.supplier.name,
    'Потребность': line.need ?? '',
    'Пришло': line.received,
    'Заказано': line.orderedOpen,
    'Дефицит': line.deficit ?? '',
    'Ед.': unitLabel(line.unit),
    'Покрытие': COVERAGE_LABELS[line.coverage].label,
    'Закуплено': line.purchased ? (line.purchaseOrigin === 'onec' ? 'приходом 1С' : 'вручную') : '',
  }));
}

export function coveragePercents(line: Pick<ProcurementWorklistLine, 'need' | 'covered' | 'orderedOpen'>): { covered: number; ordered: number } {
  if (!line.need || line.need <= 0) return { covered: 0, ordered: 0 };
  const covered = Math.min(100, (line.covered / line.need) * 100);
  const ordered = Math.min(100 - covered, (line.orderedOpen / line.need) * 100);
  return { covered, ordered };
}

/** Добавить/снять изменённые строки (одна, «все на странице», диапазон Shift) — строки вне таблицы сохраняются. */
export function applySelectionChange(current: ReadonlySet<string>, changedKeys: string[], selected: boolean): Set<string> {
  const next = new Set(current);
  for (const key of changedKeys) {
    if (selected) next.add(key); else next.delete(key);
  }
  return next;
}

/** Почему групповая отметка сейчас недоступна; null — можно. */
export function bulkMarkBlockReason(input: {
  stale: boolean;
  canManage: boolean;
  manageLoading: boolean;
  plan: BulkMarkPlan;
}): string | null {
  if (input.manageLoading) return 'Загружаются права';
  if (!input.canManage) return 'Нужно право procurement.manage';
  if (input.stale) return 'Список обновляется под новые фильтры — дождитесь результата';
  if (input.plan.tooLarge.length > 0) {
    return `Больше ${BULK_MARK_LIMIT} заказов одного материала: ${input.plan.tooLarge
      .map((item) => `${item.materialName} — ${item.count}`).join(', ')}. Сузьте выделение`;
  }
  if (input.plan.requests.length === 0) return input.plan.alreadyPurchased > 0 ? 'Выбранные позиции уже отмечены' : 'Нечего отмечать';
  return null;
}

/** Текущая страница в допустимых пределах: как её ограничивает таблица при сокращении списка. */
export function clampPage(page: number, total: number, pageSize: number): number {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return Math.min(Math.max(1, page), pages);
}
