/**
 * TDD: Task 9 — FE consumes shared geometry module.
 *
 * Covers:
 *  - snapDraggedPiece, rotatePiece, validateSheetPlacements (re-exports from @shared/cut-geometry)
 *  - movesFromSheets (FE-only adapter)
 *  - Golden parity: same fixture as the backend golden test
 *  - Source guard: cutLayoutGeometry.ts contains no geometry math literals
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  snapDraggedPiece,
  rotatePiece,
  validateSheetPlacements,
  movesFromSheets,
  moveAllowed,
} from './cutLayoutGeometry';
import type { SheetPlacements } from '../../api/types/cutApi.types';
import type { GeomSheet } from '@shared/cut-geometry';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Legal sheet fixture ───────────────────────────────────────────────────────

const legalSheet: GeomSheet = {
  sheet_width_mm: 2800,
  sheet_height_mm: 2070,
  trim_mm: { left: 10, right: 10, top: 10, bottom: 10 },
  pieces: [
    { item_id: 'det-1', instance: 1, x_mm: 0, y_mm: 0, width_mm: 600, height_mm: 400, rotated: false },
    { item_id: 'det-2', instance: 1, x_mm: 603, y_mm: 0, width_mm: 600, height_mm: 400, rotated: false },
  ],
};

// ── snapDraggedPiece ──────────────────────────────────────────────────────────

describe('snapDraggedPiece', () => {
  it('snaps left edge to the usable left when within threshold', () => {
    // x=3, candidate=0, distance=3 ≤ threshold=8 → snaps to 0
    const out = snapDraggedPiece({
      rect: { x: 3, y: 100, w: 600, h: 400 },
      others: [],
      usableW: 2780,
      usableH: 2050,
      gapMm: 3,
      thresholdMm: 8,
    });
    expect(out.x).toBe(0);
  });

  it('snaps to a neighbour right edge at +gap', () => {
    // x=607, neighbour ends at 600, candidate = 600+gap=603, distance=|607-603|=4 ≤ 8 → snaps to 603
    const out = snapDraggedPiece({
      rect: { x: 607, y: 0, w: 600, h: 400 },
      others: [{ x: 0, y: 0, w: 600, h: 400 }],
      usableW: 2780,
      usableH: 2050,
      gapMm: 3,
      thresholdMm: 8,
    });
    expect(out.x).toBe(603); // 600 + gap 3
  });

  it('does not snap when no candidate within threshold', () => {
    // x=900, nearest candidate (left edge 0) is 900mm away, exceeds threshold=8
    const out = snapDraggedPiece({
      rect: { x: 900, y: 900, w: 100, h: 100 },
      others: [],
      usableW: 2780,
      usableH: 2050,
      gapMm: 3,
      thresholdMm: 8,
    });
    expect(out).toEqual({ x: 900, y: 900, guideX: null, guideY: null });
  });
});

// ── rotatePiece ───────────────────────────────────────────────────────────────

describe('rotatePiece', () => {
  it('swaps width/height and flips rotated', () => {
    const r = rotatePiece({
      item_id: 'det-1',
      instance: 1,
      x_mm: 0,
      y_mm: 0,
      width_mm: 600,
      height_mm: 400,
      rotated: false,
    });
    expect([r.width_mm, r.height_mm, r.rotated]).toEqual([400, 600, true]);
  });

  it('double rotation restores original piece', () => {
    const piece = {
      item_id: 'det-2',
      instance: 1,
      x_mm: 10,
      y_mm: 20,
      width_mm: 300,
      height_mm: 200,
      rotated: true,
    };
    expect(rotatePiece(rotatePiece(piece))).toEqual(piece);
  });
});

// ── validateSheetPlacements ───────────────────────────────────────────────────

describe('validateSheetPlacements', () => {
  it('returns empty for a legal layout', () => {
    expect(
      validateSheetPlacements({
        sheetIndex: 0,
        placements: legalSheet,
        gap: { kerfMm: 2, spacingMm: 1 },
        filmTextureByItemId: new Map(),
      }),
    ).toEqual([]);
  });
});

// ── movesFromSheets ───────────────────────────────────────────────────────────

describe('movesFromSheets', () => {
  it('maps placements to CutManualMove array preserving all fields', () => {
    const sheets: { sheetIndex: number; placements: SheetPlacements }[] = [
      {
        sheetIndex: 0,
        placements: {
          trim_mm: { left: 10, right: 10, top: 10, bottom: 10 },
          sheet_width_mm: 2800,
          sheet_height_mm: 2070,
          pieces: [
            { item_id: 'det-1', instance: 1, x_mm: 0, y_mm: 0, width_mm: 600, height_mm: 400, rotated: false },
          ],
        },
      },
      {
        sheetIndex: 1,
        placements: {
          trim_mm: { left: 10, right: 10, top: 10, bottom: 10 },
          sheet_width_mm: 2800,
          sheet_height_mm: 2070,
          pieces: [
            { item_id: 'det-2', instance: 1, x_mm: 100, y_mm: 50, width_mm: 300, height_mm: 200, rotated: true },
          ],
        },
      },
    ];

    const moves = movesFromSheets(sheets);
    expect(moves).toEqual([
      { itemId: 'det-1', instance: 1, sheetIndex: 0, xMm: 0, yMm: 0, rotated: false },
      { itemId: 'det-2', instance: 1, sheetIndex: 1, xMm: 100, yMm: 50, rotated: true },
    ]);
  });

  it('returns empty array when all sheets have no pieces', () => {
    const moves = movesFromSheets([
      {
        sheetIndex: 0,
        placements: {
          trim_mm: { left: 10, right: 10, top: 10, bottom: 10 },
          sheet_width_mm: 2800,
          sheet_height_mm: 2070,
          pieces: [],
        },
      },
    ]);
    expect(moves).toEqual([]);
  });

  it('flattens pieces across multiple sheets into a single moves array', () => {
    const sheets: { sheetIndex: number; placements: SheetPlacements }[] = [
      {
        sheetIndex: 5,
        placements: {
          trim_mm: { left: 10, right: 10, top: 10, bottom: 10 },
          sheet_width_mm: 2800,
          sheet_height_mm: 2070,
          pieces: [
            { item_id: 'det-1', instance: 1, x_mm: 0, y_mm: 0, width_mm: 600, height_mm: 400, rotated: false },
            { item_id: 'det-1', instance: 2, x_mm: 0, y_mm: 410, width_mm: 600, height_mm: 400, rotated: false },
          ],
        },
      },
    ];
    const moves = movesFromSheets(sheets);
    expect(moves).toHaveLength(2);
    expect(moves[0].sheetIndex).toBe(5);
    expect(moves[1].sheetIndex).toBe(5);
    expect(moves[1].instance).toBe(2);
  });
});

// ── Golden parity (FE/BE) ─────────────────────────────────────────────────────
// Loads the same JSON fixture the backend golden test asserts, verifying the
// shared module behaves identically when imported through the FE (Vite) build path.

type GoldenCase = Record<string, unknown>;

const goldenPath = resolve(
  __dirname,
  '../../../backend/src/modules/cut/application/__fixtures__/cut-layout-golden.json',
);
const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as GoldenCase[];

describe('golden FE/BE parity', () => {
  it.each(golden.filter((c) => c.kind === 'validate'))('golden FE validate: $name', (c) => {
    const input = c.input as {
      placements: GeomSheet;
      gap: { kerfMm: number; spacingMm: number };
      filmTexture?: Record<string, boolean>;
    };
    const v = validateSheetPlacements({
      sheetIndex: 0,
      placements: input.placements,
      gap: input.gap,
      filmTextureByItemId: new Map(Object.entries(input.filmTexture ?? {})),
    });
    expect(v.map((x) => x.code).sort()).toEqual([...(c.expected as string[])].sort());
  });

  it.each(golden.filter((c) => c.kind === 'snap'))('golden snap: $name', (c) => {
    const input = c.input as Parameters<typeof snapDraggedPiece>[0];
    expect(snapDraggedPiece(input)).toEqual(c.expected);
  });
});

// ── moveAllowed re-export ─────────────────────────────────────────────────────

describe('moveAllowed re-export', () => {
  it('re-exports moveAllowed as a function', () => {
    expect(typeof moveAllowed).toBe('function');
  });
});

// ── Source guard ──────────────────────────────────────────────────────────────
// cutLayoutGeometry.ts must be imports-only + movesFromSheets — no ported geometry.

describe('cutLayoutGeometry source guard', () => {
  it('contains no geometry math literals (imports-only + movesFromSheets mapping)', () => {
    const src = readFileSync(resolve(__dirname, './cutLayoutGeometry.ts'), 'utf8');
    // Must NOT contain any Math.* calls (those live in the shared module, not here)
    expect(src).not.toMatch(/Math\.(abs|max|min|floor|ceil|round|sqrt|PI)/);
    // Must NOT contain coordinate-space arithmetic like sheetH - (
    expect(src).not.toMatch(/sheetH\s*-\s*\(/);
    expect(src).not.toMatch(/sheetW\s*-\s*\(/);
    // Must NOT compute usable extents inline
    expect(src).not.toMatch(/usableW\s*=/);
    expect(src).not.toMatch(/usableH\s*=/);
  });
});
