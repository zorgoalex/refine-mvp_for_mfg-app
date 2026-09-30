import { describe, expect, it } from 'vitest';
import {
  pairKey,
  planAllocationSuggestions,
  type SuggestionCandidateInput,
  type SuggestionLineInput,
  type SuggestionPlanInput,
} from './allocation-suggestions';

const MDF = { resourceKey: 'sheet_material:8', kind: 'sheet_material' as const, refId: 8, name: 'МДФ 16мм' };

function line(overrides: Partial<SuggestionLineInput> = {}): SuggestionLineInput {
  return {
    lineId: 1, lineNo: 1, nomenclatureName: 'МДФ', material: MDF, docUnit: 'm2', sheetAreaM2: 5,
    capacityInDocUnit: 10, allocatedInDocUnit: 0, onecOrderRefKey: null, ...overrides,
  };
}

function candidate(overrides: Partial<SuggestionCandidateInput> = {}): SuggestionCandidateInput {
  return {
    orderId: 1, orderName: '2972', fullNumber: 'МП-2972', clientName: null, orderRefKey1c: null,
    resourceKey: MDF.resourceKey, need: 4, covered: 0, source: 'cut', purchased: false,
    dueDate: '2026-10-01', urgency: 'critical', daysLeft: 2, supplierKey: 'none',
    procurementVersion: 0, demandFingerprint: 'f'.repeat(64), ...overrides,
  };
}

function plan(overrides: Partial<SuggestionPlanInput>) {
  return planAllocationSuggestions({
    lines: [line()], candidates: [candidate()], allocatedPairs: new Set(), alreadyAllocated: new Map(),
    documentSupplierKeys: [], wastePercent: 5, maxProposals: 100, ...overrides,
  }).lines;
}

describe('planAllocationSuggestions', () => {
  it('R1-4: дефицит 10 м², лист 5 м², в строке 10 листов → предложено 2 листа (= 10 м²)', () => {
    const [result] = plan({ lines: [line({ docUnit: 'sheet', capacityInDocUnit: 10 })], candidates: [candidate({ need: 10 })] });
    expect(result.candidates[0]).toMatchObject({ proposedInDocUnit: 2, proposedInDemandUnit: 10, deficitInDemandUnit: 10 });
    expect(result.surplusInDocUnit).toBe(8);
  });

  it('листы — вниз до 0,001 после перевода: 3 м² при листе 5 м² → 0,6 листа', () => {
    const [result] = plan({ lines: [line({ docUnit: 'sheet' })], candidates: [candidate({ need: 3 })] });
    expect(result.candidates[0].proposedInDocUnit).toBe(0.6);
  });

  it('раскладывает по очереди срока и отдаёт остаток на склад', () => {
    const [result] = plan({
      candidates: [
        candidate({ orderId: 2, need: 5, dueDate: '2026-10-05', urgency: 'soon', daysLeft: 6 }),
        candidate({ orderId: 1, need: 4 }),
      ],
      lines: [line({ capacityInDocUnit: 6 })],
    });
    expect(result.candidates.map((c) => [c.orderId, c.proposedInDocUnit])).toEqual([[1, 4], [2, 2]]);
    expect(result.candidates[1].reasons.map((r) => r.label)).toContain('закроет частично');
    expect(result.surplusInDocUnit).toBe(0);
  });

  it('R1-6: две строки одного материала не дают заказу больше его дефицита', () => {
    const results = plan({
      lines: [line({ lineId: 1, lineNo: 1, capacityInDocUnit: 10 }), line({ lineId: 2, lineNo: 2, capacityInDocUnit: 10 })],
      candidates: [candidate({ need: 10 })],
      wastePercent: 0,
    });
    const total = results.flatMap((r) => r.candidates).reduce((sum, c) => sum + c.proposedInDocUnit, 0);
    expect(total).toBe(10);
    expect(results[1].candidates).toEqual([]);
    expect(results[1].surplusInDocUnit).toBe(10);
  });

  it('заказ, указанный в строке 1С, — первым, даже если срок позже', () => {
    const [result] = plan({
      lines: [line({ capacityInDocUnit: 4, onecOrderRefKey: 'ref-2' })],
      candidates: [candidate({ orderId: 1 }), candidate({ orderId: 2, orderRefKey1c: 'ref-2', dueDate: '2026-11-01', urgency: 'normal', daysLeft: 30 })],
    });
    expect(result.candidates[0]).toMatchObject({ orderId: 2, proposedInDocUnit: 4 });
    expect(result.candidates[0].reasons[0]).toMatchObject({ code: 'onec_order' });
    expect(result.candidates[1].proposedInDocUnit).toBe(0);
  });

  it('запас на обрезки — только для потребности по площади и один раз', () => {
    const [area] = plan({ candidates: [candidate({ need: 4, source: 'area' })] });
    expect(area.candidates[0]).toMatchObject({ deficitInDemandUnit: 4.2, proposedInDocUnit: 4.2 });
    const [cut] = plan({ candidates: [candidate({ need: 4, source: 'cut' })] });
    expect(cut.candidates[0].proposedInDocUnit).toBe(4);
  });

  it('покрытое (приходы/ручная отметка) не предлагается; пары с распределением — только «уже распределено»', () => {
    const [covered] = plan({ candidates: [candidate({ need: 4, covered: 4 })] });
    expect(covered.candidates).toEqual([]);
    const already = new Map([[1, [{ orderId: 1, orderName: '2972', quantityInDocUnit: 1 }]]]);
    const [result] = plan({ allocatedPairs: new Set([pairKey(1, 1)]), alreadyAllocated: already, lines: [line({ allocatedInDocUnit: 1 })] });
    expect(result.candidates).toEqual([]);
    expect(result.alreadyAllocated).toEqual(already.get(1));
    expect(result.remainingInDocUnit).toBe(9);
  });

  it('строки, которые нельзя подобрать, объясняются', () => {
    expect(plan({ lines: [line({ material: null })] })[0].skipReason).toBe('not_mapped');
    expect(plan({ lines: [line({ docUnit: 'pcs' })] })[0].skipReason).toBe('incompatible_unit');
    expect(plan({ lines: [line({ docUnit: 'sheet', sheetAreaM2: null })] })[0].skipReason).toBe('incompatible_unit');
    expect(plan({ lines: [line({ allocatedInDocUnit: 10 })] })[0].skipReason).toBe('fully_allocated');
  });

  it('строка удалена или изменилась в 1С — причина раньше not_mapped и fully_allocated, кандидатов нет', () => {
    const removed = plan({ lines: [line({ removedInOnec: true, material: null, allocatedInDocUnit: 10 })] })[0];
    expect(removed).toMatchObject({ skipReason: 'removed_in_onec', candidates: [] });
    const conflict = plan({ lines: [line({ onecConflict: true, material: null, allocatedInDocUnit: 10 })] })[0];
    expect(conflict).toMatchObject({ skipReason: 'onec_conflict', candidates: [] });
    expect(plan({ lines: [line({ removedInOnec: true, onecConflict: true })] })[0].skipReason).toBe('removed_in_onec');
  });

  it('детерминирован и учитывает совпадение поставщика и отметку', () => {
    const input = {
      lines: [line({ capacityInDocUnit: 1 })],
      candidates: [
        candidate({ orderId: 3, purchased: true, supplierKey: 's:1' }),
        candidate({ orderId: 4, supplierKey: 's:1' }),
        candidate({ orderId: 5 }),
      ],
      documentSupplierKeys: ['c:11111111-1111-1111-1111-111111111111', 's:1'],
    };
    const first = plan(input);
    expect(first[0].candidates.map((c) => c.orderId)).toEqual([4, 5, 3]);
    expect(plan(input)).toEqual(first);
    expect(first[0].candidates[0].reasons.map((r) => r.code)).toEqual(['due', 'unmarked', 'supplier', 'closes']);
  });
});

describe('CR1-2: предложение укладывается в одну атомарную команду', () => {
  it('101 заказ с дефицитом → ровно 100 предложений, остальным количество 0 и флаг лимита', () => {
    const candidates = Array.from({ length: 101 }, (_, index) => candidate({ orderId: index + 1, need: 1 }));
    const result = planAllocationSuggestions({
      lines: [line({ capacityInDocUnit: 101 })], candidates, allocatedPairs: new Set(), alreadyAllocated: new Map(),
      documentSupplierKeys: [], wastePercent: 0, maxProposals: 100,
    });
    const proposed = result.lines[0].candidates.filter((c) => c.proposedInDocUnit > 0);
    expect(proposed).toHaveLength(100);
    expect(result.limitReached).toBe(true);
    expect(result.lines[0].surplusInDocUnit).toBe(1);
  });

  it('лимит считается по распределениям на весь документ (несколько строк)', () => {
    const candidates = Array.from({ length: 120 }, (_, index) => candidate({ orderId: index + 1, need: 1 }));
    const result = planAllocationSuggestions({
      lines: [line({ lineId: 1, lineNo: 1, capacityInDocUnit: 60 }), line({ lineId: 2, lineNo: 2, capacityInDocUnit: 60 })],
      candidates, allocatedPairs: new Set(), alreadyAllocated: new Map(), documentSupplierKeys: [], wastePercent: 0, maxProposals: 100,
    });
    const total = result.lines.flatMap((l) => l.candidates).filter((c) => c.proposedInDocUnit > 0).length;
    expect(total).toBe(100);
    expect(result.limitReached).toBe(true);
  });

  it('ровно 100 — без флага', () => {
    const candidates = Array.from({ length: 100 }, (_, index) => candidate({ orderId: index + 1, need: 1 }));
    const result = planAllocationSuggestions({
      lines: [line({ capacityInDocUnit: 100 })], candidates, allocatedPairs: new Set(), alreadyAllocated: new Map(),
      documentSupplierKeys: [], wastePercent: 0, maxProposals: 100,
    });
    expect(result.limitReached).toBe(false);
  });
});
