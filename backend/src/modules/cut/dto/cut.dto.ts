import type { IneligibleReason } from '../application/cut-eligibility';
import type { SheetPlacementsJson } from '../application/cut-freecut-mapping';

/** Filters that resolve a candidate detail set (snapshot onto the job). */
export interface CutSelectionCriteriaDto {
  materialIds?: number[];
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
  items: CutJobItemDto[];
  groups: CutGroupDto[];
  unplaced?: Array<{ itemId: string; instance: number; reason: string }>;
}

export interface EligibleDetailDto {
  orderDetailId: number;
  orderId: number;
  quantity: number;
  materialId: number;
  sheetMaterialTypeId: number | null;
  filmId: number | null;
  eligible: boolean;
  ineligibleReason: IneligibleReason | null;
}

export interface EligibleDetailsResponseDto {
  details: EligibleDetailDto[];
  /** count of details blocked only because their material has no sheet spec */
  noSheetSpecCount: number;
}
