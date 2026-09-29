import type {
  AllocationSuggestionCandidate,
  AllocationSuggestionLine,
  AllocationSuggestionsResponse,
  BatchOnecAllocationFailure,
  BatchOnecAllocationRequest,
  OnecUnitCode,
} from '../../api/types/onecDocumentsApi.types';

/**
 * Черновик правок автоподбора — «Подобрать заказы» для прихода 1С (план §5.3–5.4).
 * Чистая логика (без React): состояние, итоги, конвертация единиц, сборка batch-запроса,
 * разбор конфликта, localStorage. Компонент (`AllocationSuggestionPanel.tsx`) — только рендер.
 */

/** До 0,001 в единице строки документа (§4.4 плана). */
const DOC_UNIT_PRECISION = 3;
const MILLI = 1000;
/** Порог «есть остаток/перебор» в единице строки — половина минимального шага (0,001). */
const EPSILON_DOC_UNIT = 0.0005;

export const MAX_BATCH_ITEMS = 100;

export interface CandidateDraftState {
  checked: boolean;
  /** В единице строки документа (docUnit), с точностью до 3 знаков. */
  quantity: number;
  /**
   * Контекст, для которого значение введено (CR1-1): версия закупа и отпечаток потребности кандидата.
   * Сохранённое значение восстанавливается, только если контекст совпадает со свежим ответом сервера.
   */
  version?: number;
  fingerprint?: string;
  /** true — пользователь правил галочку/количество; иначе значение — просто предложение сервера. */
  edited?: boolean;
}

export interface LineDraftState {
  /** Ключ — orderId кандидата. */
  candidates: Record<number, CandidateDraftState>;
  /**
   * Контекст строки прихода, в котором введены количества (CR2-1): материал, единица строки, единица
   * потребности и площадь листа. Изменился — сохранённые количества строки не восстанавливаются.
   */
  context?: string;
}

export interface SuggestionDraftState {
  /** Ключ — lineId строки документа. */
  lines: Record<number, LineDraftState>;
}

export function roundToDocUnit(value: number): number {
  return Math.round(value * MILLI) / MILLI;
}

function toMilli(value: number): number {
  return Math.round(value * MILLI);
}

function fromMilli(value: number): number {
  return value / MILLI;
}

/** Ключ контекста строки: при любой смене единиц/материала сохранённые количества теряют смысл. */
export function lineDraftContext(line: AllocationSuggestionLine): string {
  return [line.material?.resourceKey ?? '', line.docUnit ?? '', line.demandUnit ?? '', line.sheetAreaM2 ?? ''].join('|');
}

/** Черновик по умолчанию для ответа сервера: отмечены кандидаты с предложенным количеством > 0. */
export function buildInitialDraft(response: AllocationSuggestionsResponse): SuggestionDraftState {
  const lines: SuggestionDraftState['lines'] = {};
  for (const line of response.lines) {
    const candidates: LineDraftState['candidates'] = {};
    for (const candidate of line.candidates) {
      candidates[candidate.orderId] = proposalState(candidate);
    }
    lines[line.lineId] = { candidates, context: lineDraftContext(line) };
  }
  return { lines };
}

function proposalState(candidate: AllocationSuggestionCandidate): CandidateDraftState {
  return {
    checked: candidate.proposedInDocUnit > 0,
    quantity: roundToDocUnit(candidate.proposedInDocUnit),
    version: candidate.procurementVersion,
    fingerprint: candidate.demandFingerprint,
    edited: false,
  };
}

function emptyLineDraft(): LineDraftState {
  return { candidates: {} };
}

export function getLineDraft(draft: SuggestionDraftState, lineId: number): LineDraftState {
  return draft.lines[lineId] ?? emptyLineDraft();
}

/** Отметить/снять кандидата. Снятие не обнуляет количество — можно снова отметить с тем же значением. */
export function setCandidateChecked(
  draft: SuggestionDraftState,
  lineId: number,
  orderId: number,
  checked: boolean,
): SuggestionDraftState {
  const line = getLineDraft(draft, lineId);
  const current = line.candidates[orderId] ?? { checked: false, quantity: 0 };
  return {
    lines: {
      ...draft.lines,
      [lineId]: { ...line, candidates: { ...line.candidates, [orderId]: { ...current, checked, edited: true } } },
    },
  };
}

/** Правка количества (единица строки документа). Отрицательные и NaN — зажимаются в 0. */
export function setCandidateQuantity(
  draft: SuggestionDraftState,
  lineId: number,
  orderId: number,
  quantity: number,
): SuggestionDraftState {
  const line = getLineDraft(draft, lineId);
  const current = line.candidates[orderId] ?? { checked: false, quantity: 0 };
  const safeQuantity = Number.isFinite(quantity) ? Math.max(0, roundToDocUnit(quantity)) : 0;
  return {
    lines: {
      ...draft.lines,
      [lineId]: { ...line, candidates: { ...line.candidates, [orderId]: { ...current, quantity: safeQuantity, edited: true } } },
    },
  };
}

/** Сбросить строку к предложению сервера (кнопка «Подобрать заново» на карточке строки). */
export function resetLineToProposal(
  draft: SuggestionDraftState,
  line: AllocationSuggestionLine,
): SuggestionDraftState {
  const candidates: LineDraftState['candidates'] = {};
  for (const candidate of line.candidates) {
    candidates[candidate.orderId] = proposalState(candidate);
  }
  return { lines: { ...draft.lines, [line.lineId]: { candidates, context: lineDraftContext(line) } } };
}

export interface LineTotals {
  /** Сумма количеств отмеченных кандидатов, единица строки документа. */
  distributedInDocUnit: number;
  /** remainingInDocUnit − distributed; может быть отрицательным (перебор). */
  leftInDocUnit: number;
  /** left < 0 — блокирует отправку. */
  overrun: boolean;
  /** «На склад / излишек» — max(0, left). */
  surplusInDocUnit: number;
}

/** Итоги строки — в целых тысячных, чтобы плавающая точка не давала ложный перебор/остаток. */
export function computeLineTotals(line: AllocationSuggestionLine, lineDraft: LineDraftState): LineTotals {
  let distributedMilli = 0;
  for (const candidate of line.candidates) {
    const state = lineDraft.candidates[candidate.orderId];
    if (state?.checked) distributedMilli += toMilli(state.quantity);
  }
  const leftMilli = toMilli(line.remainingInDocUnit) - distributedMilli;
  return {
    distributedInDocUnit: fromMilli(distributedMilli),
    leftInDocUnit: fromMilli(leftMilli),
    overrun: leftMilli < 0,
    surplusInDocUnit: fromMilli(Math.max(0, leftMilli)),
  };
}

export type LineCheckStatus = 'overrun' | 'surplus' | 'exact' | 'empty';

export function lineCheckStatus(totals: LineTotals): LineCheckStatus {
  if (totals.overrun) return 'overrun';
  if (totals.surplusInDocUnit > EPSILON_DOC_UNIT) return 'surplus';
  if (totals.distributedInDocUnit > EPSILON_DOC_UNIT) return 'exact';
  return 'empty';
}

/**
 * Конвертация доля документа → единица потребности для отображения («≈ … м²»).
 * sheet→m2 — через площадь листа материала; совпадающие единицы — 1:1; иначе — не считается (null).
 */
export function convertDocUnitToDemandUnit(
  quantityInDocUnit: number,
  docUnit: OnecUnitCode | null,
  demandUnit: 'm2' | 'lm' | null,
  sheetAreaM2: number | null,
): number | null {
  if (docUnit == null || demandUnit == null) return null;
  if (docUnit === demandUnit) return quantityInDocUnit;
  if (docUnit === 'sheet' && demandUnit === 'm2') {
    return sheetAreaM2 != null && sheetAreaM2 > 0 ? quantityInDocUnit * sheetAreaM2 : null;
  }
  return null;
}

/** «N листов = M м²» в шапке карточки строки — только когда сопоставление вообще возможно. */
export function lineCapacityDemandEquivalent(line: AllocationSuggestionLine): number | null {
  return convertDocUnitToDemandUnit(line.capacityInDocUnit, line.docUnit, line.demandUnit, line.sheetAreaM2);
}

export interface OverallUnitSummary {
  unit: OnecUnitCode;
  surplusInDocUnit: number;
}

export interface OverallSummary {
  /** Строки, доступные для подбора (не skipReason). */
  linesCount: number;
  /** Заказы с хотя бы одним отмеченным кандидатом с количеством > 0, по всем строкам. */
  ordersCount: number;
  /** Есть хотя бы одна строка с overrun — блокирует отправку. */
  overrun: boolean;
  /** «На склад / излишек» по единицам строк документа (строки могут быть в разных единицах). */
  surplusByUnit: OverallUnitSummary[];
}

export function computeOverallSummary(response: AllocationSuggestionsResponse, draft: SuggestionDraftState): OverallSummary {
  const eligible = response.lines.filter((line) => line.skipReason === null);
  const orders = new Set<number>();
  let overrun = false;
  const surplusByUnitMilli = new Map<OnecUnitCode, number>();

  for (const line of eligible) {
    const lineDraft = getLineDraft(draft, line.lineId);
    const totals = computeLineTotals(line, lineDraft);
    if (totals.overrun) overrun = true;
    if (line.docUnit && totals.surplusInDocUnit > EPSILON_DOC_UNIT) {
      surplusByUnitMilli.set(line.docUnit, (surplusByUnitMilli.get(line.docUnit) ?? 0) + toMilli(totals.surplusInDocUnit));
    }
    for (const candidate of line.candidates) {
      const state = lineDraft.candidates[candidate.orderId];
      if (state?.checked && state.quantity > 0) orders.add(candidate.orderId);
    }
  }

  return {
    linesCount: eligible.length,
    ordersCount: orders.size,
    overrun,
    surplusByUnit: [...surplusByUnitMilli.entries()].map(([unit, milli]) => ({ unit, surplusInDocUnit: fromMilli(milli) })),
  };
}

/** Хотя бы один отмеченный кандидат с количеством > 0 в любой строке. */
export function hasAnySelection(response: AllocationSuggestionsResponse, draft: SuggestionDraftState): boolean {
  return response.lines.some((line) => {
    const lineDraft = getLineDraft(draft, line.lineId);
    return line.candidates.some((candidate) => {
      const state = lineDraft.candidates[candidate.orderId];
      return state?.checked && state.quantity > 0;
    });
  });
}

/** Можно нажимать «Распределить выбранное»: нет перебора и есть что распределять. */
export function canSubmitBatch(response: AllocationSuggestionsResponse, draft: SuggestionDraftState): boolean {
  const summary = computeOverallSummary(response, draft);
  return !summary.overrun && hasAnySelection(response, draft);
}

/**
 * Черновик совпадает с предложением сервера по каждому кандидату (снятая отметка
 * у предложенного кандидата или добавленная сверх предложения — уже не «suggested»).
 */
export function isSuggestionUnmodified(response: AllocationSuggestionsResponse, draft: SuggestionDraftState): boolean {
  for (const line of response.lines) {
    const lineDraft = getLineDraft(draft, line.lineId);
    for (const candidate of line.candidates) {
      const state = lineDraft.candidates[candidate.orderId];
      const submittedQty = state?.checked ? roundToDocUnit(state.quantity) : 0;
      const proposedQty = roundToDocUnit(candidate.proposedInDocUnit);
      if (submittedQty !== proposedQty) return false;
    }
  }
  return true;
}

export interface BuildBatchResult {
  request: BatchOnecAllocationRequest | null;
  /** Заполнено, когда отправка невозможна: показать пользователю и не отправлять. */
  error: string | null;
}

/**
 * Собирает тело POST .../allocations/batch: только отмеченные кандидаты с количеством > 0.
 * Строки без сопоставленного материала (skipReason='not_mapped') пропускаются защитно —
 * для них кандидатов быть не должно.
 */
export function buildBatchRequest(
  response: AllocationSuggestionsResponse,
  draft: SuggestionDraftState,
  requestId: string,
): BuildBatchResult {
  const items: BatchOnecAllocationRequest['items'] = [];
  for (const line of response.lines) {
    if (!line.material) continue;
    const lineDraft = getLineDraft(draft, line.lineId);
    for (const candidate of line.candidates) {
      const state = lineDraft.candidates[candidate.orderId];
      if (!state?.checked) continue;
      const quantity = roundToDocUnit(state.quantity);
      if (quantity <= 0) continue;
      items.push({
        lineId: line.lineId,
        orderId: candidate.orderId,
        resourceKey: line.material.resourceKey,
        quantity,
        expectedVersion: candidate.procurementVersion,
        expectedDemandFingerprint: candidate.demandFingerprint,
        // Контекст пересчёта единиц: сервер отклонит, если строка или размер листа изменились (CR3-1).
        expectedDocUnit: line.docUnit,
        expectedSheetAreaM2: line.sheetAreaM2,
      });
    }
  }

  if (items.length === 0) {
    return { request: null, error: 'Отметьте хотя бы одного кандидата с количеством больше нуля' };
  }
  if (items.length > MAX_BATCH_ITEMS) {
    return { request: null, error: `Выбрано ${items.length} строк — не больше ${MAX_BATCH_ITEMS} за одно распределение` };
  }

  return {
    request: {
      requestId,
      origin: isSuggestionUnmodified(response, draft) ? 'suggested' : 'manual',
      items,
    },
    error: null,
  };
}

export interface MappedBatchFailure {
  index: number;
  code: string;
  message: string;
  lineNo: number | null;
  materialName: string | null;
  orderName: string | null;
  orderId: number | null;
}

/**
 * 409 ONEC_ALLOCATION_BATCH_CONFLICT: сопоставляет `details.failures[].index` с элементом
 * отправленного запроса, чтобы показать строку/заказ, а не голый индекс.
 */
export function mapBatchFailures(
  failures: BatchOnecAllocationFailure[],
  request: BatchOnecAllocationRequest,
  response: AllocationSuggestionsResponse,
): MappedBatchFailure[] {
  return failures.map((failure) => {
    const item = request.items[failure.index];
    const line = item ? response.lines.find((candidate) => candidate.lineId === item.lineId) ?? null : null;
    const candidate = item && line ? line.candidates.find((entry) => entry.orderId === item.orderId) ?? null : null;
    return {
      index: failure.index,
      code: failure.code,
      message: failure.message,
      lineNo: line?.lineNo ?? null,
      materialName: line?.material?.name ?? line?.nomenclatureName ?? null,
      orderName: candidate?.orderName ?? candidate?.fullNumber ?? null,
      orderId: item?.orderId ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// localStorage draft (план §5.4: «Черновик ручных правок автоподбора — localStorage
// (ключ по пользователю и документу), не сервер»).
// ---------------------------------------------------------------------------

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function suggestionDraftStorageKey(userId: string | number, documentId: number): string {
  return `procurement:suggestion-draft:${userId}:${documentId}`;
}

function safeLocalStorage(): StorageLike | undefined {
  try {
    return typeof globalThis !== 'undefined' && globalThis.localStorage ? globalThis.localStorage : undefined;
  } catch {
    return undefined;
  }
}

function isCandidateDraftState(value: unknown): value is CandidateDraftState {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CandidateDraftState).checked === 'boolean' &&
    typeof (value as CandidateDraftState).quantity === 'number' &&
    Number.isFinite((value as CandidateDraftState).quantity)
  );
}

function isSuggestionDraftState(value: unknown): value is SuggestionDraftState {
  if (typeof value !== 'object' || value === null || !('lines' in value)) return false;
  const lines = (value as { lines: unknown }).lines;
  if (typeof lines !== 'object' || lines === null) return false;
  return Object.values(lines as Record<string, unknown>).every((line) => {
    if (typeof line !== 'object' || line === null || !('candidates' in line)) return false;
    const candidates = (line as { candidates: unknown }).candidates;
    if (typeof candidates !== 'object' || candidates === null) return false;
    return Object.values(candidates as Record<string, unknown>).every(isCandidateDraftState);
  });
}

/** Сохраняет черновик; недоступность/переполнение хранилища — тихо игнорируется. */
export function saveSuggestionDraft(
  userId: string | number,
  documentId: number,
  draft: SuggestionDraftState,
  storage: StorageLike | undefined = safeLocalStorage(),
): void {
  try {
    storage?.setItem(suggestionDraftStorageKey(userId, documentId), JSON.stringify(draft));
  } catch {
    /* приватный режим/квота — черновик просто не сохранится */
  }
}

/** Читает сырой черновик из хранилища; форма не совпадает — null (как если бы черновика не было). */
export function loadRawSuggestionDraft(
  userId: string | number,
  documentId: number,
  storage: StorageLike | undefined = safeLocalStorage(),
): SuggestionDraftState | null {
  try {
    const raw = storage?.getItem(suggestionDraftStorageKey(userId, documentId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isSuggestionDraftState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearSuggestionDraft(
  userId: string | number,
  documentId: number,
  storage: StorageLike | undefined = safeLocalStorage(),
): void {
  try {
    storage?.removeItem(suggestionDraftStorageKey(userId, documentId));
  } catch {
    /* нечего чистить/хранилище недоступно */
  }
}

/**
 * Восстанавливает черновик из хранилища поверх свежего ответа сервера: кандидаты,
 * которых больше нет в ответе (уже распределены кем-то другим, потребность закрыта,
 * заказ выпал из scope), не восстанавливаются — берётся свежее предложение сервера.
 */
export function reconcileDraftWithResponse(
  stored: SuggestionDraftState | null,
  response: AllocationSuggestionsResponse,
): SuggestionDraftState {
  const fresh = buildInitialDraft(response);
  if (!stored) return fresh;
  const lines: SuggestionDraftState['lines'] = {};
  for (const line of response.lines) {
    const freshCandidates = fresh.lines[line.lineId]?.candidates ?? {};
    const storedLine = stored.lines?.[line.lineId];
    // Строка прихода изменилась (единица, материал, размер листа) — её сохранённые количества не восстанавливаются.
    const storedCandidates = storedLine?.context === lineDraftContext(line) ? storedLine.candidates ?? {} : {};
    const candidates: LineDraftState['candidates'] = {};
    for (const candidate of line.candidates) {
      const storedState = storedCandidates[candidate.orderId];
      // Правка переживает перезагрузку, только если закуп и потребность с тех пор не менялись (CR1-1):
      // иначе количество могло устареть — берётся свежее предложение сервера.
      const stillValid = storedState?.edited === true
        && storedState.version === candidate.procurementVersion
        && storedState.fingerprint === candidate.demandFingerprint;
      candidates[candidate.orderId] = stillValid ? storedState : freshCandidates[candidate.orderId];
    }
    lines[line.lineId] = { candidates, context: lineDraftContext(line) };
  }
  return { lines };
}

/** Загрузка + сверка со свежим ответом в один вызов — то, что обычно нужно компоненту. */
export function loadSuggestionDraft(
  userId: string | number,
  documentId: number,
  response: AllocationSuggestionsResponse,
  storage?: StorageLike,
): SuggestionDraftState {
  return reconcileDraftWithResponse(loadRawSuggestionDraft(userId, documentId, storage), response);
}

/** Единая точка правды по кандидату для UI: галочка, количество, ≈ в единице потребности. */
export function candidateDisplay(
  line: AllocationSuggestionLine,
  candidate: AllocationSuggestionCandidate,
  lineDraft: LineDraftState,
): { checked: boolean; quantityInDocUnit: number; quantityInDemandUnit: number | null } {
  const state = lineDraft.candidates[candidate.orderId] ?? { checked: false, quantity: 0 };
  return {
    checked: state.checked,
    quantityInDocUnit: state.quantity,
    quantityInDemandUnit: convertDocUnitToDemandUnit(state.quantity, line.docUnit, line.demandUnit, line.sheetAreaM2),
  };
}
