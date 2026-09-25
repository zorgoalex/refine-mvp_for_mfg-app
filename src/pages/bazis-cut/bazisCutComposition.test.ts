import { describe, expect, it } from 'vitest';
import {
  buildCompositionRows,
  CompositionCommandBuilder,
  compositionUnavailableText,
  describeCompositionPreview,
  generateCompositionIdempotencyKey,
  isEligibleForComposition,
  mergeSetAfterMutation,
  needsCompositionReload,
  type CompositionDetailLookup,
} from './bazisCutComposition';
import type {
  BazisCutCompositionPreviewResponse,
  BazisCutSetCardDto,
  MdfCompositionUnavailableReason,
} from '../../api/bazisCutApi';

describe('buildCompositionRows', () => {
  const details = [
    { bazisCutSetDetailId: 1, quantity: 10 },
    { bazisCutSetDetailId: 2, quantity: 4 },
    { bazisCutSetDetailId: 3, quantity: 1 },
  ];
  const allEligible = ['1', '2', '3'];

  it('keeps every row at its current quantity when nothing is edited', () => {
    expect(buildCompositionRows(details, { kind: 'deleteMany', detailIds: [] }, allEligible)).toEqual([
      { rowId: '1', quantity: 10 },
      { rowId: '2', quantity: 4 },
      { rowId: '3', quantity: 1 },
    ]);
  });

  it('changes only the target row quantity, leaving the rest untouched', () => {
    expect(buildCompositionRows(details, { kind: 'quantity', detailId: 2, quantity: 7 }, allEligible)).toEqual([
      { rowId: '1', quantity: 10 },
      { rowId: '2', quantity: 7 },
      { rowId: '3', quantity: 1 },
    ]);
  });

  it('treats a quantity of 0 as deleting the row', () => {
    expect(buildCompositionRows(details, { kind: 'quantity', detailId: 2, quantity: 0 }, allEligible)).toEqual([
      { rowId: '1', quantity: 10 },
      { rowId: '3', quantity: 1 },
    ]);
  });

  it('treats a negative quantity as deleting the row', () => {
    expect(buildCompositionRows(details, { kind: 'quantity', detailId: 1, quantity: -1 }, allEligible)).toEqual([
      { rowId: '2', quantity: 4 },
      { rowId: '3', quantity: 1 },
    ]);
  });

  it('deletes exactly one row and keeps the complete list of the rest', () => {
    expect(buildCompositionRows(details, { kind: 'delete', detailId: 3 }, allEligible)).toEqual([
      { rowId: '1', quantity: 10 },
      { rowId: '2', quantity: 4 },
    ]);
  });

  it('bulk-deletes several rows at once', () => {
    expect(buildCompositionRows(details, { kind: 'deleteMany', detailIds: [1, 3] }, allEligible)).toEqual([
      { rowId: '2', quantity: 4 },
    ]);
  });

  it('empties the set when every row is deleted', () => {
    expect(buildCompositionRows(details, { kind: 'deleteMany', detailIds: [1, 2, 3] }, allEligible)).toEqual([]);
  });

  it('is a no-op on an already-empty set', () => {
    expect(buildCompositionRows([], { kind: 'delete', detailId: 1 }, allEligible)).toEqual([]);
  });

  describe('eligibility (HDF rows, non-MDF materials, cut-disabled rows)', () => {
    it('excludes non-eligible rows from an unedited desired list, keeping eligible ones complete', () => {
      expect(buildCompositionRows(details, { kind: 'deleteMany', detailIds: [] }, ['1', '3'])).toEqual([
        { rowId: '1', quantity: 10 },
        { rowId: '3', quantity: 1 },
      ]);
    });

    it('editing one eligible row keeps the other eligible rows and still excludes non-eligible ones', () => {
      expect(buildCompositionRows(details, { kind: 'quantity', detailId: 1, quantity: 5 }, ['1', '3'])).toEqual([
        { rowId: '1', quantity: 5 },
        { rowId: '3', quantity: 1 },
      ]);
    });

    it('bulk delete ignores ids that are not eligible (they are never part of desiredRows either way)', () => {
      // Row 2 is not eligible; deleting it via the edit is moot since it is already excluded.
      expect(buildCompositionRows(details, { kind: 'deleteMany', detailIds: [2, 3] }, ['1', '2'])).toEqual([
        { rowId: '1', quantity: 10 },
      ]);
    });

    it('never includes the edit target when it is not eligible, even though the UI should not allow this', () => {
      expect(buildCompositionRows(details, { kind: 'quantity', detailId: 2, quantity: 9 }, ['1', '3'])).toEqual([
        { rowId: '1', quantity: 10 },
        { rowId: '3', quantity: 1 },
      ]);
    });

    it('produces an empty list when nothing is eligible', () => {
      expect(buildCompositionRows(details, { kind: 'deleteMany', detailIds: [] }, [])).toEqual([]);
    });
  });
});

describe('isEligibleForComposition', () => {
  it('matches by string(bazisCutSetDetailId) membership in eligibleRowIds', () => {
    expect(isEligibleForComposition(7, ['7', '9'])).toBe(true);
    expect(isEligibleForComposition(8, ['7', '9'])).toBe(false);
    expect(isEligibleForComposition(7, [])).toBe(false);
  });
});

describe('compositionUnavailableText', () => {
  const reasons: MdfCompositionUnavailableReason[] = [
    'MDF_ENGINE_NOT_ACTIVE', 'MDF_ENGINE_READ_ONLY', 'MDF_SOURCE_NOT_REGISTERED',
    'MDF_PUBLICATION_PENDING', 'MDF_SOURCE_ISSUES', 'MDF_PARTIAL_ACCESS',
  ];

  it.each(reasons)('returns a distinct, non-empty Russian explanation for %s', (reason) => {
    const text = compositionUnavailableText(reason);
    expect(text.length).toBeGreaterThan(0);
    expect(/[а-яё]/i.test(text)).toBe(true);
  });

  it('produces a distinct message per reason', () => {
    const texts = new Set(reasons.map((reason) => compositionUnavailableText(reason)));
    expect(texts.size).toBe(reasons.length);
  });

  it('falls back to a generic message for null', () => {
    expect(compositionUnavailableText(null).length).toBeGreaterThan(0);
  });

  it('specifically calls out the retry-later case for MDF_PUBLICATION_PENDING', () => {
    expect(compositionUnavailableText('MDF_PUBLICATION_PENDING')).toContain('обновите страницу');
  });

  it('specifically calls out missing access for MDF_PARTIAL_ACCESS', () => {
    expect(compositionUnavailableText('MDF_PARTIAL_ACCESS')).toContain('нет доступа');
  });
});

describe('describeCompositionPreview', () => {
  const detailsBefore: CompositionDetailLookup[] = [
    { bazisCutSetDetailId: 1, quantity: 10, sourceOrderName: 'ERP-1491', partName: 'К1_Цоколь' },
    { bazisCutSetDetailId: 2, quantity: 4, sourceOrderName: '', sourceOrderFullNumber: 'ERP-1492', partName: 'Полка' },
  ];

  it('renders a blocked preview with blocker lines and no assignment/retained/preserved lines', () => {
    const preview: BazisCutCompositionPreviewResponse = {
      status: 'blocked', beforeVersion: '3', previewDigest: null,
      assignmentChanges: [], retainedPhysical: [], preservedAllocations: [],
      blockers: [{ code: 'MDF_ALLOCATION_LOCKED', allocationId: 'A-1' }, { code: 'MDF_STAGE_CONFLICT' }],
    };
    const display = describeCompositionPreview(preview, detailsBefore);
    expect(display.status).toBe('blocked');
    expect(display.hasChanges).toBe(false);
    expect(display.assignmentLines).toEqual([]);
    expect(display.retainedLines).toEqual([]);
    expect(display.preservedLines).toEqual([]);
    expect(display.blockerLines).toHaveLength(2);
    expect(display.blockerLines[0]).toContain('MDF_ALLOCATION_LOCKED');
    expect(display.blockerLines[0]).toContain('A-1');
    expect(display.blockerLines[1]).toBe('MDF_STAGE_CONFLICT');
  });

  it('renders a ready preview, enriching assignment lines with names when the row is known', () => {
    const preview: BazisCutCompositionPreviewResponse = {
      status: 'ready', beforeVersion: '3', previewDigest: 'a'.repeat(64),
      assignmentChanges: [
        { rowId: '1', orderId: '77', detailId: '901', before: 10, after: 8 },
        { rowId: '2', orderId: '78', detailId: '902', before: 4, after: 0 },
        { rowId: '9', orderId: '79', detailId: '903', before: 0, after: 2 },
      ],
      retainedPhysical: [
        { orderId: 77, detailId: 901, quantity: 6, stage: 'cut', rework: false },
        { orderId: 78, detailId: 902, quantity: 2, stage: 'laminated', rework: true },
      ],
      preservedAllocations: [
        { allocationId: 'A-1', bathId: 'B-9', bathRevision: '2', orderId: 77, detailId: 901, quantity: 3, state: 'reserved' },
      ],
      blockers: [],
    };
    const display = describeCompositionPreview(preview, detailsBefore);
    expect(display.status).toBe('ready');
    expect(display.hasChanges).toBe(true);
    expect(display.blockerLines).toEqual([]);
    expect(display.assignmentLines).toHaveLength(3);
    expect(display.assignmentLines[0]).toContain('ERP-1491');
    expect(display.assignmentLines[0]).toContain('К1_Цоколь');
    expect(display.assignmentLines[0]).toContain('10 → 8');
    expect(display.assignmentLines[1]).toContain('ERP-1492');
    expect(display.assignmentLines[2]).toContain('№79');
    expect(display.assignmentLines[2]).toContain('№903');
    expect(display.retainedLines[0]).toContain('Распил');
    expect(display.retainedLines[0]).toContain('6 шт.');
    expect(display.retainedLines[1]).toContain('Ламинирование');
    expect(display.retainedLines[1]).toContain('переделка');
    expect(display.preservedLines[0]).toContain('B-9');
    expect(display.preservedLines[0]).toContain('зарезервировано');
  });

  it('marks an unchanged, no-op preview as having no changes even without assignment lines', () => {
    const preview: BazisCutCompositionPreviewResponse = {
      status: 'unchanged', beforeVersion: '3', previewDigest: 'b'.repeat(64),
      assignmentChanges: [], retainedPhysical: [], preservedAllocations: [], blockers: [],
    };
    const display = describeCompositionPreview(preview);
    expect(display.status).toBe('unchanged');
    expect(display.hasChanges).toBe(false);
  });

  it('falls back to bare order/detail ids when the row is not in the supplied details', () => {
    const preview: BazisCutCompositionPreviewResponse = {
      status: 'ready', beforeVersion: '1', previewDigest: 'c'.repeat(64),
      assignmentChanges: [{ rowId: '404', orderId: '55', detailId: '606', before: 2, after: 1 }],
      retainedPhysical: [], preservedAllocations: [], blockers: [],
    };
    const display = describeCompositionPreview(preview);
    expect(display.assignmentLines[0]).toContain('№55');
    expect(display.assignmentLines[0]).toContain('№606');
  });
});

describe('generateCompositionIdempotencyKey', () => {
  it('always uses the bazis-composition prefix and the backend-required charset', () => {
    for (let i = 0; i < 20; i += 1) {
      const key = generateCompositionIdempotencyKey();
      expect(key.startsWith('bazis-composition:')).toBe(true);
      expect(key.length).toBeGreaterThanOrEqual(8);
      expect(key.length).toBeLessThanOrEqual(200);
      expect(/^[A-Za-z0-9._:-]{1,128}$/.test(key)).toBe(true);
    }
  });

  it('generates distinct keys on repeated calls', () => {
    const keys = new Set(Array.from({ length: 10 }, () => generateCompositionIdempotencyKey()));
    expect(keys.size).toBe(10);
  });
});

describe('CompositionCommandBuilder', () => {
  function readyResponse(digest: string): BazisCutCompositionPreviewResponse {
    return {
      status: 'ready', beforeVersion: '1', previewDigest: digest,
      assignmentChanges: [], retainedPhysical: [], preservedAllocations: [], blockers: [],
    };
  }
  function blockedResponse(): BazisCutCompositionPreviewResponse {
    return {
      status: 'blocked', beforeVersion: '1', previewDigest: null,
      assignmentChanges: [], retainedPhysical: [], preservedAllocations: [],
      blockers: [{ code: 'X' }],
    };
  }

  it('is not confirmable before any preview is registered', () => {
    const builder = new CompositionCommandBuilder();
    expect(builder.confirmable).toBe(false);
    expect(() => builder.buildConfirmRequest()).toThrow();
  });

  it('becomes confirmable after a ready preview and carries the digest into the confirm request', () => {
    const builder = new CompositionCommandBuilder();
    const generation = builder.beginAttempt();
    const previewRequest = builder.buildPreviewRequest('3', 'a'.repeat(64), [{ rowId: '1', quantity: 5 }]);
    expect(builder.registerPreview(generation, previewRequest, readyResponse('d'.repeat(64)))).toBe(true);
    expect(builder.confirmable).toBe(true);
    const { request } = builder.buildConfirmRequest();
    expect(request).toMatchObject({ expectedVersion: '3', sourceToken: 'a'.repeat(64), expectedDigest: 'd'.repeat(64) });
  });

  it('stays non-confirmable after a blocked preview', () => {
    const builder = new CompositionCommandBuilder();
    const generation = builder.beginAttempt();
    const previewRequest = builder.buildPreviewRequest('3', 'a'.repeat(64), []);
    builder.registerPreview(generation, previewRequest, blockedResponse());
    expect(builder.confirmable).toBe(false);
    expect(() => builder.buildConfirmRequest()).toThrow();
  });

  it('reuses the SAME idempotency key across repeated confirm-request builds for one preview', () => {
    const builder = new CompositionCommandBuilder();
    const generation = builder.beginAttempt();
    const previewRequest = builder.buildPreviewRequest('3', 'a'.repeat(64), []);
    builder.registerPreview(generation, previewRequest, readyResponse('d'.repeat(64)));
    const first = builder.buildConfirmRequest();
    const second = builder.buildConfirmRequest();
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it('generates a NEW idempotency key only after a fresh preview is registered', () => {
    const builder = new CompositionCommandBuilder();
    const firstGeneration = builder.beginAttempt();
    const firstPreviewRequest = builder.buildPreviewRequest('3', 'a'.repeat(64), []);
    builder.registerPreview(firstGeneration, firstPreviewRequest, readyResponse('d'.repeat(64)));
    const beforeRefresh = builder.buildConfirmRequest().idempotencyKey;

    const secondGeneration = builder.beginAttempt();
    const secondPreviewRequest = builder.buildPreviewRequest('4', 'a'.repeat(64), []);
    builder.registerPreview(secondGeneration, secondPreviewRequest, readyResponse('e'.repeat(64)));
    const afterRefresh = builder.buildConfirmRequest().idempotencyKey;

    expect(afterRefresh).not.toBe(beforeRefresh);
  });

  it('reset() clears confirmability and forces a fresh preview before confirming again', () => {
    const builder = new CompositionCommandBuilder();
    const generation = builder.beginAttempt();
    const previewRequest = builder.buildPreviewRequest('3', 'a'.repeat(64), []);
    builder.registerPreview(generation, previewRequest, readyResponse('d'.repeat(64)));
    builder.reset();
    expect(builder.confirmable).toBe(false);
    expect(() => builder.buildConfirmRequest()).toThrow();
  });

  describe('generation-guarded stale completions (the reported defect)', () => {
    it('ignores a late response from a superseded attempt (open A, cancel, open B, A resolves late)', () => {
      const builder = new CompositionCommandBuilder();

      // Open deletion A.
      const generationA = builder.reset();
      const requestA = builder.buildPreviewRequest('3', 'a'.repeat(64), [{ rowId: '1', quantity: 0 }]);
      // (A's HTTP call is now "in flight" — nothing registered yet.)

      // Cancel, then open deletion B before A's response arrives.
      builder.invalidate();
      const generationB = builder.reset();
      const requestB = builder.buildPreviewRequest('3', 'a'.repeat(64), [{ rowId: '2', quantity: 0 }]);
      expect(builder.registerPreview(generationB, requestB, readyResponse('b'.repeat(64)))).toBe(true);
      expect(builder.confirmable).toBe(true);

      // A's late response now arrives and MUST be ignored — it must not overwrite B.
      expect(builder.registerPreview(generationA, requestA, readyResponse('a'.repeat(64)))).toBe(false);
      expect(builder.confirmable).toBe(true);
      const { request } = builder.buildConfirmRequest();
      expect(request).toMatchObject({ expectedDigest: 'b'.repeat(64), desiredRows: [{ rowId: '2', quantity: 0 }] });
    });

    it('confirm always uses the request that produced the CURRENTLY registered preview, never a stale one', () => {
      const builder = new CompositionCommandBuilder();
      const generationA = builder.reset();
      const requestA = builder.buildPreviewRequest('3', 'a'.repeat(64), [{ rowId: '1', quantity: 3 }]);
      builder.registerPreview(generationA, requestA, readyResponse('a'.repeat(64)));

      const generationB = builder.reset();
      const requestB = builder.buildPreviewRequest('4', 'a'.repeat(64), [{ rowId: '2', quantity: 5 }]);
      builder.registerPreview(generationB, requestB, readyResponse('b'.repeat(64)));

      const { request, generation } = builder.buildConfirmRequest();
      expect(request).toMatchObject({ expectedVersion: '4', expectedDigest: 'b'.repeat(64), desiredRows: [{ rowId: '2', quantity: 5 }] });
      expect(generation).toBe(generationB);
      expect(builder.isCurrentAttempt(generationA)).toBe(false);
      expect(builder.isCurrentAttempt(generationB)).toBe(true);
    });

    it('invalidate() makes the in-flight generation stale without touching registered state', () => {
      const builder = new CompositionCommandBuilder();
      const generation = builder.beginAttempt();
      const previewRequest = builder.buildPreviewRequest('3', 'a'.repeat(64), []);
      builder.registerPreview(generation, previewRequest, readyResponse('d'.repeat(64)));
      expect(builder.confirmable).toBe(true);

      builder.invalidate();
      expect(builder.confirmable).toBe(true); // registered state untouched
      expect(builder.isCurrentAttempt(generation)).toBe(false); // but the attempt itself is now stale
      expect(builder.registerPreview(generation, previewRequest, readyResponse('e'.repeat(64)))).toBe(false);
    });
  });
});

describe('mergeSetAfterMutation', () => {
  function cardDto(overrides: Partial<BazisCutSetCardDto> = {}): BazisCutSetCardDto {
    return {
      bazisCutSetId: 42, name: '1491', version: 1, createdBy: 1, updatedBy: 1,
      createdAt: '2026-07-15T10:00:00.000Z', updatedAt: '2026-07-15T10:00:00.000Z',
      positionCount: 0, quantity: 0, totalAreaM2: 0,
      orders: [], projects: [], bazisProjects: [], bazisOrders: [], details: [],
      ...overrides,
    };
  }

  it('passes the mutation result through unchanged when it already carries mdfComposition', () => {
    const previous = cardDto({ mdfComposition: { available: true, sourceToken: 'a'.repeat(64), reason: null, eligibleRowIds: ['1'] } });
    const mutated = cardDto({ name: 'Renamed', mdfComposition: { available: true, sourceToken: 'b'.repeat(64), reason: null, eligibleRowIds: ['1', '2'] } });
    expect(mergeSetAfterMutation(previous, mutated)).toEqual(mutated);
  });

  it('passes the mutation result through unchanged when composition mode was never active', () => {
    const previous = cardDto();
    const mutated = cardDto({ name: 'Renamed' });
    expect(mergeSetAfterMutation(previous, mutated)).toEqual(mutated);
  });

  it('passes the mutation result through unchanged when there is no previous set to preserve from', () => {
    const mutated = cardDto({ name: 'Renamed' });
    expect(mergeSetAfterMutation(null, mutated)).toEqual(mutated);
  });

  it('synthesizes a disabled mdfComposition (never absent) when the mutation dropped it but composition mode was active', () => {
    const previous = cardDto({ mdfComposition: { available: true, sourceToken: 'a'.repeat(64), reason: null, eligibleRowIds: ['1', '2'] } });
    const mutated = cardDto({ name: 'Renamed' }); // mutation response: no mdfComposition field at all
    const merged = mergeSetAfterMutation(previous, mutated);
    expect(merged.name).toBe('Renamed');
    expect(merged.mdfComposition).toBeDefined();
    expect(merged.mdfComposition?.available).toBe(false);
  });
});

describe('needsCompositionReload', () => {
  it('is true only when composition mode was active before and the mutation response omitted mdfComposition', () => {
    const withComposition = { mdfComposition: { available: true, sourceToken: 'a'.repeat(64), reason: null, eligibleRowIds: [] } } as unknown as BazisCutSetCardDto;
    const withoutComposition = {} as BazisCutSetCardDto;
    expect(needsCompositionReload(withComposition, withoutComposition)).toBe(true);
    expect(needsCompositionReload(withoutComposition, withoutComposition)).toBe(false);
    expect(needsCompositionReload(withComposition, withComposition)).toBe(false);
    expect(needsCompositionReload(null, withoutComposition)).toBe(false);
  });
});
