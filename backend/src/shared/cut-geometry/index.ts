/**
 * shared/cut-geometry — dependency-free pure geometry + validation module.
 *
 * Imported by BOTH the NestJS backend and the React/Vite frontend.
 * Must NOT import anything from frontend (src/) or backend (backend/src/).
 * All types are neutral structural types defined here.
 *
 * Codex R2 MAJOR #4, R4 MAJOR #4, R13 MAJOR #3, R22 BLOCKER #2, R24 #3.
 */

// ── Neutral structural types ───────────────────────────────────────────────

/**
 * Snapshot of display label data frozen into the persisted placement.
 * Imported by backend (cut-freecut-mapping.ts) and by the FE editor.
 */
export interface PieceLabelSnapshot {
  orderId: number | null;
  detailNumber: number | null;
  widthMm: number | null;
  heightMm: number | null;
}

/** Per-piece geometry as stored in the sheet placements JSONB. */
export interface GeomPiece {
  item_id: string;
  instance: number;
  x_mm: number;
  y_mm: number;
  width_mm: number;
  height_mm: number;
  rotated: boolean;
  label?: PieceLabelSnapshot;
}

/** Full sheet geometry descriptor (mirrors SheetPlacementsJson shape). */
export interface GeomSheet {
  trim_mm: { left: number; right: number; top: number; bottom: number };
  sheet_width_mm: number;
  sheet_height_mm: number;
  pieces: GeomPiece[];
}

/** Kerf + spacing parameters used for gap validation. */
export interface GapParams {
  kerfMm: number;
  spacingMm: number;
}

/** Axis-aligned bounding box in usable-area coordinates (mm). */
export interface PieceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A validation violation emitted by validateSheetPlacements. */
export type ManualViolation = {
  sheetIndex: number;
  itemId: string;
  instance: number;
  code: 'overlap' | 'off_sheet' | 'grain_rotation';
  message: string;
};

// ── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_EPS = 1e-6;

// ── Core geometry helpers ─────────────────────────────────────────────────

/**
 * Returns the usable (trim-inset) sheet dimensions.
 * Single canonical source so renderers and validators agree.
 */
export function usableExtent(p: {
  sheet_width_mm: number;
  sheet_height_mm: number;
  trim_mm: { left: number; right: number; top: number; bottom: number };
}): { usableW: number; usableH: number } {
  return {
    usableW: p.sheet_width_mm - p.trim_mm.left - p.trim_mm.right,
    usableH: p.sheet_height_mm - p.trim_mm.top - p.trim_mm.bottom,
  };
}

/**
 * Returns true when rects a and b have at least gapMm clearance on at least
 * one axis (i.e. they do not overlap AND respect the required gap).
 *
 * The gap check is one-axis: two rects that are far apart on X are clear
 * regardless of how close they are on Y. This mirrors the freecut behaviour.
 */
export function piecesClear(a: PieceRect, b: PieceRect, gapMm: number, eps = DEFAULT_EPS): boolean {
  const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  return gapX >= gapMm - eps || gapY >= gapMm - eps;
}

/**
 * Returns true when rect r fits entirely within [0, usableW] × [0, usableH].
 */
export function pieceWithinUsable(
  r: PieceRect,
  usableW: number,
  usableH: number,
  eps = DEFAULT_EPS,
): boolean {
  return r.x >= -eps && r.y >= -eps && r.x + r.w <= usableW + eps && r.y + r.h <= usableH + eps;
}

// ── Landscape transform (Codex R4 MAJOR #4) ──────────────────────────────

/**
 * Single canonical landscape/portrait transform used by BOTH the SVG renderer
 * (Task 7 refactor) and the editor overlay (Task 9). Extracted from the inline
 * math in render/sheet-svg.ts and cutPreviewHelpers.ts so the two cannot drift.
 *
 * Coordinates: r is in full-sheet space (trim already added).
 *   Portrait:  identity, vw=sheetW, vh=sheetH.
 *   Landscape: 90° CW rotation — new x = sheetH-(y+h), new y = x, w↔h swap.
 */
export function orientPieceRect(
  r: { x: number; y: number; w: number; h: number },
  sheetW: number,
  sheetH: number,
  landscape: boolean,
): { x: number; y: number; w: number; h: number; vw: number; vh: number } {
  if (landscape) {
    return { x: sheetH - (r.y + r.h), y: r.x, w: r.h, h: r.w, vw: sheetH, vh: sheetW };
  }
  return { x: r.x, y: r.y, w: r.w, h: r.h, vw: sheetW, vh: sheetH };
}

// ── Piece rotation (Codex R22 BLOCKER #2) ────────────────────────────────

/**
 * Returns a new piece with width_mm and height_mm swapped and rotated flipped.
 * Generic over the caller's concrete type (FE: SheetPlacementPiece, BE: FreecutPlacement)
 * — the shared module must not import those types directly.
 *
 * @param piece - any object with at least { width_mm, height_mm, rotated }
 */
export function rotatePiece<T extends { width_mm: number; height_mm: number; rotated: boolean }>(
  piece: T,
): T {
  return { ...piece, width_mm: piece.height_mm, height_mm: piece.width_mm, rotated: !piece.rotated } as T;
}

// ── Drag snap (Codex R13 MAJOR #3) ──────────────────────────────────────

/**
 * Best-effort axis-independent snap for a dragged piece.
 *
 * Independently snaps x and y to the nearest candidate position:
 *   - Sheet edges (0 and usable boundary)
 *   - Left edge of existing pieces minus gap (align right side of dragged piece)
 *   - Right edge of existing pieces plus gap (align left side of dragged piece)
 *   - (Same logic applied on Y axis)
 *
 * Returns the original coordinate unchanged if the nearest candidate is
 * further than thresholdMm away.
 */
export function snapDraggedPiece(args: {
  rect: PieceRect;
  others: PieceRect[];
  usableW: number;
  usableH: number;
  gapMm: number;
  thresholdMm: number;
}): { x: number; y: number } {
  const { rect, others, usableW, usableH, gapMm, thresholdMm } = args;

  // Candidate snapping positions for left edge (x) of the dragged piece
  const xCandidates: number[] = [0, usableW - rect.w];
  // Candidate snapping positions for top edge (y) of the dragged piece
  const yCandidates: number[] = [0, usableH - rect.h];

  for (const o of others) {
    // Snap left edge of dragged piece to: right edge of other + gap
    xCandidates.push(o.x + o.w + gapMm);
    // Snap right edge of dragged piece to: left edge of other - gap
    xCandidates.push(o.x - rect.w - gapMm);
    // Same on Y axis
    yCandidates.push(o.y + o.h + gapMm);
    yCandidates.push(o.y - rect.h - gapMm);
  }

  let bestX = rect.x;
  let bestXDist = Infinity;
  for (const c of xCandidates) {
    const d = Math.abs(c - rect.x);
    if (d < bestXDist) {
      bestXDist = d;
      bestX = c;
    }
  }

  let bestY = rect.y;
  let bestYDist = Infinity;
  for (const c of yCandidates) {
    const d = Math.abs(c - rect.y);
    if (d < bestYDist) {
      bestYDist = d;
      bestY = c;
    }
  }

  return {
    x: bestXDist <= thresholdMm ? bestX : rect.x,
    y: bestYDist <= thresholdMm ? bestY : rect.y,
  };
}

// ── Validation ────────────────────────────────────────────────────────────

/**
 * Validates a single sheet's placements and returns all violations.
 *
 * Checks (in order):
 *  1. off_sheet — piece extends outside the usable area
 *  2. grain_rotation — rotated=true for a film-textured detail
 *  3. overlap — pair of pieces violates kerfMm+spacingMm clearance
 */
export function validateSheetPlacements(args: {
  sheetIndex: number;
  placements: GeomSheet;
  gap: GapParams;
  filmTextureByItemId: Map<string, boolean>;
  eps?: number;
}): ManualViolation[] {
  const { sheetIndex, placements, gap, filmTextureByItemId, eps = DEFAULT_EPS } = args;
  const effGap = gap.kerfMm + gap.spacingMm;
  const { usableW, usableH } = usableExtent(placements);
  const rects = placements.pieces.map((p) => ({
    p,
    r: { x: p.x_mm, y: p.y_mm, w: p.width_mm, h: p.height_mm },
  }));
  const out: ManualViolation[] = [];

  for (const { p, r } of rects) {
    if (!pieceWithinUsable(r, usableW, usableH, eps)) {
      out.push({
        sheetIndex,
        itemId: p.item_id,
        instance: p.instance,
        code: 'off_sheet',
        message: 'Деталь выходит за рабочую область листа',
      });
    }
    if (p.rotated && filmTextureByItemId.get(p.item_id) === true) {
      out.push({
        sheetIndex,
        itemId: p.item_id,
        instance: p.instance,
        code: 'grain_rotation',
        message: 'Поворот запрещён: текстура плёнки закреплена',
      });
    }
  }

  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (!piecesClear(rects[i].r, rects[j].r, effGap, eps)) {
        const p = rects[j].p;
        out.push({
          sheetIndex,
          itemId: p.item_id,
          instance: p.instance,
          code: 'overlap',
          message: 'Недостаточный зазор между деталями (пропил + зазор)',
        });
      }
    }
  }

  return out;
}

// ── Task 2: item-set guard + authoritative reconstruction ─────────────────

/**
 * PieceLabel is structurally identical to PieceLabelSnapshot — alias so the
 * Task-2 API surface uses the documented name without introducing a duplicate shape.
 */
export type PieceLabel = PieceLabelSnapshot;

/** A single client "move" instruction from the manual-layout editor. */
export type ManualMove = {
  itemId: string;
  instance: number;
  sheetIndex: number;
  xMm: number;
  yMm: number;
  rotated: boolean;
};

/**
 * Authoritative descriptor for a piece from the auto layout.
 * baseW/baseH are the UNROTATED intrinsic dimensions.
 * label is the frozen snapshot copied from the auto placement (Codex R8 #1, R10 #1).
 */
export type AutoPieceSpec = {
  itemId: string;
  instance: number;
  baseW: number;
  baseH: number;
  label: PieceLabel;
};

/**
 * Authoritative descriptor for a sheet from the auto layout.
 * sheetIndex is the PERSISTED value (may be sparse/non-zero).
 */
export type AutoSheetSpec = {
  sheetIndex: number;
  sheet_width_mm: number;
  sheet_height_mm: number;
  trim_mm: GeomSheet['trim_mm'];
};

const moveKey = (id: string, inst: number) => `${id}#${inst}`;

/**
 * Returns ok=true iff the multiset of (itemId, instance) in `moves` exactly
 * equals the multiset in `autoPieces` — no added, dropped, or duplicated items.
 */
export function manualSetMatchesAuto(args: {
  moves: ManualMove[];
  autoPieces: AutoPieceSpec[];
}): { ok: boolean; reason?: string } {
  const want = new Set(args.autoPieces.map((p) => moveKey(p.itemId, p.instance)));
  const seen = new Set<string>();
  for (const m of args.moves) {
    const k = moveKey(m.itemId, m.instance);
    if (!want.has(k)) return { ok: false, reason: `Лишняя деталь ${k}` };
    if (seen.has(k)) return { ok: false, reason: `Дубль детали ${k}` };
    seen.add(k);
  }
  if (seen.size !== want.size) return { ok: false, reason: 'Набор деталей не совпадает с расчётным' };
  return { ok: true };
}

/**
 * Rebuilds authoritative sheet placements from the auto layout + client moves.
 *
 * - Rejects any sheetIndex NOT in the auto layout's actual persisted sheet_index
 *   value set (Codex R20 MAJOR #3 — may be sparse/non-zero; NOT a dense 0..N-1 range).
 * - Uses authoritative intrinsic dims from autoPieces (swapped when rotated).
 * - Returns exactly the auto layout's stock sheets (same sheetIndex values), even
 *   empty ones — never renumbers or drops stock sheets (Codex R14 MAJOR #4).
 * - Client width/height values are never read.
 */
export function reconstructManualSheets(args: {
  moves: ManualMove[];
  autoPieces: AutoPieceSpec[];
  autoSheets: AutoSheetSpec[];
  trim: GeomSheet['trim_mm'];
}): {
  sheets: { sheetIndex: number; placements: GeomSheet }[];
  error?: { code: 'foreign_sheet' | 'set_mismatch' | 'grain_unknown'; message: string };
} {
  const specByKey = new Map(args.autoPieces.map((p) => [moveKey(p.itemId, p.instance), p]));
  // Authoritative stock = the EXACT persisted sheet_index VALUES of the auto layout
  // (Codex R20 MAJOR #3 — NOT a synthetic dense 0..N-1 range).
  const byIndex = new Map<number, GeomSheet>();
  for (const a of args.autoSheets) {
    byIndex.set(a.sheetIndex, {
      trim_mm: args.trim,
      sheet_width_mm: a.sheet_width_mm,
      sheet_height_mm: a.sheet_height_mm,
      pieces: [],
    });
  }
  for (const m of args.moves) {
    // Reject any sheetIndex not present in the auto layout's persisted sheet_index set
    // (Codex R20 MAJOR #3 — checked FIRST, before any set-completeness concern).
    if (!byIndex.has(m.sheetIndex)) {
      return { sheets: [], error: { code: 'foreign_sheet', message: `Недопустимый лист ${m.sheetIndex}` } };
    }
    const spec = specByKey.get(moveKey(m.itemId, m.instance));
    if (!spec) {
      return { sheets: [], error: { code: 'set_mismatch', message: `Неизвестная деталь ${moveKey(m.itemId, m.instance)}` } };
    }
    const w = m.rotated ? spec.baseH : spec.baseW;
    const h = m.rotated ? spec.baseW : spec.baseH;
    byIndex.get(m.sheetIndex)!.pieces.push({
      item_id: m.itemId,
      instance: m.instance,
      x_mm: m.xMm,
      y_mm: m.yMm,
      width_mm: w,
      height_mm: h,
      rotated: m.rotated,
      label: spec.label,
    });
  }
  return {
    sheets: Array.from(byIndex.entries()).map(([sheetIndex, placements]) => ({ sheetIndex, placements })),
  };
}
