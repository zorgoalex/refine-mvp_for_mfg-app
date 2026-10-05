import { describe, expect, it } from 'vitest';
import {
  DECISIONS_FORMAT,
  DECISIONS_VERSION,
  FINGERPRINT_VERSION,
  planReplay,
  stableStringify,
  verifyDecisionsFile,
  withSha,
  type DecisionRow,
  type DecisionsPayload,
} from './catalog-decisions';

const row = (over: Partial<DecisionRow>): DecisionRow => ({
  catalogKey: 'k1', onecRefKey: '6325798a-6fde-11ee-84da-94de808e1036', rowNo: 2,
  nameOriginal: 'Айвори', nameFull: 'Айвори; Алер', supplier: 'Алер', nomenclatureType: 'Запас', unit: 'пог. м',
  nomenclatureCategory: 'ПЛЕНКА ПВХ ДЛЯ МДФ', targetName: 'Айвори; Алер', supplierNorm: 'алер',
  canonicalFilmTexture: false, canonicalFilmTypeId: 1, outcome: 'existing',
  films: [{ filmId: 10, fingerprint: 'fp10', role: 'canonical' }, { filmId: 11, fingerprint: 'fp11', role: 'duplicate' }],
  ...over,
});
const payload = (rows: DecisionRow[]): DecisionsPayload => ({
  format: DECISIONS_FORMAT, version: DECISIONS_VERSION, fingerprintVersion: FINGERPRINT_VERSION,
  sourceBatchId: 3, exportedAt: '2026-09-29T21:00:00.000Z', rows, vendors: [],
});

describe('decisions file integrity', () => {
  it('hashes content independently of key order and rejects tampering', () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    const file = withSha(payload([row({})]));
    expect(() => verifyDecisionsFile(JSON.parse(JSON.stringify(file)))).not.toThrow();
    const tampered = { ...file, rows: [{ ...file.rows[0], targetName: 'Другое' }] };
    expect(() => verifyDecisionsFile(tampered)).toThrow(/sha256/);
  });

  it('rejects an unknown fingerprint version, duplicate rows or films, and rows without exactly one canonical', () => {
    expect(() => verifyDecisionsFile({ ...withSha(payload([row({})])), fingerprintVersion: 2 })).toThrow(/отпечатков/);
    expect(() => verifyDecisionsFile(withSha(payload([row({}), row({})])))).toThrow(/дважды/);
    expect(() => verifyDecisionsFile(withSha(payload([row({}), row({ catalogKey: 'k2', films: [{ filmId: 10, fingerprint: 'x', role: 'canonical' }] })])))).toThrow(/нескольких/);
    expect(() => verifyDecisionsFile(withSha(payload([row({ films: [{ filmId: 10, fingerprint: 'fp10', role: 'duplicate' }] })])))).toThrow(/ровно одна/);
  });
});

describe('strict replay plan', () => {
  const current = new Map([[10, 'fp10'], [11, 'fp11']]);

  it('applies decisions only to films with an unchanged fingerprint', () => {
    const plan = planReplay({ rows: [row({})] }, current, new Set(), new Set());
    expect(plan.rows).toEqual([{ catalogKey: 'k1', status: 'apply', issue: null, canonicalFilmId: 10, films: [{ filmId: 10, role: 'canonical' }, { filmId: 11, role: 'duplicate' }] }]);
    expect(plan.skipped).toEqual([]);
  });

  it('skips a changed duplicate but still applies the row with the canonical', () => {
    const plan = planReplay({ rows: [row({})] }, new Map([[10, 'fp10'], [11, 'edited']]), new Set(), new Set());
    expect(plan.rows[0]).toMatchObject({ status: 'apply', films: [{ filmId: 10, role: 'canonical' }] });
    expect(plan.skipped).toEqual([{ filmId: 11, catalogKey: 'k1', reason: 'changed' }]);
  });

  it('does not apply or create a row whose canonical changed or whose films are gone', () => {
    const lostCanonical = planReplay({ rows: [row({})] }, new Map([[10, 'edited'], [11, 'fp11']]), new Set(), new Set());
    expect(lostCanonical.rows[0]).toMatchObject({ status: 'skipped', films: [], canonicalFilmId: null });
    expect(lostCanonical.skipped.map((s) => s.reason)).toEqual(['changed', 'canonical_skipped']);
    const gone = planReplay({ rows: [row({})] }, new Map(), new Set(), new Set());
    expect(gone.rows[0].status).toBe('skipped');
    expect(gone.skipped.map((s) => s.reason)).toEqual(['missing', 'missing', 'no_films']);
  });

  it('creates a stage-created position only when it does not exist yet (by catalog key or 1C key)', () => {
    const create = row({ outcome: 'create', films: [] });
    expect(planReplay({ rows: [create] }, current, new Set(), new Set()).rows[0].status).toBe('create');
    expect(planReplay({ rows: [create] }, current, new Set(['k1']), new Set()).rows[0].status).toBe('skipped');
    expect(planReplay({ rows: [create] }, current, new Set(), new Set(['6325798a-6fde-11ee-84da-94de808e1036'])).rows[0].status).toBe('skipped');
  });
});
