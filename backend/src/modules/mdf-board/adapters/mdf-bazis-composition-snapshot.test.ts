import { describe, expect, it } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../../database/database.types';
import type { MdfCorrectionAllocation } from '../domain/mdf-correction-plan';
import { deriveMdfBazisRowChanges, loadMdfBazisCompositionRawSnapshot,
  mdfBazisAllocationPinDigest, mdfBazisEligibleRowIdsFromRaw,
  normalizeMdfBazisDesiredRows, type MdfBazisBathHeadPin, type MdfBazisEligibilitySet,
  type MdfBazisRawRow } from './mdf-bazis-composition-snapshot';

const err = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return e as Error; } };

describe('deriveMdfBazisRowChanges', () => {
  it('reports 4+6 to 5+5 as real changes, not a noop', () => {
    const before = [{ rowId: '1', quantity: 4 }, { rowId: '2', quantity: 6 }];
    const after = [{ rowId: '1', quantity: 5 }, { rowId: '2', quantity: 5 }];
    expect(deriveMdfBazisRowChanges(before, after)).toEqual({
      changes: [{ rowId: '1', before: 4, after: 5 }, { rowId: '2', before: 6, after: 5 }], noop: false });
    expect(deriveMdfBazisRowChanges(before, before).noop).toBe(true);
    expect(deriveMdfBazisRowChanges(before, [...after].reverse()).noop).toBe(false);
  });

  it('reports a full removal as explicit zero transitions and never a noop', () => {
    const result = deriveMdfBazisRowChanges([{ rowId: '3', quantity: 2 }, { rowId: '7', quantity: 9 }], []);
    expect(result.noop).toBe(false);
    expect(result.changes).toEqual([{ rowId: '3', before: 2, after: 0 }, { rowId: '7', before: 9, after: 0 }]);
    expect(deriveMdfBazisRowChanges([], [])).toEqual({ changes: [], noop: true });
  });
});

describe('normalizeMdfBazisDesiredRows', () => {
  const eligibility: MdfBazisEligibilitySet = { kind: 'serverResolvedEligibleRowIds', rowIds: ['1', '2', '3'] };
  it('accepts eligible rows and sorts them by exact rowId', () => {
    expect(normalizeMdfBazisDesiredRows({ eligibility, desired: [
      { rowId: '3', quantity: 2 }, { rowId: '1', quantity: 10 }] }))
      .toEqual([{ rowId: '1', quantity: 10 }, { rowId: '3', quantity: 2 }]);
  });
  it.each([
    ['duplicate row IDs', [{ rowId: '1', quantity: 1 }, { rowId: '1', quantity: 2 }]],
    ['zero quantity', [{ rowId: '1', quantity: 0 }]],
    ['fractional quantity', [{ rowId: '1', quantity: 2.5 }]],
    ['unknown row ID', [{ rowId: '9', quantity: 1 }]],
  ] as const)('rejects %s with MDF_BAZIS_DESIRED_INVALID', (_name, desired) => {
    const e = err(() => normalizeMdfBazisDesiredRows({ eligibility, desired }));
    expect(e?.message).toBe('MDF_BAZIS_DESIRED_INVALID');
  });
  it('keeps an empty desired list as a valid intentional empty assignment', () => {
    expect(normalizeMdfBazisDesiredRows({ eligibility, desired: [] })).toEqual([]);
  });
});

describe('mdfBazisAllocationPinDigest', () => {
  const allocation = (patch: Partial<MdfCorrectionAllocation> = {}): MdfCorrectionAllocation => ({
    allocationId: 'a1', evidenceLineId: 'e1', evidenceSourceKind: 'bazisCutSet',
    evidenceSourceId: 'set-1', evidenceRevision: 'r1', bathId: 'cut-result:41',
    bathRevision: 'bath-r1', orderId: 1, detailId: 11, quantity: 4, state: 'consumed', ...patch });
  const head = (patch: Partial<MdfBazisBathHeadPin> = {}): MdfBazisBathHeadPin => ({
    kind: 'bath', id: 'cut-result:41', received: 'bath-r1', accepted: 'bath-r1', epoch: '3', ...patch });
  const digest = (allocations: readonly MdfCorrectionAllocation[], bathHeads: readonly MdfBazisBathHeadPin[]) =>
    mdfBazisAllocationPinDigest({ allocations, bathHeads });
  const base = digest([allocation()], [head()]);

  it('is stable under reordered allocations and bath pins', () => {
    const two = [allocation(), allocation({ allocationId: 'a2', bathId: 'cut-result:42', quantity: 2 })];
    const heads = [head(), head({ id: 'cut-result:42' })];
    expect(digest(two, heads)).toBe(digest([...two].reverse(), [...heads].reverse()));
    expect(base).toBe(digest([allocation()], [head()]));
  });
  it.each([
    ['evidence source kind', [allocation({ evidenceSourceKind: 'packet' })], [head()]],
    ['evidence source identity', [allocation({ evidenceSourceId: 'set-2' })], [head()]],
    ['evidence revision', [allocation({ evidenceRevision: 'r2' })], [head()]],
    ['quantity', [allocation({ quantity: 5 })], [head()]],
    ['state', [allocation({ state: 'reserved' })], [head()]],
    ['bath head revision', [allocation()], [head({ accepted: 'bath-r2' })]],
    ['bath head epoch', [allocation()], [head({ epoch: '4' })]],
  ] as const)('changes with %s', (_name, allocations, bathHeads) => {
    expect(digest(allocations, bathHeads)).not.toBe(base);
  });
  it('excludes released rows from the digest but still identity-checks them', () => {
    expect(digest([allocation({ state: 'released' })], [])).toBe(digest([allocation({ allocationId: 'a2', state: 'released' })], []));
    expect(digest([allocation(), allocation({ allocationId: 'a2', state: 'released' })], [head()])).toBe(base);
  });
  it('rejects a missing or duplicate bath head', () => {
    expect(err(() => digest([allocation()], []))?.message).toBe('MDF_BAZIS_ALLOCATION_PIN_INVALID');
    expect(err(() => digest([allocation()], [head(), head()]))?.message).toBe('MDF_BAZIS_ALLOCATION_PIN_INVALID');
  });
  it('rejects unrelated heads, undefined rows and noncanonical epochs', () => {
    expect(() => digest([allocation()], [head(), head({ id: 'unrelated' })]))
      .toThrow('MDF_BAZIS_ALLOCATION_PIN_INVALID');
    expect(() => digest([undefined as unknown as MdfCorrectionAllocation], []))
      .toThrow('MDF_BAZIS_ALLOCATION_PIN_INVALID');
    expect(() => digest([], [undefined as unknown as MdfBazisBathHeadPin]))
      .toThrow('MDF_BAZIS_ALLOCATION_PIN_INVALID');
    for (const epoch of ['-1', '01', '1.5', 'invalid']) {
      expect(() => digest([allocation()], [head({ epoch })])).toThrow('MDF_BAZIS_ALLOCATION_PIN_INVALID');
    }
  });
});

describe('loadMdfBazisCompositionRawSnapshot', () => {
  const result = <T extends QueryResultRow>(rows: T[]): QueryResult<T> =>
    ({ command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows });
  const fakeClient = (header: Record<string, unknown>, rows: MdfBazisRawRow[]): DatabaseClient => ({
    // This test adapter returns only the two query shapes used by the loader.
    query: async <T extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<T>> =>
      result((text.includes('bazis_cut_sets') ? [{ header }] : rows) as unknown as T[]) });
  const row = (patch: Partial<MdfBazisRawRow> = {}): MdfBazisRawRow => ({
    rowId: '1', orderId: 1, detailId: 11, quantity: 4,
    raw: { bazis_cut_set_detail_id: 1, cut_enabled: true, source_type: 'order_detail',
      material_name: 'МДФ 16 мм' }, ...patch });

  it('preserves an own-property __proto__ payload distinctly from {} in the digest', async () => {
    const protoHeader = { bazis_cut_set_id: 5, ...JSON.parse('{"__proto__":{"x":1}}') } as Record<string, unknown>;
    const plainHeader = { bazis_cut_set_id: 5 };
    const protoSnapshot = await loadMdfBazisCompositionRawSnapshot(fakeClient(protoHeader, [row()]), { setId: 5 });
    const plainSnapshot = await loadMdfBazisCompositionRawSnapshot(fakeClient(plainHeader, [row()]), { setId: 5 });
    expect(protoSnapshot.rawSnapshotDigest).not.toBe(plainSnapshot.rawSnapshotDigest);
    expect(protoSnapshot.rawSnapshotDigest).toBe(
      (await loadMdfBazisCompositionRawSnapshot(fakeClient(protoHeader, [row()]), { setId: 5 })).rawSnapshotDigest);
  });

  it('accepts null linked IDs and excludes HDF rows from eligibility', async () => {
    const snapshot = await loadMdfBazisCompositionRawSnapshot(fakeClient({ bazis_cut_set_id: 5 }, [
      row(),
      row({ rowId: '2', orderId: null, detailId: null, quantity: 3, raw: { bazis_cut_set_detail_id: 2 } }),
      row({ rowId: '3', orderId: 1, detailId: 12, quantity: 2, raw: { bazis_cut_set_detail_id: 3,
        cut_enabled: true, source_type: 'order_detail', material_name: 'ХДФ 3 мм' } }),
      row({ rowId: '4', orderId: 1, detailId: 13, quantity: 2, raw: { bazis_cut_set_detail_id: 4,
        cut_enabled: true, source_type: 'order_detail', material_name: 'МДФ 16 мм', source_order_hdf_detail_id: 77 } }),
    ]), { setId: 5 });
    expect(snapshot.rows.map((r) => r.rowId)).toEqual(['1', '2', '3', '4']);
    expect(mdfBazisEligibleRowIdsFromRaw(snapshot)).toEqual({
      kind: 'serverResolvedEligibleRowIds', rowIds: ['1'] });
  });
  it('rejects undefined linked IDs instead of confusing them with null', async () => {
    const malformed = { ...row(), orderId: undefined } as unknown as MdfBazisRawRow;
    await expect(loadMdfBazisCompositionRawSnapshot(fakeClient({ bazis_cut_set_id: 5 }, [malformed]), { setId: 5 }))
      .rejects.toThrow('MDF_BAZIS_SNAPSHOT_INVALID');
  });
});
