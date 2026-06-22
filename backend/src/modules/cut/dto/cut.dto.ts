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

export interface CutJobItemDto {
  cutJobItemId: number;
  orderDetailId: number;
  orderId: number;
  qty: number;
  cutGroupId: number | null;
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
