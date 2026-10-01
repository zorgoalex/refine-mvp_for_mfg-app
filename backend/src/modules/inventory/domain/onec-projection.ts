// Проекция расхода 1С в учёт плёнки (план 2026-09-30-onec-consumption-documents-plan.md §4): желаемое
// по документу 1С — агрегат по (склад ERP, каноническая плёнка) в сотых со знаком; дельта = желаемое −
// применённое. Чистые функции: блокировки и чтение контекста — в адаптере, в транзакции документа.
import { createHash } from 'node:crypto';
import type { ConsumptionDocumentView } from '../application/onec-consumption.port';

export type OnecIssueCode =
  | 'FILM_UNLINKED' | 'UNIT_PACKAGE' | 'UNIT_MISMATCH' | 'WAREHOUSE_UNLINKED' | 'NO_CUTOFF' | 'NO_BASELINE'
  | 'BEFORE_CUTOFF' | 'AMBIGUOUS_SOURCE' | 'LINE_CONFLICT' | 'MISSING_IN_SOURCE' | 'NO_DOC_AT';

export interface ProjectionWarehouse {
  warehouseId: number;
  active: boolean;
  /** Момент начала расхода 1С (ISO); null — склад не участвует. */
  since: string | null;
  /** Авторитетный источник склада (§3.5): id; 'ambiguous' — ключ склада в нескольких источниках; null — нет в 1С. */
  source: number | 'ambiguous' | null;
  /** Ворота §4.3а: все проведённые инвентаризации склада учтены поколением. */
  baselineOk: boolean;
}

export interface ProjectionContext {
  warehouseByRefKey: ReadonlyMap<string, ProjectionWarehouse>;
  warehouseById: ReadonlyMap<number, ProjectionWarehouse>;
  /** Ключ позиции 1С (нижний регистр) → каноническая плёнка ERP. */
  filmByRefKey: ReadonlyMap<string, number>;
  /** `${w}:${f}` → поколение и момент подсчёта последней проведённой инвентаризации. */
  generation: ReadonlyMap<string, { gen: number; countedAt: string }>;
}

export interface ProjectionIssue {
  lineId: number | null;
  code: OnecIssueCode;
  warehouseId: number | null;
  nomenclatureRefKey: string | null;
  quantity: string | null;
}

export interface DesiredProjection {
  /** `${w}:${f}` → желаемое в сотых со знаком (расход — минус). */
  desired: Map<string, number>;
  /** Склады, по которым применённое не меняется: `AMBIGUOUS_SOURCE`, `NO_BASELINE`. */
  frozenWarehouses: Set<number>;
  /** Документ пропал из выгрузки 1С: применённое не меняется (кроме склада компенсации). */
  keepApplied: boolean;
  issues: ProjectionIssue[];
  /** Поколения (w, f) строк документа — вход hash (новое проведение инвентаризации меняет hash). */
  generations: Map<string, number>;
}

export const stockKey = (warehouseId: number, filmId: number): string => `${warehouseId}:${filmId}`;
export const parseStockKey = (key: string): { warehouseId: number; filmId: number } => {
  const [w, f] = key.split(':');
  return { warehouseId: Number(w), filmId: Number(f) };
};

/** «Вблизи отсечки» — строки до отсечки не старше этого окна показываются как BEFORE_CUTOFF (диагностика края). */
const BEFORE_CUTOFF_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** Количество 1С (строка NUMERIC(14,3)) → тысячные, без двоичной арифметики. */
export function quantityToMilli(quantity: string): number {
  const match = /^(-)?(\d+)(?:\.(\d{1,3}))?$/.exec(quantity.trim());
  if (!match) throw new Error(`invalid 1C quantity: ${quantity}`);
  const milli = Number(match[2]) * 1000 + Number((match[3] ?? '').padEnd(3, '0'));
  return match[1] ? -milli : milli;
}

/** Тысячные → сотые шкалы учёта, симметричное округление (расход и возврат округляются одинаково). */
export function milliToCents(milli: number): number {
  const cents = Math.round(Math.abs(milli) / 10);
  return milli < 0 ? -cents : cents;
}

export function desiredForDocument(
  doc: ConsumptionDocumentView | null,
  ctx: ProjectionContext,
  options: { zeroWarehouseId?: number; appliedWarehouseIds?: readonly number[] } = {},
): DesiredProjection {
  const milli = new Map<string, number>();
  const frozen = new Set<number>();
  const issues: ProjectionIssue[] = [];
  const generations = new Map<string, number>();
  // Документ пропал (смена вида) — желаемое 0; склады применённого с неразрешённым источником/воротами не трогаем.
  const freezeUnsafe = (warehouseId: number) => {
    if (warehouseId === options.zeroWarehouseId) return;
    const wh = ctx.warehouseById.get(warehouseId);
    if (wh && (wh.source === 'ambiguous' || !wh.baselineOk)) frozen.add(warehouseId);
  };
  if (doc === null) {
    for (const warehouseId of options.appliedWarehouseIds ?? []) freezeUnsafe(warehouseId);
    return { desired: new Map(), frozenWarehouses: frozen, keepApplied: false, issues, generations };
  }
  if (doc.missingInSource) {
    issues.push({ lineId: null, code: 'MISSING_IN_SOURCE', warehouseId: null, nomenclatureRefKey: null, quantity: null });
    return { desired: new Map(), frozenWarehouses: frozen, keepApplied: true, issues, generations };
  }
  if (!doc.posted || doc.deletedInOnec) {
    for (const warehouseId of options.appliedWarehouseIds ?? []) freezeUnsafe(warehouseId);
    return { desired: new Map(), frozenWarehouses: frozen, keepApplied: false, issues, generations };
  }
  const docAt = doc.docAt === null ? null : Date.parse(doc.docAt);
  for (const line of doc.lines) {
    if (line.removedInOnec || !line.isStockItem) continue;
    const headerWarehouse = line.warehouseRefKey ?? doc.warehouseRefKey;
    const sides = doc.docKind === 'inventory_transfer'
      ? [{ refKey: headerWarehouse, sign: -1 }, { refKey: doc.destinationWarehouseRefKey, sign: 1 }]
      : [{ refKey: headerWarehouse, sign: -1 }];
    for (const side of sides) {
      const issue = (code: OnecIssueCode, warehouseId: number | null) =>
        issues.push({ lineId: line.lineId, code, warehouseId, nomenclatureRefKey: line.nomenclatureRefKey, quantity: line.quantity });
      // Склады, не ведущиеся в ERP или без даты начала, не участвуют и не шумят в «не учтено».
      const wh = side.refKey ? ctx.warehouseByRefKey.get(side.refKey.toLowerCase()) : undefined;
      if (!wh || !wh.active || wh.since === null) continue;
      const w = wh.warehouseId;
      if (w === options.zeroWarehouseId) continue;
      // Позиция без плёнки ERP — плёнка без привязки, только если в пог. м и не в упаковке; прочие материалы
      // (МДФ упаковками, фрезеровка в м², краска) учитываются этапом 2 и в «не учтено» не попадают.
      const film = line.nomenclatureRefKey ? ctx.filmByRefKey.get(line.nomenclatureRefKey.toLowerCase()) : undefined;
      if (film === undefined && (line.unitCode !== 'lm' || line.unitIsPackage)) continue;
      if (line.loadConflictCode) { issue('LINE_CONFLICT', w); continue; }
      if (wh.source === 'ambiguous') { frozen.add(w); issue('AMBIGUOUS_SOURCE', w); continue; }
      // Неавторитетный источник склада (другая база) — желаемое 0: смена источника возвращает применённое.
      if (wh.source !== doc.sourceId) continue;
      if (!wh.baselineOk) { frozen.add(w); issue('NO_BASELINE', w); continue; }
      if (film === undefined) { issue('FILM_UNLINKED', w); continue; }
      if (line.unitIsPackage) { issue('UNIT_PACKAGE', w); continue; }
      if (line.unitCode !== 'lm') { issue('UNIT_MISMATCH', w); continue; }
      const key = stockKey(w, film);
      const gen = ctx.generation.get(key);
      generations.set(key, gen?.gen ?? 0);
      if (docAt === null) { issue('NO_DOC_AT', w); continue; }
      const cutoff = Math.max(Date.parse(wh.since), gen ? Date.parse(gen.countedAt) : -Infinity);
      if (docAt <= cutoff) {
        if (cutoff - docAt <= BEFORE_CUTOFF_WINDOW_MS) issue('BEFORE_CUTOFF', w);
        continue;
      }
      milli.set(key, (milli.get(key) ?? 0) + side.sign * quantityToMilli(line.quantity));
    }
  }
  // Склады уже применённого (строка могла уйти на другой склад) с неразрешённым источником/воротами — не трогаем.
  for (const warehouseId of options.appliedWarehouseIds ?? []) freezeUnsafe(warehouseId);
  const desired = new Map<string, number>();
  for (const [key, value] of milli) desired.set(key, milliToCents(value));
  return { desired, frozenWarehouses: frozen, keepApplied: false, issues, generations };
}

/**
 * Дельта = желаемое − применённое по (склад, плёнка) в сотых. Замороженные склады и пропавший из выгрузки
 * документ (кроме склада компенсации) — без изменений. `nextApplied` — применённое после записи дельт.
 */
export function projectionDeltas(
  desired: DesiredProjection,
  applied: ReadonlyMap<string, number>,
  zeroWarehouseId?: number,
): { deltas: Map<string, number>; nextApplied: Map<string, number> } {
  const deltas = new Map<string, number>();
  const nextApplied = new Map<string, number>(applied);
  for (const key of new Set([...desired.desired.keys(), ...applied.keys()])) {
    const { warehouseId } = parseStockKey(key);
    const locked = (desired.keepApplied || desired.frozenWarehouses.has(warehouseId)) && warehouseId !== zeroWarehouseId;
    if (locked) continue;
    const want = warehouseId === zeroWarehouseId ? 0 : desired.desired.get(key) ?? 0;
    const have = applied.get(key) ?? 0;
    if (want !== have) deltas.set(key, want - have);
    nextApplied.set(key, want);
  }
  return { deltas, nextApplied };
}

const sorted = <T>(entries: Iterable<[string, T]>) => [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

/** Hash входов, влияющих на результат: ревизия, признаки, желаемое, заморозки, issues, поколения. */
export function projectionHash(doc: ConsumptionDocumentView | null, desired: DesiredProjection): string {
  const payload = {
    doc: doc === null ? null : {
      revision: doc.revision, posted: doc.posted, deleted: doc.deletedInOnec, missing: doc.missingInSource,
      sourceId: doc.sourceId, docAt: doc.docAt,
    },
    desired: sorted(desired.desired),
    frozen: [...desired.frozenWarehouses].sort((a, b) => a - b),
    keepApplied: desired.keepApplied,
    issues: desired.issues.map((issue) => `${issue.lineId}|${issue.code}|${issue.warehouseId}`).sort(),
    generations: sorted(desired.generations),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
