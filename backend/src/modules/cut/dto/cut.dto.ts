import type { IneligibleReason } from '../application/cut-eligibility';
import type { SheetPlacementsJson } from '../application/cut-freecut-mapping';

/** Filters that resolve a candidate detail set (snapshot onto the job). */
export interface CutSelectionCriteriaDto {
  /** Variant B: filter by sheet_material_type_id (replaces materialIds post-034). */
  sheetMaterialTypeIds?: number[];
  orderIds?: number[];
  filmIds?: number[];
  productionStatusIds?: number[];
}

export interface CreateCutJobRequestDto {
  name: string;
  criteria?: CutSelectionCriteriaDto;
  /** explicit detail ids to seed the job with (reserved on create) */
  detailIds?: number[];
}

export interface AddCutItemsRequestDto {
  detailIds: number[];
}

/**
 * Full order-detail data for a reserved cut item, mirroring the order form's
 * detail fields with server-resolved dictionary names. Deliberately omits the
 * detail's price/sum (milling_cost_per_sqm, detail_cost) — the /cut surface is
 * production-facing, not financial. Fields are nullable because a reserved
 * detail may have been hard-deleted from its order after reservation.
 */
export interface CutDetailInfoDto {
  /** Raw order_details row values, keyed by DB column name, for operator tooltip. */
  detailFields: Record<string, unknown> | null;
  detailNumber: number | null;
  detailName: string | null;
  height: number | null;
  width: number | null;
  quantity: number | null;
  area: number | null;
  materialId: number | null;
  sheetMaterialTypeId: number | null;
  materialName: string | null;
  millingTypeId: number | null;
  millingTypeName: string | null;
  edgeTypeId: number | null;
  edgeTypeName: string | null;
  filmId: number | null;
  filmName: string | null;
  priority: number | null;
  productionStatusId: number | null;
  productionStatusName: string | null;
  jointOrderId: number | null;
  note: string | null;
  linkCuttingFile: string | null;
  linkCuttingImageFile: string | null;
  linkCadFile: string | null;
  linkPdfFile: string | null;
}

export interface CutJobItemDto {
  cutJobItemId: number;
  orderDetailId: number;
  orderId: number;
  qty: number;
  cutGroupId: number | null;
  /** Resolved order-detail fields (null when the source detail no longer exists). */
  detail: CutDetailInfoDto | null;
}

export interface CutGroupSheetDto {
  cutGroupSheetId: number;
  sheetIndex: number;
  pngCacheKey: string | null;
  placements: SheetPlacementsJson;
}

export interface CutGroupDto {
  cutGroupId: number;
  sheetMaterialTypeId: number | null;
  filmId: number | null;
  status: string;
  summary: Record<string, unknown> | null;
  sheets: CutGroupSheetDto[];
}

export interface CutJobTotals {
  /** count of active cut_job_item rows (one row per reserved detail) */
  positions: number;
  /** SUM(order_details.quantity) over the job's active items */
  details: number;
  /** SUM(order_details.area * order_details.quantity), rounded to 2 dp */
  area: number;
  /** count of cut_group_sheet rows across the job's groups (0 unless ready) */
  sheets: number;
  /** count of RESOLVED sheet materials (override-aware): a per-job sheet override
   *  cuts every detail on one sheet → 1; otherwise DISTINCT non-null per-detail
   *  sheet materials. Matches what calculate groups by. */
  materialsCount: number;
  /** count of DISTINCT non-null films among the job's details */
  filmsCount: number;
}

export interface CutJobDto {
  cutJobId: number;
  name: string;
  status: string;
  source: string;
  version: number;
  pdfPrewarmState: string;
  /** Stable failure code when status === 'failed' (else null). */
  failureCode: string | null;
  /** Operator-facing Russian explanation when status === 'failed' (else null). */
  failureReason: string | null;
  paramProfileId: number | null;
  /** null = no per-job override (per-detail sheet). Non-null = chosen sheet. */
  sheetMaterialTypeId: number | null;
  /** true = calculate groups details by sheet material only (films of the same
   *  material share sheets). false (default) = group by (material, film). */
  combineFilms: boolean;
  totals: CutJobTotals;
  items: CutJobItemDto[];
  groups: CutGroupDto[];
  unplaced?: Array<{ itemId: string; instance: number; reason: string }>;
}

/** A cut job a detail is placed in (informational, not exclusive). */
export interface CutJobRefDto {
  cutJobId: number;
  name: string;
}

export interface EligibleDetailDto {
  orderDetailId: number;
  orderId: number;
  quantity: number;
  /** NULL post-034 (Variant B: material_id sunsetted on order_details). */
  materialId: number | null;
  sheetMaterialTypeId: number | null;
  filmId: number | null;
  eligible: boolean;
  ineligibleReason: IneligibleReason | null;
  /** active (non-archived) cut jobs this detail is already placed in */
  activeJobs: CutJobRefDto[];
  /** true when this detail also exists in at least one archived cut job */
  inArchivedJob: boolean;
}

export interface EligibleDetailsResponseDto {
  details: EligibleDetailDto[];
  /** count of details blocked only because their material has no sheet spec */
  noSheetSpecCount: number;
}

/** Where a set of details/orders are already placed (informational, multi-job). */
export interface CutDetailPlacementsResponseDto {
  /** distinct active (non-archived) jobs containing ANY of the requested details */
  jobs: CutJobRefDto[];
  /** true when ANY requested detail also exists in an archived job */
  hasArchived: boolean;
}

/** One detail's latest-created ready (calculated) cut job. */
export interface CutDetailLastReadyRefDto {
  orderDetailId: number;
  cutJobId: number;
  name: string;
}

/** Per-detail latest-created ready cut job (only details that have one appear). */
export interface CutDetailLastReadyResponseDto {
  details: CutDetailLastReadyRefDto[];
}
