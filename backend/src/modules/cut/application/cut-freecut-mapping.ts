import { ApiError } from '../../../common/errors/api-error';
import { PieceLabelSnapshot } from '../../../shared/cut-geometry';

/**
 * Freecut request/response mapping (plan §6). One cut_group per cuttable key
 * (sheet_material_type, film) -> one POST /v1/optimize. Includes the film-grain
 * rule, the request builder (include_svg explicitly false in prod), the
 * pre-call guards that keep freecut from rejecting (MAX_INSTANCES / body size),
 * and the placement back-mapper that normalizes solutions into the frozen
 * cut_group_sheet.placements JSONB.
 */
export type FreecutRotation = 'forbid' | 'allow_90';
export type FreecutPatternDirection = 'none' | 'along_width' | 'along_height';

export const ROTATION_VALUES: readonly FreecutRotation[] = ['forbid', 'allow_90'];
export const PATTERN_DIRECTION_VALUES: readonly FreecutPatternDirection[] = [
  'none',
  'along_width',
  'along_height',
];

// Freecut service defaults (docs/API_SPEC.md "Validation Limits").
export const MAX_INSTANCES = 5000;
export const MAX_BODY_BYTES = 5_242_880; // 5 MiB

export interface GrainRule {
  rotation: FreecutRotation;
  pattern_direction: FreecutPatternDirection;
}

const GRAIN_RULE_TEXTURED: GrainRule = { rotation: 'forbid', pattern_direction: 'along_height' };
const GRAIN_RULE_PLAIN: GrainRule = { rotation: 'allow_90', pattern_direction: 'none' };

/** Default configurable grain rule (§6); film_texture=true pins the grain. */
export function grainRuleForFilm(filmTexture: boolean | null | undefined): GrainRule {
  return filmTexture === true ? { ...GRAIN_RULE_TEXTURED } : { ...GRAIN_RULE_PLAIN };
}

/** Write-time enum validation so a misconfigured grain rule never reaches freecut (MINOR-13). */
export function validateGrainRule(rule: { rotation: unknown; pattern_direction: unknown }): GrainRule {
  if (!ROTATION_VALUES.includes(rule.rotation as FreecutRotation)) {
    throw new ApiError(422, 'CUT_INVALID_GRAIN_RULE', 'Invalid grain rotation', {
      field: 'rotation',
      allowed: ROTATION_VALUES,
    });
  }
  if (!PATTERN_DIRECTION_VALUES.includes(rule.pattern_direction as FreecutPatternDirection)) {
    throw new ApiError(422, 'CUT_INVALID_GRAIN_RULE', 'Invalid grain pattern direction', {
      field: 'pattern_direction',
      allowed: PATTERN_DIRECTION_VALUES,
    });
  }
  return { rotation: rule.rotation as FreecutRotation, pattern_direction: rule.pattern_direction as FreecutPatternDirection };
}

export interface FreecutStockInput {
  id: string;
  width_mm: number;
  height_mm: number;
  qty?: number;
}

export interface FreecutItem {
  id: string;
  width_mm: number;
  height_mm: number;
  qty: number;
  rotation: FreecutRotation;
  pattern_direction: FreecutPatternDirection;
}

export interface TrimMm {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface FreecutParams {
  kerf_mm: number;
  spacing_mm: number;
  trim_mm: TrimMm;
  objective: 'min_waste' | 'min_sheets';
  time_limit_ms?: number;
  restarts?: number;
  seed?: number;
  layout_mode?: 'guillotine' | 'nested' | 'vacuum_table';
  vacuum?: { direction?: 'optimal' | 'width' | 'height' };
  /** Quality knobs (freecut API). Set together by the UI "Качество" control. */
  sla_profile?: 'fast' | 'balanced' | 'quality';
  ga_profile?: 'fast' | 'balanced' | 'quality';
  /** Post-process compaction of peripheral part groups (freecut group_shift). */
  group_shift?: {
    enabled?: boolean;
    min_shift_mm?: number;
    max_passes?: number;
    debug_artifacts?: boolean;
  };
  /**
   * Calibrated prod path sends "disabled" (commit dcfa2db): the freecut default
   * "smart" retries on slice timeout and turns near-fill jobs into ~3.3s 408s.
   */
  retry_strategy?: 'disabled' | 'smart';
}

export interface OptimizeRequest {
  units: 'mm';
  params: FreecutParams & { include_svg: boolean };
  stock: Array<Required<Pick<FreecutStockInput, 'id' | 'width_mm' | 'height_mm'>> & { qty: number }>;
  items: FreecutItem[];
}

export interface BuildOptimizeRequestInput {
  stock: FreecutStockInput;
  items: FreecutItem[];
  params: FreecutParams;
  /** DEBUG-only; default false. Freecut defaults include_svg true when omitted. */
  includeSvg?: boolean;
  /** New calculations only: freeze Freecut geometry in portrait stock axes. */
  nativePortrait?: boolean;
}

export const NATIVE_PORTRAIT_COORDINATE_CONTRACT = 'native_portrait_v1' as const;

function transposePatternDirection(direction: FreecutPatternDirection): FreecutPatternDirection {
  if (direction === 'along_width') return 'along_height';
  if (direction === 'along_height') return 'along_width';
  return direction;
}

export function orientOptimizeInputPortrait(input: BuildOptimizeRequestInput): BuildOptimizeRequestInput {
  if (input.nativePortrait !== true || input.stock.width_mm <= input.stock.height_mm) return input;
  return {
    ...input,
    stock: { ...input.stock, width_mm: input.stock.height_mm, height_mm: input.stock.width_mm },
    items: input.items.map((item) => ({
      ...item,
      width_mm: item.height_mm,
      height_mm: item.width_mm,
      pattern_direction: transposePatternDirection(item.pattern_direction),
    })),
    params: {
      ...input.params,
      trim_mm: {
        left: input.params.trim_mm.top,
        right: input.params.trim_mm.bottom,
        top: input.params.trim_mm.left,
        bottom: input.params.trim_mm.right,
      },
    },
  };
}

/**
 * Resolve a vacuum-profile direction (intent relative to the sheet's LONG/SHORT
 * side) to the freecut stock-axis value, which is keyed to the stock's stored
 * width/height fields. Stored 'width' = «по длине/вдоль» = along the LONG side;
 * stored 'height' = «по ширине/поперёк» = along the SHORT side. 'optimal'/undefined
 * pass through unchanged. Makes the layout orientation-independent so a portrait-
 * stored sheet (width<height) is not inverted.
 */
export function resolveVacuumDirection(
  direction: 'optimal' | 'width' | 'height' | undefined,
  stockWidthMm: number,
  stockHeightMm: number,
): 'optimal' | 'width' | 'height' | undefined {
  if (direction !== 'width' && direction !== 'height') return direction;
  const longIsWidth = stockWidthMm >= stockHeightMm;
  // 'width' intent = along the LONG side; 'height' intent = along the SHORT side.
  if (direction === 'width') return longIsWidth ? 'width' : 'height';
  return longIsWidth ? 'height' : 'width';
}

/**
 * Force detail orientation for a directional vacuum profile. 'width' = «по длине»
 * = long edge along the sheet's LONG side; 'height' = «по ширине» = long edge along
 * the SHORT side. Plain details (pattern_direction === 'none') are re-oriented and
 * rotation is forbidden so freecut lays them exactly as chosen instead of rotating
 * for min-waste. Textured details (pattern_direction !== 'none') keep their grain
 * orientation (film roll runs along the table's длина). 'optimal'/undefined: items
 * unchanged (free rotation).
 */
export function orientItemsForVacuumDirection(
  items: readonly FreecutItem[],
  stockWidthMm: number,
  stockHeightMm: number,
  direction: 'optimal' | 'width' | 'height' | undefined,
): FreecutItem[] {
  if (direction !== 'width' && direction !== 'height') return [...items];
  const longAxisIsX = stockWidthMm >= stockHeightMm;
  const longEdgeAlongLongSide = direction === 'width'; // «по длине»
  const longEdgeAlongX = longEdgeAlongLongSide ? longAxisIsX : !longAxisIsX;
  return items.map((item) => {
    if (item.pattern_direction !== 'none') return item; // textured: grain wins
    const longEdge = Math.max(item.width_mm, item.height_mm);
    const shortEdge = Math.min(item.width_mm, item.height_mm);
    return {
      ...item,
      width_mm: longEdgeAlongX ? longEdge : shortEdge,
      height_mm: longEdgeAlongX ? shortEdge : longEdge,
      rotation: 'forbid',
    };
  });
}

export function buildOptimizeRequest(input: BuildOptimizeRequestInput): OptimizeRequest {
  const orientedInput = orientOptimizeInputPortrait(input);
  const resolvedParams =
    orientedInput.params.layout_mode === 'vacuum_table' && orientedInput.params.vacuum
      ? {
          ...orientedInput.params,
          vacuum: {
            ...orientedInput.params.vacuum,
            direction: resolveVacuumDirection(
              orientedInput.params.vacuum.direction,
              orientedInput.stock.width_mm,
              orientedInput.stock.height_mm,
            ),
          },
        }
      : orientedInput.params;

  const orientedItems =
    orientedInput.params.layout_mode === 'vacuum_table' && orientedInput.params.vacuum
      ? orientItemsForVacuumDirection(
          orientedInput.items,
          orientedInput.stock.width_mm,
          orientedInput.stock.height_mm,
          orientedInput.params.vacuum.direction,
        )
      : [...orientedInput.items];

  return {
    units: 'mm',
    params: { ...resolvedParams, include_svg: input.includeSvg === true },
    // qty:0 = unlimited stock unless a warehouse constraint is applied later.
    stock: [
      {
        id: input.stock.id,
        width_mm: orientedInput.stock.width_mm,
        height_mm: orientedInput.stock.height_mm,
        qty: orientedInput.stock.qty ?? 0,
      },
    ],
    items: orientedItems,
  };
}

export function assertWithinInstanceLimit(items: readonly FreecutItem[]): void {
  const total = items.reduce((sum, item) => sum + item.qty, 0);
  if (total > MAX_INSTANCES) {
    throw new ApiError(
      422,
      'CUT_MAX_INSTANCES_EXCEEDED',
      `Группа превышает лимит ${MAX_INSTANCES} деталей (текущее ${total}); сократите выборку или разбейте по заказу/дате`,
      { limit: MAX_INSTANCES, current: total },
    );
  }
}

export function assertWithinBodyLimit(request: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
  if (bytes > MAX_BODY_BYTES) {
    throw new ApiError(413, 'CUT_REQUEST_TOO_LARGE', 'Запрос на раскрой превышает лимит размера', {
      limit: MAX_BODY_BYTES,
      current: bytes,
    });
  }
}

export interface FreecutPlacement {
  item_id: string;
  instance: number;
  x_mm: number;
  y_mm: number;
  width_mm: number;
  height_mm: number;
  rotated: boolean;
}

export interface FreecutSolution {
  stock_id: string;
  index: number;
  width_mm: number;
  height_mm: number;
  trim_mm: TrimMm;
  placements: FreecutPlacement[];
}

export interface FreecutOptimizeResponse {
  status: string;
  summary?: Record<string, unknown>;
  solutions: FreecutSolution[];
  unplaced_items?: Array<{ item_id: string; instance: number; reason: string }>;
}

export interface FreecutResponseContractViolation {
  code: string;
  path: string;
}

/** Runtime trust boundary for the external optimizer response. Geometry checks
 * run separately; this verifies that the response is a lossless, well-formed
 * partition of the exact request instances before any DB persistence. */
export function validateFreecutResponseContract(
  request: OptimizeRequest,
  response: unknown,
): FreecutResponseContractViolation[] {
  const out: FreecutResponseContractViolation[] = [];
  const fail = (code: string, path: string) => out.push({ code, path });
  const finiteNonNegative = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const sameNumber = (a: unknown, b: number) => finiteNonNegative(a) && Math.abs((a as number) - b) <= 1e-6;
  if (response === null || typeof response !== 'object') return [{ code: 'invalid_response', path: '$' }];
  const raw = response as Record<string, unknown>;
  if (raw.status !== 'ok') fail('invalid_status', 'status');
  if (!Array.isArray(raw.solutions)) return [{ code: 'invalid_solutions', path: 'solutions' }];
  const unplaced = raw.unplaced_items === undefined ? [] : raw.unplaced_items;
  if (!Array.isArray(unplaced)) fail('invalid_unplaced_items', 'unplaced_items');

  const stock = request.stock[0];
  const expected = new Map<string, FreecutItem>();
  for (const item of request.items) {
    for (let instance = 1; instance <= item.qty; instance += 1) expected.set(`${item.id}:${instance}`, item);
  }
  const seen = new Set<string>();
  const sheetIndices = new Set<number>();

  raw.solutions.forEach((rawSolution, solutionPos) => {
    const path = `solutions[${solutionPos}]`;
    if (rawSolution === null || typeof rawSolution !== 'object') { fail('invalid_solution', path); return; }
    const solution = rawSolution as Record<string, unknown>;
    if (solution.stock_id !== stock.id) fail('stock_id_mismatch', `${path}.stock_id`);
    if (!Number.isInteger(solution.index) || (solution.index as number) < 0) fail('invalid_sheet_index', `${path}.index`);
    else if (sheetIndices.has(solution.index as number)) fail('duplicate_sheet_index', `${path}.index`);
    else sheetIndices.add(solution.index as number);
    if (!sameNumber(solution.width_mm, stock.width_mm)) fail('sheet_width_mismatch', `${path}.width_mm`);
    if (!sameNumber(solution.height_mm, stock.height_mm)) fail('sheet_height_mismatch', `${path}.height_mm`);
    const trim = solution.trim_mm;
    if (trim === null || typeof trim !== 'object') fail('invalid_trim', `${path}.trim_mm`);
    else for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      if (!sameNumber((trim as Record<string, unknown>)[side], request.params.trim_mm[side])) fail('trim_mismatch', `${path}.trim_mm.${side}`);
    }
    if (!Array.isArray(solution.placements)) { fail('invalid_placements', `${path}.placements`); return; }
    solution.placements.forEach((rawPlacement, placementPos) => {
      const placementPath = `${path}.placements[${placementPos}]`;
      if (rawPlacement === null || typeof rawPlacement !== 'object') { fail('invalid_placement', placementPath); return; }
      const placement = rawPlacement as Record<string, unknown>;
      if (typeof placement.item_id !== 'string') fail('invalid_item_id', `${placementPath}.item_id`);
      if (!Number.isInteger(placement.instance) || (placement.instance as number) <= 0) fail('invalid_instance', `${placementPath}.instance`);
      const key = `${placement.item_id as string}:${placement.instance as number}`;
      const item = expected.get(key);
      if (!item) fail('unknown_instance', placementPath);
      if (seen.has(key)) fail('duplicate_instance', placementPath); else seen.add(key);
      for (const field of ['x_mm', 'y_mm', 'width_mm', 'height_mm'] as const) {
        if (!finiteNonNegative(placement[field])) fail('invalid_number', `${placementPath}.${field}`);
      }
      if (typeof placement.rotated !== 'boolean') fail('invalid_rotated', `${placementPath}.rotated`);
      if (item && typeof placement.rotated === 'boolean') {
        if (placement.rotated && item.rotation === 'forbid') fail('rotation_forbidden', `${placementPath}.rotated`);
        const expectedWidth = placement.rotated ? item.height_mm : item.width_mm;
        const expectedHeight = placement.rotated ? item.width_mm : item.height_mm;
        if (!sameNumber(placement.width_mm, expectedWidth)) fail('piece_width_mismatch', `${placementPath}.width_mm`);
        if (!sameNumber(placement.height_mm, expectedHeight)) fail('piece_height_mismatch', `${placementPath}.height_mm`);
      }
    });
  });

  if (Array.isArray(unplaced)) unplaced.forEach((rawItem, pos) => {
    const path = `unplaced_items[${pos}]`;
    if (rawItem === null || typeof rawItem !== 'object') { fail('invalid_unplaced_item', path); return; }
    const item = rawItem as Record<string, unknown>;
    if (typeof item.item_id !== 'string') fail('invalid_item_id', `${path}.item_id`);
    if (!Number.isInteger(item.instance) || (item.instance as number) <= 0) fail('invalid_instance', `${path}.instance`);
    const key = `${item.item_id as string}:${item.instance as number}`;
    if (!expected.has(key)) fail('unknown_instance', path);
    if (seen.has(key)) fail('duplicate_instance', path); else seen.add(key);
    if (typeof item.reason !== 'string') fail('invalid_unplaced_reason', `${path}.reason`);
  });
  for (const key of expected.keys()) if (!seen.has(key)) fail('missing_instance', key);
  return out;
}

/**
 * Persisted placement piece type. Extends FreecutPlacement with an optional
 * display label snapshot (Codex R13 MAJOR #4). The label field is populated
 * by Task 4 (persist step) — not here. FreecutPlacement and backMapSolutions
 * are intentionally left unchanged.
 */
export type SheetPlacementPieceJson = FreecutPlacement & {
  label?: PieceLabelSnapshot;
  /** Frozen request rule. Absent on legacy layouts. */
  rotation_forbidden?: boolean;
};

/** Frozen per-sheet placements JSONB (plan §3). Render source of truth. */
export interface SheetPlacementsJson {
  coordinate_contract?: typeof NATIVE_PORTRAIT_COORDINATE_CONTRACT;
  trim_mm: TrimMm;
  sheet_width_mm: number;
  sheet_height_mm: number;
  pieces: SheetPlacementPieceJson[];
}

export interface BackMappedSheet {
  sheetIndex: number;
  placements: SheetPlacementsJson;
}

/**
 * Normalize freecut solutions into per-sheet placements JSONB. Each piece keeps
 * its `instance` so two pieces of one detail on one sheet get distinct labels;
 * `trim_mm` is carried so the renderer can offset placements (relative to the
 * usable area) onto the full sheet.
 */
export function backMapSolutions(
  response: FreecutOptimizeResponse,
  options?: { coordinateContract?: typeof NATIVE_PORTRAIT_COORDINATE_CONTRACT; requestItems?: readonly FreecutItem[] },
): BackMappedSheet[] {
  const requestItemById = new Map(options?.requestItems?.map((item) => [item.id, item]));
  return response.solutions.map((solution) => ({
    sheetIndex: solution.index,
    placements: {
      ...(options?.coordinateContract ? { coordinate_contract: options.coordinateContract } : {}),
      trim_mm: solution.trim_mm,
      sheet_width_mm: solution.width_mm,
      sheet_height_mm: solution.height_mm,
      pieces: solution.placements.map((placement) => ({
        item_id: placement.item_id,
        instance: placement.instance,
        x_mm: placement.x_mm,
        y_mm: placement.y_mm,
        width_mm: placement.width_mm,
        height_mm: placement.height_mm,
        rotated: placement.rotated,
        ...(requestItemById.has(placement.item_id)
          ? { rotation_forbidden: requestItemById.get(placement.item_id)?.rotation === 'forbid' }
          : {}),
      })),
    },
  }));
}

/** "det-<detail_id>" item id used to round-trip placements back to a cut_job_item. */
export function freecutItemId(detailId: number): string {
  return `det-${detailId}`;
}

export function parseFreecutItemId(itemId: string): number | null {
  const match = /^det-(\d+)$/.exec(itemId);
  return match ? Number(match[1]) : null;
}
