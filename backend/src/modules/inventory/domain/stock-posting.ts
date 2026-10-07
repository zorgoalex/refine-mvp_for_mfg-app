// Чистая логика складских документов плёнки (план §7.2, §8). Количества — пог. м
// с двумя знаками; вычисления в целых сотых, чтобы не накапливать ошибку float.

export type StockDocType = 'receipt' | 'writeoff' | 'inventory';
export type StockMovementType = 'receipt' | 'writeoff' | 'inventory_adjustment';
export type LineMatchStatus = 'alias' | 'exact' | 'suggested' | 'confirmed' | 'manual' | 'unmatched' | 'skipped';
export type LineQuantityStatus = 'ok' | 'needs_review' | 'missing' | 'confirmed';

export const POSTABLE_MATCH_STATUSES: ReadonlySet<LineMatchStatus> = new Set(['alias', 'exact', 'confirmed', 'manual']);
export const POSTABLE_QUANTITY_STATUSES: ReadonlySet<LineQuantityStatus> = new Set(['ok', 'confirmed']);
/** Количество больше этого значения из названия требует подтверждения. */
export const SUSPICIOUS_QUANTITY_LM = 100;

export interface StockLineState {
  lineId: number;
  lineNo: number;
  filmId: number | null;
  quantity: number | null;
  matchStatus: LineMatchStatus;
  quantityStatus: LineQuantityStatus;
}

export interface UnresolvedLine {
  lineId: number;
  lineNo: number;
  reason: 'match' | 'quantity';
}

export function toCents(value: number): number {
  return Math.round(value * 100);
}

export function fromCents(value: number): number {
  return value / 100;
}

/** Строки, мешающие проведению: неподтверждённое сопоставление или количество. `skipped` игнорируются. */
export function findUnresolvedLines(lines: ReadonlyArray<StockLineState>): UnresolvedLine[] {
  const unresolved: UnresolvedLine[] = [];
  for (const line of lines) {
    if (line.matchStatus === 'skipped') continue;
    if (!POSTABLE_MATCH_STATUSES.has(line.matchStatus) || line.filmId === null) {
      unresolved.push({ lineId: line.lineId, lineNo: line.lineNo, reason: 'match' });
    } else if (!POSTABLE_QUANTITY_STATUSES.has(line.quantityStatus) || line.quantity === null) {
      unresolved.push({ lineId: line.lineId, lineNo: line.lineNo, reason: 'quantity' });
    }
  }
  return unresolved;
}

/** Сумма количества по плёнке (в сотых) для проводимых строк; ключи по возрастанию film_id. */
export function aggregateLines(lines: ReadonlyArray<StockLineState>): Map<number, number> {
  const totals = new Map<number, number>();
  for (const line of lines) {
    if (line.matchStatus === 'skipped' || line.filmId === null || line.quantity === null) continue;
    totals.set(line.filmId, (totals.get(line.filmId) ?? 0) + toCents(line.quantity));
  }
  return new Map([...totals.entries()].sort((a, b) => a[0] - b[0]));
}

export interface PlannedMovement {
  filmId: number;
  movementType: StockMovementType;
  deltaCents: number;
  beforeCents: number;
  afterCents: number;
}

/**
 * Движения документа по текущим остаткам (в сотых). Приход прибавляет, списание
 * вычитает, инвентаризация приводит остаток перечисленных плёнок к файлу (нулевая
 * дельта тоже фиксируется). Не перечисленные плёнки не меняются.
 */
export function planMovements(
  docType: StockDocType,
  aggregatedCents: ReadonlyMap<number, number>,
  balancesCents: ReadonlyMap<number, number>,
): PlannedMovement[] {
  const movementType: StockMovementType = docType === 'inventory' ? 'inventory_adjustment' : docType;
  return [...aggregatedCents.entries()].sort((a, b) => a[0] - b[0]).map(([filmId, quantityCents]) => {
    const beforeCents = balancesCents.get(filmId) ?? 0;
    const deltaCents = docType === 'receipt' ? quantityCents
      : docType === 'writeoff' ? -quantityCents
        : quantityCents - beforeCents;
    return { filmId, movementType, deltaCents, beforeCents, afterCents: beforeCents + deltaCents };
  });
}

/** Плёнки, у которых проведение уведёт остаток ниже нуля. */
export function negativeAfter(movements: ReadonlyArray<PlannedMovement>): Array<{ filmId: number; after: number }> {
  return movements
    .filter((movement) => movement.afterCents < 0 && movement.deltaCents < 0)
    .map((movement) => ({ filmId: movement.filmId, after: fromCents(movement.afterCents) }));
}

export interface ParsedStockName {
  name: string;
  quantity: number | null;
  quantityStatus: LineQuantityStatus;
  issue: string | null;
}

/**
 * Разбор «название + количество» из одной ячейки (`Чага 5,2`, `санд графит CRM1806-1,1`,
 * `темно синийFRS 828--3,1`). Целое число в конце может быть частью артикула
 * (`CRM 840`) — такая строка требует проверки, как и значение > 100 пог. м.
 */
export function parseNameWithQuantity(raw: string): ParsedStockName {
  const text = raw.replace(/\s+/g, ' ').trim();
  const match = /^(.*?)[\s\-–—]*(\d+(?:[.,]\d+)?)$/.exec(text);
  if (!match || !match[1].trim()) {
    return { name: text, quantity: null, quantityStatus: 'missing', issue: 'Не указано количество' };
  }
  const name = match[1].replace(/[\s\-–—]+$/, '').trim();
  const numberText = match[2];
  const quantity = Number(numberText.replace(',', '.'));
  const hasFraction = /[.,]/.test(numberText);
  if (!hasFraction) {
    return { name, quantity, quantityStatus: 'needs_review', issue: 'Проверьте количество: целое число может быть частью артикула' };
  }
  if (quantity > SUSPICIOUS_QUANTITY_LM) {
    return { name, quantity, quantityStatus: 'needs_review', issue: `Проверьте количество: больше ${SUSPICIOUS_QUANTITY_LM} пог. м` };
  }
  return { name, quantity: Math.round(quantity * 100) / 100, quantityStatus: 'ok', issue: null };
}

/** Количество из отдельной колонки («5,2», «5.2», 5.2). */
export function parseQuantityCell(value: unknown): { quantity: number | null; quantityStatus: LineQuantityStatus; issue: string | null } {
  if (value === null || value === undefined || String(value).trim() === '') {
    return { quantity: null, quantityStatus: 'missing', issue: 'Не указано количество' };
  }
  const quantity = typeof value === 'number' ? value : Number(String(value).trim().replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(quantity) || quantity < 0) {
    return { quantity: null, quantityStatus: 'missing', issue: 'Некорректное количество' };
  }
  if (quantity > SUSPICIOUS_QUANTITY_LM) {
    return { quantity, quantityStatus: 'needs_review', issue: `Проверьте количество: больше ${SUSPICIOUS_QUANTITY_LM} пог. м` };
  }
  return { quantity: Math.round(quantity * 100) / 100, quantityStatus: 'ok', issue: null };
}
