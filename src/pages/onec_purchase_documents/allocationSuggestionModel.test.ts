import { describe, expect, it } from 'vitest';

import type { AllocationSuggestionsResponse, BatchOnecAllocationFailure } from '../../api/types/onecDocumentsApi.types';
import {
  buildBatchRequest,
  buildInitialDraft,
  canSubmitBatch,
  candidateDisplay,
  clearSuggestionDraft,
  computeLineTotals,
  computeOverallSummary,
  convertDocUnitToDemandUnit,
  getLineDraft,
  hasAnySelection,
  isSuggestionUnmodified,
  lineCapacityDemandEquivalent,
  lineCheckStatus,
  loadRawSuggestionDraft,
  loadSuggestionDraft,
  mapBatchFailures,
  MAX_BATCH_ITEMS,
  lineDraftContext,
  reconcileDraftWithResponse,
  resetLineToProposal,
  saveSuggestionDraft,
  setCandidateChecked,
  setCandidateQuantity,
  suggestionDraftStorageKey,
  type StorageLike,
  type SuggestionDraftState,
} from './allocationSuggestionModel';

function makeResponse(overrides?: Partial<AllocationSuggestionsResponse>): AllocationSuggestionsResponse {
  return {
    documentId: 42,
    number: 'МТ-001842',
    date: '2026-09-28',
    supplierName: 'Мебель-Трейд',
    wastePercent: 5,
    lines: [
      {
        lineId: 1,
        lineNo: 1,
        nomenclatureName: 'ЛДСП Egger W1000 белый 16 мм',
        material: { resourceKey: 'sheet:w1000', kind: 'sheet_material', refId: 10, name: 'ЛДСП Egger W1000 белый 16 мм' },
        docUnit: 'sheet',
        demandUnit: 'm2',
        sheetAreaM2: 5.796,
        capacityInDocUnit: 7,
        remainingInDocUnit: 7,
        skipReason: null,
        alreadyAllocated: [],
        surplusInDocUnit: 0,
        candidates: [
          {
            orderId: 2971,
            orderName: '2971',
            fullNumber: '2971',
            clientName: 'Еркебулан Мусин',
            dueDate: '2026-10-01',
            urgency: 'soon',
            daysLeft: 2,
            demandUnit: 'm2',
            needInDemandUnit: 6.8,
            deficitInDemandUnit: 6.8,
            proposedInDocUnit: 1,
            proposedInDemandUnit: 5.796,
            reasons: [{ code: 'due', label: 'в цех через 2 дн.', tone: 'warning' }],
            purchased: false,
            procurementVersion: 3,
            demandFingerprint: 'fp-2971',
          },
          {
            orderId: 2969,
            orderName: '2969',
            fullNumber: '2969',
            clientName: 'Максим Мустафа',
            dueDate: '2026-10-02',
            urgency: 'soon',
            daysLeft: 3,
            demandUnit: 'm2',
            needInDemandUnit: 14.6,
            deficitInDemandUnit: 8.8,
            proposedInDocUnit: 0,
            proposedInDemandUnit: 0,
            reasons: [{ code: 'closes', label: 'приход закончился', tone: 'default' }],
            purchased: false,
            procurementVersion: 1,
            demandFingerprint: 'fp-2969',
          },
        ],
      },
    ],
    ...overrides,
  };
}

function fakeStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
}

describe('buildInitialDraft', () => {
  it('checks candidates with a positive proposal and keeps proposed quantity for all', () => {
    const draft = buildInitialDraft(makeResponse());
    expect(draft.lines[1].candidates[2971]).toMatchObject({ checked: true, quantity: 1, version: 3, fingerprint: 'fp-2971', edited: false });
    expect(draft.lines[1].candidates[2969]).toMatchObject({ checked: false, quantity: 0 });
  });
});

describe('setCandidateChecked / setCandidateQuantity', () => {
  it('toggles a candidate without touching others', () => {
    const response = makeResponse();
    const draft = buildInitialDraft(response);
    const next = setCandidateChecked(draft, 1, 2969, true);
    expect(next.lines[1].candidates[2969].checked).toBe(true);
    expect(next.lines[1].candidates[2971]).toEqual(draft.lines[1].candidates[2971]);
    // original untouched (immutability)
    expect(draft.lines[1].candidates[2969].checked).toBe(false);
  });

  it('clamps negative/NaN quantity to 0 and rounds to 3 decimals', () => {
    const draft = buildInitialDraft(makeResponse());
    const next = setCandidateQuantity(draft, 1, 2971, -5);
    expect(next.lines[1].candidates[2971].quantity).toBe(0);
    const rounded = setCandidateQuantity(draft, 1, 2971, 1.23456);
    expect(rounded.lines[1].candidates[2971].quantity).toBe(1.235);
    const nan = setCandidateQuantity(draft, 1, 2971, Number.NaN);
    expect(nan.lines[1].candidates[2971].quantity).toBe(0);
  });
});

describe('computeLineTotals', () => {
  it('sums checked candidates in integer thousandths to avoid float noise', () => {
    const response = makeResponse();
    const line = response.lines[0];
    let draft = buildInitialDraft(response);
    draft = setCandidateChecked(draft, 1, 2969, true);
    draft = setCandidateQuantity(draft, 1, 2969, 0.1);
    draft = setCandidateQuantity(draft, 1, 2971, 0.2);
    const totals = computeLineTotals(line, getLineDraft(draft, 1));
    // 0.1 + 0.2 !== 0.3 in plain floating point; integer-thousandths math must fix this.
    expect(totals.distributedInDocUnit).toBe(0.3);
    expect(totals.leftInDocUnit).toBeCloseTo(6.7, 10);
    expect(totals.overrun).toBe(false);
  });

  it('detects overrun when distributed exceeds remaining', () => {
    const response = makeResponse();
    const line = { ...response.lines[0], remainingInDocUnit: 0.5 };
    const draft = buildInitialDraft(response);
    const totals = computeLineTotals(line, getLineDraft(draft, 1));
    expect(totals.overrun).toBe(true);
    expect(totals.leftInDocUnit).toBeCloseTo(-0.5, 10);
    expect(totals.surplusInDocUnit).toBe(0);
  });

  it('reports surplus when nothing overruns but capacity remains', () => {
    const response = makeResponse();
    const line = response.lines[0];
    const draft = buildInitialDraft(response); // only 1 of 7 sheets distributed
    const totals = computeLineTotals(line, getLineDraft(draft, 1));
    expect(totals.overrun).toBe(false);
    expect(totals.surplusInDocUnit).toBe(6);
  });
});

describe('lineCheckStatus', () => {
  it('maps totals to a status', () => {
    expect(lineCheckStatus({ distributedInDocUnit: 0, leftInDocUnit: 7, overrun: false, surplusInDocUnit: 7 })).toBe('surplus');
    expect(lineCheckStatus({ distributedInDocUnit: 7, leftInDocUnit: 0, overrun: false, surplusInDocUnit: 0 })).toBe('exact');
    expect(lineCheckStatus({ distributedInDocUnit: 0, leftInDocUnit: 0, overrun: false, surplusInDocUnit: 0 })).toBe('empty');
    expect(lineCheckStatus({ distributedInDocUnit: 8, leftInDocUnit: -1, overrun: true, surplusInDocUnit: 0 })).toBe('overrun');
  });
});

describe('convertDocUnitToDemandUnit', () => {
  it('converts sheets to m2 via sheet area', () => {
    expect(convertDocUnitToDemandUnit(2, 'sheet', 'm2', 5.796)).toBeCloseTo(11.592, 10);
  });
  it('passes through identical units 1:1', () => {
    expect(convertDocUnitToDemandUnit(3.5, 'lm', 'lm', null)).toBe(3.5);
    expect(convertDocUnitToDemandUnit(3.5, 'm2', 'm2', null)).toBe(3.5);
  });
  it('returns null for incompatible/unknown combinations', () => {
    expect(convertDocUnitToDemandUnit(1, 'pcs', 'm2', null)).toBeNull();
    expect(convertDocUnitToDemandUnit(1, 'sheet', 'm2', null)).toBeNull();
    expect(convertDocUnitToDemandUnit(1, null, 'm2', null)).toBeNull();
  });
  it('lineCapacityDemandEquivalent reads line-level fields', () => {
    const line = makeResponse().lines[0];
    expect(lineCapacityDemandEquivalent(line)).toBeCloseTo(7 * 5.796, 10);
  });
});

describe('computeOverallSummary / hasAnySelection / canSubmitBatch', () => {
  it('counts eligible lines, distinct orders and overrun across the document', () => {
    const response = makeResponse();
    const draft = buildInitialDraft(response);
    const summary = computeOverallSummary(response, draft);
    expect(summary.linesCount).toBe(1);
    expect(summary.ordersCount).toBe(1); // only 2971 checked with qty>0
    expect(summary.overrun).toBe(false);
    expect(summary.surplusByUnit).toEqual([{ unit: 'sheet', surplusInDocUnit: 6 }]);
    expect(hasAnySelection(response, draft)).toBe(true);
    expect(canSubmitBatch(response, draft)).toBe(true);
  });

  it('excludes skipped lines from the summary', () => {
    const response = makeResponse({
      lines: [{ ...makeResponse().lines[0], skipReason: 'fully_allocated' }],
    });
    const draft = buildInitialDraft(response);
    const summary = computeOverallSummary(response, draft);
    expect(summary.linesCount).toBe(0);
  });

  it('blocks submit on overrun even if something is selected', () => {
    const response = makeResponse();
    const line = { ...response.lines[0], remainingInDocUnit: 0.5 };
    const withOverrun = { ...response, lines: [line] };
    const draft = buildInitialDraft(withOverrun);
    expect(canSubmitBatch(withOverrun, draft)).toBe(false);
  });

  it('blocks submit with nothing selected', () => {
    const response = makeResponse();
    const draft: SuggestionDraftState = { lines: { 1: { candidates: {} } } };
    expect(hasAnySelection(response, draft)).toBe(false);
    expect(canSubmitBatch(response, draft)).toBe(false);
  });
});

describe('isSuggestionUnmodified / buildBatchRequest origin', () => {
  it('is unmodified right after buildInitialDraft', () => {
    const response = makeResponse();
    const draft = buildInitialDraft(response);
    expect(isSuggestionUnmodified(response, draft)).toBe(true);
    const result = buildBatchRequest(response, draft, 'req-1');
    expect(result.error).toBeNull();
    expect(result.request?.origin).toBe('suggested');
    expect(result.request?.items).toEqual([
      { lineId: 1, orderId: 2971, resourceKey: 'sheet:w1000', quantity: 1, expectedVersion: 3, expectedDemandFingerprint: 'fp-2971', expectedDocUnit: 'sheet', expectedSheetAreaM2: 5.796 },
    ]);
  });

  it('becomes manual when a quantity is edited', () => {
    const response = makeResponse();
    let draft = buildInitialDraft(response);
    draft = setCandidateQuantity(draft, 1, 2971, 2);
    expect(isSuggestionUnmodified(response, draft)).toBe(false);
    const result = buildBatchRequest(response, draft, 'req-2');
    expect(result.request?.origin).toBe('manual');
  });

  it('becomes manual when a proposed candidate is unchecked', () => {
    const response = makeResponse();
    let draft = buildInitialDraft(response);
    draft = setCandidateChecked(draft, 1, 2971, false);
    expect(isSuggestionUnmodified(response, draft)).toBe(false);
  });

  it('becomes manual when a zero-proposal candidate is checked with a quantity', () => {
    const response = makeResponse();
    let draft = buildInitialDraft(response);
    draft = setCandidateChecked(draft, 1, 2969, true);
    draft = setCandidateQuantity(draft, 1, 2969, 0.5);
    expect(isSuggestionUnmodified(response, draft)).toBe(false);
  });
});

describe('buildBatchRequest guards', () => {
  it('errors when nothing is checked', () => {
    const response = makeResponse();
    const draft: SuggestionDraftState = { lines: { 1: { candidates: {} } } };
    const result = buildBatchRequest(response, draft, 'req-3');
    expect(result.request).toBeNull();
    expect(result.error).toMatch(/Отметьте/);
  });

  it('errors when the checked set exceeds MAX_BATCH_ITEMS', () => {
    const candidates = Array.from({ length: MAX_BATCH_ITEMS + 1 }, (_, index) => ({
      orderId: index + 1,
      orderName: String(index + 1),
      fullNumber: String(index + 1),
      clientName: null,
      dueDate: null,
      urgency: 'no_date' as const,
      daysLeft: null,
      demandUnit: 'm2' as const,
      needInDemandUnit: 1,
      deficitInDemandUnit: 1,
      proposedInDocUnit: 1,
      proposedInDemandUnit: 5.796,
      reasons: [],
      purchased: false,
      procurementVersion: 1,
      demandFingerprint: `fp-${index + 1}`,
    }));
    const response = makeResponse({
      lines: [{ ...makeResponse().lines[0], capacityInDocUnit: 1000, remainingInDocUnit: 1000, candidates }],
    });
    const draft = buildInitialDraft(response);
    const result = buildBatchRequest(response, draft, 'req-4');
    expect(result.request).toBeNull();
    expect(result.error).toMatch(new RegExp(String(MAX_BATCH_ITEMS)));
  });

  it('skips lines without a mapped material defensively', () => {
    const response = makeResponse({
      lines: [{ ...makeResponse().lines[0], material: null }],
    });
    const draft = buildInitialDraft(response);
    const result = buildBatchRequest(response, draft, 'req-5');
    expect(result.request).toBeNull();
    expect(result.error).toMatch(/Отметьте/);
  });
});

describe('mapBatchFailures', () => {
  it('resolves index back to line/order labels', () => {
    const response = makeResponse();
    const draft = buildInitialDraft(response);
    const built = buildBatchRequest(response, draft, 'req-6');
    if (!built.request) throw new Error('expected a request');
    const failures: BatchOnecAllocationFailure[] = [{ index: 0, code: 'PROCUREMENT_DEMAND_CHANGED', message: 'stale' }];
    const mapped = mapBatchFailures(failures, built.request, response);
    expect(mapped).toEqual([
      {
        index: 0,
        code: 'PROCUREMENT_DEMAND_CHANGED',
        message: 'stale',
        lineNo: 1,
        materialName: 'ЛДСП Egger W1000 белый 16 мм',
        orderName: '2971',
        orderId: 2971,
      },
    ]);
  });

  it('degrades gracefully for an out-of-range index', () => {
    const response = makeResponse();
    const draft = buildInitialDraft(response);
    const built = buildBatchRequest(response, draft, 'req-7');
    if (!built.request) throw new Error('expected a request');
    const mapped = mapBatchFailures([{ index: 99, code: 'X', message: 'm' }], built.request, response);
    expect(mapped[0]).toEqual({ index: 99, code: 'X', message: 'm', lineNo: null, materialName: null, orderName: null, orderId: null });
  });
});

describe('resetLineToProposal', () => {
  it('discards manual edits for a single line back to the server proposal', () => {
    const response = makeResponse();
    let draft = buildInitialDraft(response);
    draft = setCandidateQuantity(draft, 1, 2971, 999);
    draft = setCandidateChecked(draft, 1, 2969, true);
    const reset = resetLineToProposal(draft, response.lines[0]);
    expect(reset.lines[1]).toEqual(buildInitialDraft(response).lines[1]);
  });
});

describe('candidateDisplay', () => {
  it('reports checked/quantity/demand-unit equivalent for a candidate', () => {
    const response = makeResponse();
    const draft = buildInitialDraft(response);
    const display = candidateDisplay(response.lines[0], response.lines[0].candidates[0], getLineDraft(draft, 1));
    expect(display.checked).toBe(true);
    expect(display.quantityInDocUnit).toBe(1);
    expect(display.quantityInDemandUnit).toBeCloseTo(5.796, 10);
  });
});

describe('localStorage draft', () => {
  it('round-trips save/load through a fake storage', () => {
    const storage = fakeStorage();
    const response = makeResponse();
    let draft = buildInitialDraft(response);
    draft = setCandidateChecked(draft, 1, 2969, true);
    saveSuggestionDraft('user-1', 42, draft, storage);
    const loaded = loadRawSuggestionDraft('user-1', 42, storage);
    expect(loaded).toEqual(draft);
    expect(storage.data.has(suggestionDraftStorageKey('user-1', 42))).toBe(true);
    clearSuggestionDraft('user-1', 42, storage);
    expect(loadRawSuggestionDraft('user-1', 42, storage)).toBeNull();
  });

  it('works without storage (throwing storage is swallowed)', () => {
    const throwing: StorageLike = {
      getItem: () => { throw new Error('no storage'); },
      setItem: () => { throw new Error('no storage'); },
      removeItem: () => { throw new Error('no storage'); },
    };
    expect(() => saveSuggestionDraft('u', 1, buildInitialDraft(makeResponse()), throwing)).not.toThrow();
    expect(loadRawSuggestionDraft('u', 1, throwing)).toBeNull();
    expect(() => clearSuggestionDraft('u', 1, throwing)).not.toThrow();
  });

  it('ignores malformed stored JSON and falls back to a fresh draft', () => {
    const storage = fakeStorage();
    storage.setItem(suggestionDraftStorageKey('u', 1), 'not json');
    const response = makeResponse();
    expect(loadSuggestionDraft('u', 1, response, storage)).toEqual(buildInitialDraft(response));
  });

  it('reconciles stored candidates against a fresh response, dropping ones that no longer exist', () => {
    const response = makeResponse();
    const stored: SuggestionDraftState = {
      lines: {
        1: {
          context: lineDraftContext(response.lines[0]),
          candidates: {
            2971: { checked: true, quantity: 4, version: 3, fingerprint: 'fp-2971', edited: true },
            // 9999 no longer exists in the fresh response candidates list.
            9999: { checked: true, quantity: 3 },
          },
        },
      },
    };
    const reconciled = reconcileDraftWithResponse(stored, response);
    expect(reconciled.lines[1].candidates[2971]).toMatchObject({ checked: true, quantity: 4 });
    // 2969 wasn't in the stored draft: falls back to the fresh proposal for it.
    expect(reconciled.lines[1].candidates[2969]).toMatchObject({ checked: false, quantity: 0 });
    expect(reconciled.lines[1].candidates[9999]).toBeUndefined();
  });

  it('loadSuggestionDraft combines load + reconcile in one call', () => {
    const storage = fakeStorage();
    const response = makeResponse();
    saveSuggestionDraft('u', 1, { lines: { 1: { context: lineDraftContext(response.lines[0]), candidates: { 2971: { checked: true, quantity: 6, version: 3, fingerprint: 'fp-2971', edited: true } } } } }, storage);
    const loaded = loadSuggestionDraft('u', 1, response, storage);
    expect(loaded.lines[1].candidates[2971]).toMatchObject({ checked: true, quantity: 6 });
    expect(loaded.lines[1].candidates[2969]).toMatchObject({ checked: false, quantity: 0 });
  });
});

describe('CR1-1: сохранённый черновик не переживает изменение закупа или потребности', () => {
  function withCandidate(patch: Partial<AllocationSuggestionsResponse['lines'][number]['candidates'][number]>): AllocationSuggestionsResponse {
    const base = makeResponse();
    return { ...base, lines: [{ ...base.lines[0], candidates: [{ ...base.lines[0].candidates[0], ...patch }, base.lines[0].candidates[1]] }] };
  }

  it('правка восстанавливается, когда версия и отпечаток те же', () => {
    const response = makeResponse();
    const edited = setCandidateQuantity(reconcileDraftWithResponse(null, response), 1, 2971, 0.5);
    expect(reconcileDraftWithResponse(edited, response).lines[1].candidates[2971].quantity).toBe(0.5);
  });

  it('потребность уменьшилась (новый отпечаток) — берётся свежее предложение, а не старое количество', () => {
    const edited = setCandidateQuantity(reconcileDraftWithResponse(null, makeResponse()), 1, 2971, 0.9);
    const fresh = withCandidate({ demandFingerprint: 'fp-2971-new', proposedInDocUnit: 0.3 });
    expect(reconcileDraftWithResponse(edited, fresh).lines[1].candidates[2971]).toMatchObject({ quantity: 0.3, edited: false });
  });

  it('закуп изменился (новая версия) — тоже свежее предложение', () => {
    const edited = setCandidateChecked(reconcileDraftWithResponse(null, makeResponse()), 1, 2971, false);
    const fresh = withCandidate({ procurementVersion: 4 });
    expect(reconcileDraftWithResponse(edited, fresh).lines[1].candidates[2971].checked).toBe(true);
  });

  it('неправленное предложение не «замораживает» старое количество', () => {
    const untouched = reconcileDraftWithResponse(null, makeResponse());
    const fresh = withCandidate({ proposedInDocUnit: 0.2 });
    expect(reconcileDraftWithResponse(untouched, fresh).lines[1].candidates[2971].quantity).toBe(0.2);
  });

  it('старый черновик без контекста считается устаревшим', () => {
    const legacy = { lines: { 1: { candidates: { 2971: { checked: true, quantity: 9 } } } } };
    expect(reconcileDraftWithResponse(legacy, makeResponse()).lines[1].candidates[2971].quantity).toBe(1);
  });
});

describe('CR1-4: права проверяются до загрузки', () => {
  it('панель показывает отказ по правам раньше спиннера загрузки', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/pages/onec_purchase_documents/AllocationSuggestionPanel.tsx', 'utf8');
    expect(source.indexOf('if (!canManage)')).toBeGreaterThan(-1);
    expect(source.indexOf('if (!canManage)')).toBeLessThan(source.indexOf("if (state.status === 'loading') return <Spin />"));
  });

  it('кнопка «Подобрать заказы» в карточке документа — только при capabilities.supplyWorkspace (CR1-3)', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/pages/onec_purchase_documents/show.tsx', 'utf8');
    expect(source).toContain("supplyWorkspace: response.capabilities?.supplyWorkspace === true");
    expect(source).toContain('{state.supplyWorkspace && canSuggestAllocations(state.data)');
  });
});

describe('CR2-1: смена единицы/материала строки прихода сбрасывает сохранённые количества', () => {
  it('10 м² не превращаются в 10 листов при тех же версии и отпечатке', () => {
    const base = makeResponse({ lines: [{ ...makeResponse().lines[0], docUnit: 'm2' }] });
    const edited = setCandidateQuantity(reconcileDraftWithResponse(null, base), 1, 2971, 10);
    expect(reconcileDraftWithResponse(edited, base).lines[1].candidates[2971].quantity).toBe(10);
    const changedUnit = makeResponse({ lines: [{ ...makeResponse().lines[0], docUnit: 'sheet' }] });
    expect(reconcileDraftWithResponse(edited, changedUnit).lines[1].candidates[2971]).toMatchObject({ quantity: 1, edited: false });
  });

  it('другая площадь листа или материал — тоже свежее предложение', () => {
    const base = makeResponse();
    const edited = setCandidateQuantity(reconcileDraftWithResponse(null, base), 1, 2971, 0.4);
    const otherArea = makeResponse({ lines: [{ ...base.lines[0], sheetAreaM2: 5.0325 }] });
    expect(reconcileDraftWithResponse(edited, otherArea).lines[1].candidates[2971].quantity).toBe(1);
  });
});
