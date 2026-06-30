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

export function buildOptimizeRequest(input: BuildOptimizeRequestInput): OptimizeRequest {
  const resolvedParams =
    input.params.layout_mode === 'vacuum_table' && input.params.vacuum
      ? {
          ...input.params,
          vacuum: {
            ...input.params.vacuum,
            direction: resolveVacuumDirection(
              input.params.vacuum.direction,
              input.stock.width_mm,
              input.stock.height_mm,
            ),
          },
        }
      : input.params;

  return {
    units: 'mm',
    params: { ...resolvedParams, include_svg: input.includeSvg === true },
    // qty:0 = unlimited stock unless a warehouse constraint is applied later.
    stock: [
      {
        id: input.stock.id,
        width_mm: input.stock.width_mm,
        height_mm: input.stock.height_mm,
        qty: input.stock.qty ?? 0,
      },
    ],
    items: input.items,
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

/**
 * Persisted placement piece type. Extends FreecutPlacement with an optional
 * display label snapshot (Codex R13 MAJOR #4). The label field is populated
 * by Task 4 (persist step) — not here. FreecutPlacement and backMapSolutions
 * are intentionally left unchanged.
 */
export type SheetPlacementPieceJson = FreecutPlacement & { label?: PieceLabelSnapshot };

/** Frozen per-sheet placements JSONB (plan §3). Render source of truth. */
export interface SheetPlacementsJson {
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
export function backMapSolutions(response: FreecutOptimizeResponse): BackMappedSheet[] {
  return response.solutions.map((solution) => ({
    sheetIndex: solution.index,
    placements: {
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
