import { describe, expect, it } from 'vitest';
import { moveAllowed } from './cutLayoutGeometry';
import { buildPieceMetaByItemId } from './cutPieceMeta';

const items = [
  { orderDetailId: 1, detail: { sheetMaterialTypeId: 9, filmId: 3 } },
  { orderDetailId: 2, detail: { sheetMaterialTypeId: 12, filmId: null } },
  { orderDetailId: 3, detail: null },
];

describe('buildPieceMetaByItemId', () => {
  it('uses the detail own sheet type when the job has no sheet override', () => {
    const m = buildPieceMetaByItemId(items, null);
    expect(m.get('det-1')).toEqual({ materialTypeId: 9, filmId: 3 });
    expect(m.get('det-2')).toEqual({ materialTypeId: 12, filmId: null });
    expect(m.get('det-3')).toEqual({ materialTypeId: null, filmId: null });
  });

  it('sheet override becomes the effective material for EVERY piece (migr 040 semantics)', () => {
    const m = buildPieceMetaByItemId(items, 55);
    expect(m.get('det-1')?.materialTypeId).toBe(55);
    expect(m.get('det-2')?.materialTypeId).toBe(55);
    expect(m.get('det-3')?.materialTypeId).toBe(55);
    // films stay the detail's own — the film rule is not override-related
    expect(m.get('det-1')?.filmId).toBe(3);
  });

  it('override job: cross-sheet move passes the material rule of moveAllowed (the original bug)', () => {
    // Group on an override job carries the override id; before the fix the
    // piece meta carried the detail's own type (9) and every move was vetoed.
    const meta = buildPieceMetaByItemId(items, 55).get('det-1')!;
    const verdict = moveAllowed({
      pieceMaterialTypeId: meta.materialTypeId,
      pieceFilmId: meta.filmId,
      targetMaterialTypeId: 55,
      targetFilmId: meta.filmId,
      splitByMaterial: true,
      combineFilms: true,
    });
    expect(verdict).toEqual({ ok: true });
  });

  it('no-override job keeps the material veto for a foreign-material target', () => {
    const meta = buildPieceMetaByItemId(items, null).get('det-1')!;
    const verdict = moveAllowed({
      pieceMaterialTypeId: meta.materialTypeId,
      pieceFilmId: meta.filmId,
      targetMaterialTypeId: 12,
      targetFilmId: meta.filmId,
      splitByMaterial: true,
      combineFilms: true,
    });
    expect(verdict).toEqual({ ok: false, reason: 'material' });
  });

  it('vacuum all-details group: split off keeps cross-sheet move allowed even when group film is null', () => {
    const meta = buildPieceMetaByItemId([
      { orderDetailId: 2709, detail: { sheetMaterialTypeId: 13, filmId: 4108 } },
    ], 13).get('det-2709')!;
    const verdict = moveAllowed({
      pieceMaterialTypeId: meta.materialTypeId,
      pieceFilmId: meta.filmId,
      targetMaterialTypeId: 13,
      targetFilmId: null,
      splitByMaterial: false,
      combineFilms: false,
    });
    expect(verdict).toEqual({ ok: true });
  });
});
