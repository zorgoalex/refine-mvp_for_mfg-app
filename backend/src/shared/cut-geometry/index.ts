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
  rotation_forbidden?: boolean;
  label?: PieceLabelSnapshot;
}

/** Full sheet geometry descriptor (mirrors SheetPlacementsJson shape). */
export interface GeomSheet {
  coordinate_contract?: 'native_portrait_v1';
  trim_mm: { left: number; right: number; top: number; bottom: number };
  sheet_width_mm: number;
  sheet_height_mm: number;
  pieces: GeomPiece[];
}

export function validateSheetGroupInvariant(
  sheets: ReadonlyArray<{ placements: Pick<GeomSheet, 'sheet_width_mm' | 'sheet_height_mm' | 'coordinate_contract'> }>,
): 'mixed_dimensions' | 'mixed_coordinate_contract' | null {
  const first = sheets[0]?.placements;
  if (!first) return null;
  for (const { placements } of sheets.slice(1)) {
    if (placements.sheet_width_mm !== first.sheet_width_mm || placements.sheet_height_mm !== first.sheet_height_mm) {
      return 'mixed_dimensions';
    }
    if (placements.coordinate_contract !== first.coordinate_contract) return 'mixed_coordinate_contract';
  }
  return null;
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

/** Physical film-length reference marks used by 2800 mm vacuum baths. */
export const BATH_METER_GUIDE_OFFSETS_MM = [800, 1800] as const;
export const BATH_METER_GUIDE_SHEET_HEIGHT_MM = 2800;
export const BATH_FILM_USAGE_ZONES = [
  { maxOccupiedMm: 800, linearMeters: 1.1 },
  { maxOccupiedMm: 1800, linearMeters: 2.1 },
  { maxOccupiedMm: 2800, linearMeters: 3.1 },
] as const;
export const BATH_METER_GUIDE_STYLE = {
  stroke: '#536273',
  strokeOpacity: 0.28,
  strokeWidthMm: 3,
  dashMm: 18,
  gapMm: 14,
  labelFill: '#ff6a00',
  labelFontRatio: 1,
  labelFontWeight: 700,
} as const;
export const BATH_METER_GUIDE_OUTSIDE_TOP_GUTTER_RATIO = 1.6;
export const BATH_METER_GUIDE_OUTSIDE_LEFT_GUTTER_RATIO = 4.2;

export interface BathMeterGuideEligibility {
  /** Effective layout mode from frozen calculation params. */
  layoutMode?: unknown;
  /** Effective engine stored in cut_group.summary. */
  engineUsed?: unknown;
  materialName?: unknown;
  materialWidthMm?: unknown;
  materialHeightMm?: unknown;
}

/**
 * A catalog row represents a vacuum bath only when all three stable facts
 * agree: vacuum calculation, a name beginning with «Ванна», and catalog
 * long side 2800 mm. Name/dimensions alone must not decorate ordinary sheets.
 */
export function shouldShowBathMeterGuides(input: BathMeterGuideEligibility): boolean {
  const vacuumLayout = input.layoutMode === 'vacuum_table' || input.engineUsed === 'vacuum_table';
  const name = typeof input.materialName === 'string'
    ? input.materialName.normalize('NFKC').trimStart().toLocaleLowerCase('ru-RU')
    : '';
  const width = mmOrNaN(input.materialWidthMm);
  const height = mmOrNaN(input.materialHeightMm);
  const dimensions = [width, height].filter(Number.isFinite);
  const longSide = dimensions.length > 0 ? Math.max(...dimensions) : Number.NaN;
  return vacuumLayout
    && name.startsWith('ванна')
    && longSide === BATH_METER_GUIDE_SHEET_HEIGHT_MM;
}

export interface BathMeterGuideLine {
  offsetMm: (typeof BATH_METER_GUIDE_OFFSETS_MM)[number];
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface BathMeterGuideLabel {
  x: number;
  y: number;
  text: string;
  textAnchor: 'middle' | 'end';
}

/**
 * The orange meter label matches the base font used for bath
 * dimension annotations. Keeping the calculation here makes SVG, raster/PDF
 * and the manual editor use one typography contract.
 */
export function bathMeterGuideLabelFontMm(
  sheetWidthMm: number,
  sheetHeightMm: number,
  labelFontMm?: number,
): number {
  const fallbackLabelFontMm = Math.max(24, Math.round(Math.min(sheetWidthMm, sheetHeightMm) / 42));
  const bathDimensionFontMm = Math.max(18, Math.round((labelFontMm ?? fallbackLabelFontMm) * 0.85));
  return bathDimensionFontMm * BATH_METER_GUIDE_STYLE.labelFontRatio;
}

/** Position every label outside the sheet: vertical guides above it and
 * horizontal guides to its left. */
export function bathMeterGuideLabel(
  line: BathMeterGuideLine,
  fontSizeMm: number,
): BathMeterGuideLabel {
  const vertical = line.x1 === line.x2;
  return vertical
    ? {
        x: line.x1,
        y: -fontSizeMm * BATH_METER_GUIDE_OUTSIDE_TOP_GUTTER_RATIO / 2,
        text: `${line.offsetMm}мм`,
        textAnchor: 'middle',
      }
    : {
        x: -fontSizeMm * 0.35,
        y: line.y1,
        text: `${line.offsetMm}мм`,
        textAnchor: 'end',
      };
}

/**
 * Lines are screen-edge based by product contract: from the top in portrait,
 * from the left in landscape. They remain independent from coordinate-origin
 * and dense-cluster preferences, which only reposition cut pieces.
 */
export function bathMeterGuideLines(
  sheetWidthMm: number,
  sheetHeightMm: number,
  landscape: boolean,
): BathMeterGuideLine[] {
  if (
    !Number.isFinite(sheetWidthMm)
    || !Number.isFinite(sheetHeightMm)
    || sheetWidthMm <= 0
    || sheetHeightMm <= 0
  ) {
    return [];
  }
  const nativeLongAxis: 'x' | 'y' = sheetWidthMm > sheetHeightMm ? 'x' : 'y';
  const displayedLongAxis: 'x' | 'y' = landscape
    ? (nativeLongAxis === 'x' ? 'y' : 'x')
    : nativeLongAxis;
  const displayedLongSideMm = displayedLongAxis === 'x'
    ? (landscape ? sheetHeightMm : sheetWidthMm)
    : (landscape ? sheetWidthMm : sheetHeightMm);
  const displayedShortSideMm = displayedLongAxis === 'x'
    ? (landscape ? sheetWidthMm : sheetHeightMm)
    : (landscape ? sheetHeightMm : sheetWidthMm);
  return BATH_METER_GUIDE_OFFSETS_MM
    .filter((offsetMm) => offsetMm > 0 && offsetMm < displayedLongSideMm)
    .map((offsetMm) => displayedLongAxis === 'x'
      ? { offsetMm, x1: offsetMm, y1: 0, x2: offsetMm, y2: displayedShortSideMm }
      : { offsetMm, x1: 0, y1: offsetMm, x2: displayedShortSideMm, y2: offsetMm });
}

export type BathFilmLongSideAxis = 'x' | 'y';

export interface BathSheetFilmUsage {
  linearMeters: number;
  occupiedToMm: number;
  zoneToMm: (typeof BATH_FILM_USAGE_ZONES)[number]['maxOccupiedMm'];
  longSideAxis: BathFilmLongSideAxis;
}

export function calculateBathSheetFilmUsage(
  placements: Pick<GeomSheet, 'sheet_width_mm' | 'sheet_height_mm' | 'trim_mm' | 'pieces'>,
): BathSheetFilmUsage | null {
  const width = mmOrNaN(placements.sheet_width_mm);
  const height = mmOrNaN(placements.sheet_height_mm);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  if (Math.max(width, height) !== BATH_METER_GUIDE_SHEET_HEIGHT_MM) return null;
  if (!Array.isArray(placements.pieces) || placements.pieces.length === 0) return null;

  const longSideAxis: BathFilmLongSideAxis = width > height ? 'x' : 'y';
  const originTrim = longSideAxis === 'x'
    ? mmOrZero(placements.trim_mm?.left)
    : mmOrZero(placements.trim_mm?.top);
  let occupiedToMm = 0;
  for (const piece of placements.pieces) {
    const start = originTrim + (longSideAxis === 'x' ? mmOrZero(piece.x_mm) : mmOrZero(piece.y_mm));
    const length = longSideAxis === 'x' ? mmOrZero(piece.width_mm) : mmOrZero(piece.height_mm);
    occupiedToMm = Math.max(occupiedToMm, start + length);
  }
  if (occupiedToMm <= 0) return null;

  const zone = BATH_FILM_USAGE_ZONES.find((candidate) => occupiedToMm <= candidate.maxOccupiedMm + DEFAULT_EPS)
    ?? BATH_FILM_USAGE_ZONES[BATH_FILM_USAGE_ZONES.length - 1];
  return {
    linearMeters: zone.linearMeters,
    occupiedToMm,
    zoneToMm: zone.maxOccupiedMm,
    longSideAxis,
  };
}

function mmOrNaN(value: unknown): number {
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(n) ? n : Number.NaN;
}

function mmOrZero(value: unknown): number {
  const n = mmOrNaN(value);
  return Number.isFinite(n) ? n : 0;
}

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
 * Returns true when rects a and b are at least gapMm apart, measured as the
 * TRUE minimum (Euclidean) clearance between the two axis-aligned rectangles
 * (0 when they overlap).
 *
 * This is method-agnostic: it flags genuine geometric faults — real overlaps
 * and sub-kerf clearances — for any layout, and never false-flags a valid
 * diagonal arrangement whose corner-to-corner distance already exceeds the
 * gap (a one-axis check would, because each single-axis gap can be below the
 * required clearance while the pieces still cannot collide).
 *
 * dx/dy are the per-axis separations, clamped to >= 0 (a negative raw value
 * means the projections overlap on that axis, contributing 0 distance).
 */
export function piecesClear(a: PieceRect, b: PieceRect, gapMm: number, eps = DEFAULT_EPS): boolean {
  const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), 0);
  const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h), 0);
  const gap = Math.max(0, gapMm);
  return dx * dx + dy * dy >= gap * gap - eps;
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
 *   Portrait (landscape=false): identity, vw=sheetW, vh=sheetH.
 *   Landscape (landscape=true): one of two rotated transforms, both with the same
 *   viewBox dims vw=sheetH, vh=sheetW (only the piece placement differs):
 *     - originTopLeft=false → 90° CW: new x = sheetH-(y+h), new y = x, w↔h swap.
 *       freecut packs its dense cluster at its own (0,0); after 90° CW that
 *       corner lands at the rotated view's TOP-RIGHT.
 *     - originTopLeft=true  → transpose (reflection across the diagonal):
 *       new x = y, new y = x, w↔h swap. freecut's dense (0,0) maps to (0,0) =
 *       the rotated view's TOP-LEFT, matching how an operator loads the sheet
 *       portrait from the top-left. The layout is mirrored left↔right vs the raw
 *       freecut result (physically equivalent for rectangular parts — flip the
 *       sheet). Default false keeps the legacy 90° CW behaviour for every existing
 *       caller. Plan: 2026-06-30-cut-origin-tl-and-profile-parity.
 */
export function orientPieceRect(
  r: { x: number; y: number; w: number; h: number },
  sheetW: number,
  sheetH: number,
  landscape: boolean,
  originTopLeft = false,
): { x: number; y: number; w: number; h: number; vw: number; vh: number } {
  if (landscape) {
    if (originTopLeft) {
      return { x: r.y, y: r.x, w: r.h, h: r.w, vw: sheetH, vh: sheetW };
    }
    return { x: sheetH - (r.y + r.h), y: r.x, w: r.h, h: r.w, vw: sheetH, vh: sheetW };
  }
  return { x: r.x, y: r.y, w: r.w, h: r.h, vw: sheetW, vh: sheetH };
}

export type CutAxisOrigin = 'top-left' | 'bottom-left';

/** Apply the operator-selected Y origin in the final oriented viewBox. */
export function applyAxisOrigin<T extends { x: number; y: number; w: number; h: number; vw: number; vh: number }>(
  rect: T,
  axisOrigin: CutAxisOrigin = 'top-left',
  landscape = false,
): T {
  if (axisOrigin === 'top-left') return rect;
  if (landscape) {
    return { ...rect, x: rect.vw - rect.x - rect.w };
  }
  return { ...rect, y: rect.vh - rect.y - rect.h };
}

/** Undo the final-view X reflection used by a bottom-left landscape view. */
export function undoAxisOriginX(
  orientedX: number,
  orientedWidth: number,
  viewWidth: number,
  axisOrigin: CutAxisOrigin = 'top-left',
  landscape = false,
): number {
  return axisOrigin === 'bottom-left' && landscape
    ? viewWidth - orientedX - orientedWidth
    : orientedX;
}

/** Undo applyAxisOrigin for a final-view top-left coordinate. */
export function undoAxisOriginY(
  orientedY: number,
  orientedHeight: number,
  viewHeight: number,
  axisOrigin: CutAxisOrigin = 'top-left',
  landscape = false,
): number {
  return axisOrigin === 'bottom-left' && !landscape
    ? viewHeight - orientedY - orientedHeight
    : orientedY;
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

/** Result of a snap: snapped x/y plus the guide-line coordinate per axis. */
export interface SnapResult {
  x: number;
  y: number;
  guideX: number | null;
  guideY: number | null;
}

interface SnapCandidate {
  /** Target value for the dragged piece's left (x) / top (y). */
  pos: number;
  /** Coordinate (usable mm) of the dragged edge that lines up — for the guide. */
  guideAt: number;
}

/**
 * Best-effort axis-independent snap for a dragged piece.
 *
 * Per axis, candidates are: sheet edges, neighbour contact (±gap), and
 * neighbour edge alignment (shared left/right or top/bottom line). x and y are
 * snapped independently; corner-to-corner emerges when both axes snap to the
 * same neighbour. Returns the chosen guide coordinate per snapped axis (null
 * when that axis did not snap).
 */
export function snapDraggedPiece(args: {
  rect: PieceRect;
  others: PieceRect[];
  usableW: number;
  usableH: number;
  gapMm: number;
  thresholdMm: number;
}): SnapResult {
  const { rect, others, usableW, usableH, gapMm, thresholdMm } = args;

  const xCandidates: SnapCandidate[] = [
    { pos: 0, guideAt: 0 },
    { pos: usableW - rect.w, guideAt: usableW },
  ];
  const yCandidates: SnapCandidate[] = [
    { pos: 0, guideAt: 0 },
    { pos: usableH - rect.h, guideAt: usableH },
  ];

  for (const o of others) {
    // X: contact (dragged left↔neighbour right+gap, dragged right↔neighbour left−gap)
    xCandidates.push({ pos: o.x + o.w + gapMm, guideAt: o.x + o.w + gapMm });
    xCandidates.push({ pos: o.x - rect.w - gapMm, guideAt: o.x - gapMm });
    // X: alignment (left edges, right edges)
    xCandidates.push({ pos: o.x, guideAt: o.x });
    xCandidates.push({ pos: o.x + o.w - rect.w, guideAt: o.x + o.w });
    // Y: contact
    yCandidates.push({ pos: o.y + o.h + gapMm, guideAt: o.y + o.h + gapMm });
    yCandidates.push({ pos: o.y - rect.h - gapMm, guideAt: o.y - gapMm });
    // Y: alignment
    yCandidates.push({ pos: o.y, guideAt: o.y });
    yCandidates.push({ pos: o.y + o.h - rect.h, guideAt: o.y + o.h });
  }

  const pick = (cands: SnapCandidate[], current: number): { value: number; guide: number | null } => {
    let bestPos = current;
    let bestGuide: number | null = null;
    let bestDist = Infinity;
    for (const c of cands) {
      const d = Math.abs(c.pos - current);
      if (d < bestDist) {
        bestDist = d;
        bestPos = c.pos;
        bestGuide = c.guideAt;
      }
    }
    return bestDist <= thresholdMm ? { value: bestPos, guide: bestGuide } : { value: current, guide: null };
  };

  const sx = pick(xCandidates, rect.x);
  const sy = pick(yCandidates, rect.y);
  return { x: sx.value, y: sy.value, guideX: sx.guide, guideY: sy.guide };
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
  /** Read-path guard: return immediately after the first violation. */
  stopAfterFirst?: boolean;
}): ManualViolation[] {
  const { sheetIndex, placements, gap, filmTextureByItemId, eps = DEFAULT_EPS, stopAfterFirst = false } = args;
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
      if (stopAfterFirst) return out;
    }
    if (p.rotated && filmTextureByItemId.get(p.item_id) === true) {
      out.push({
        sheetIndex,
        itemId: p.item_id,
        instance: p.instance,
        code: 'grain_rotation',
        message: 'Поворот запрещён: текстура плёнки закреплена',
      });
      if (stopAfterFirst) return out;
    }
  }

  // Adaptive axis sweep: use the axis with the wider distribution so both long
  // rows and long columns avoid an unconditional O(n²) read. The break is
  // deliberately conservative (no epsilon): axis clearance >= required gap is
  // sufficient for the exact Euclidean predicate in piecesClear.
  const minX = Math.min(...rects.map(({ r }) => r.x), 0);
  const maxX = Math.max(...rects.map(({ r }) => r.x + r.w), 0);
  const minY = Math.min(...rects.map(({ r }) => r.y), 0);
  const maxY = Math.max(...rects.map(({ r }) => r.y + r.h), 0);
  const sweepX = maxX - minX >= maxY - minY;
  const swept = [...rects].sort((a, b) => (sweepX ? a.r.x - b.r.x : a.r.y - b.r.y));
  const start = ({ r }: (typeof swept)[number]) => sweepX ? r.x : r.y;
  const end = ({ r }: (typeof swept)[number]) => sweepX ? r.x + r.w : r.y + r.h;
  for (let i = 0; i < swept.length; i++) {
    for (let j = i + 1; j < swept.length; j++) {
      if (end(swept[i]) + effGap <= start(swept[j])) break;
      if (!piecesClear(swept[i].r, swept[j].r, effGap, eps)) {
        const p = swept[j].p;
        out.push({
          sheetIndex,
          itemId: p.item_id,
          instance: p.instance,
          code: 'overlap',
          message: 'Недостаточный зазор между деталями (пропил + зазор)',
        });
        if (stopAfterFirst) return out;
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
  rotationForbidden?: boolean;
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
  coordinate_contract?: 'native_portrait_v1';
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
 * - Existing stock sheetIndex values are taken from the auto layout's persisted
 *   sheet_index set (Codex R20 MAJOR #3 — may be sparse/non-zero; NOT a dense
 *   0..N-1 range). A higher operator-created sheetIndex is allowed and uses the
 *   same stock geometry/trim as the group.
 * - Uses authoritative intrinsic dims from autoPieces (swapped when rotated).
 * - Returns surviving non-empty sheets only. Never renumbers surviving sheetIndex
 *   values, including operator-created sheets.
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
  const template = args.autoSheets[0];
  // Authoritative stock = the EXACT persisted sheet_index VALUES of the auto layout
  // (Codex R20 MAJOR #3 — NOT a synthetic dense 0..N-1 range).
  const byIndex = new Map<number, GeomSheet>();
  const buildEmptySheet = (a: AutoSheetSpec): GeomSheet => ({
    ...(a.coordinate_contract ? { coordinate_contract: a.coordinate_contract } : {}),
    trim_mm: args.trim,
    sheet_width_mm: a.sheet_width_mm,
    sheet_height_mm: a.sheet_height_mm,
    pieces: [],
  });
  for (const a of args.autoSheets) {
    byIndex.set(a.sheetIndex, buildEmptySheet(a));
  }
  for (const m of args.moves) {
    if (!Number.isInteger(m.sheetIndex) || m.sheetIndex < 0) {
      return { sheets: [], error: { code: 'foreign_sheet', message: `Недопустимый лист ${m.sheetIndex}` } };
    }
    if (!byIndex.has(m.sheetIndex)) {
      if (!template) {
        return { sheets: [], error: { code: 'foreign_sheet', message: `Недопустимый лист ${m.sheetIndex}` } };
      }
      byIndex.set(m.sheetIndex, buildEmptySheet({ ...template, sheetIndex: m.sheetIndex }));
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
      ...(spec.rotationForbidden !== undefined ? { rotation_forbidden: spec.rotationForbidden } : {}),
      label: spec.label,
    });
  }
  return {
    // Drop sheets that ended up empty (all their pieces were moved to other
    // sheets). Empty sheets are not wanted in a cut group. The REAL sheet_index
    // of the surviving sheets is preserved (no renumber, Codex R14 MAJOR #4);
    // only the emptied indices disappear. `byIndex` was still seeded from the
    // full auto-sheet stock above, so the foreign-sheet guard is unaffected.
    sheets: Array.from(byIndex.entries())
      .filter(([, placements]) => placements.pieces.length > 0)
      .map(([sheetIndex, placements]) => ({ sheetIndex, placements })),
  };
}

export type MoveBlockReason = 'material' | 'film';

/**
 * Guard for moving a piece onto a target sheet. Mirrors the cut grouping rules:
 * splitByMaterial=true groups by material, and with combineFilms=false also by
 * film. splitByMaterial=false uses one all-details group with null material/film
 * group ids, so neither material nor film can be enforced here.
 */
export function moveAllowed(args: {
  pieceMaterialTypeId: number | null;
  pieceFilmId: number | null;
  targetMaterialTypeId: number | null;
  targetFilmId: number | null;
  splitByMaterial: boolean;
  combineFilms: boolean;
}): { ok: true } | { ok: false; reason: MoveBlockReason } {
  if (args.splitByMaterial && args.pieceMaterialTypeId !== args.targetMaterialTypeId) {
    return { ok: false, reason: 'material' };
  }
  if (args.splitByMaterial && !args.combineFilms && args.pieceFilmId !== args.targetFilmId) {
    return { ok: false, reason: 'film' };
  }
  return { ok: true };
}
