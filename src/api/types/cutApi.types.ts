export interface CutSelectionCriteria {
  materialIds?: number[];
  orderIds?: number[];
  filmIds?: number[];
  productionStatusIds?: number[];
}

export interface CreateCutJobRequest {
  name: string;
  criteria?: CutSelectionCriteria;
  detailIds?: number[];
}

export interface AddCutItemsRequest {
  detailIds: number[];
  version: number;
}

export interface CutJobItemDto {
  cutJobItemId: number;
  orderDetailId: number;
  orderId: number;
  qty: number;
  cutGroupId: number | null;
}

export interface SheetPlacementPiece {
  item_id: string;
  instance: number;
  x_mm: number;
  y_mm: number;
  width_mm: number;
  height_mm: number;
  rotated: boolean;
}

export interface SheetPlacements {
  trim_mm: { left: number; right: number; top: number; bottom: number };
  sheet_width_mm: number;
  sheet_height_mm: number;
  pieces: SheetPlacementPiece[];
}

export interface CutGroupSheetDto {
  cutGroupSheetId: number;
  sheetIndex: number;
  pngCacheKey: string | null;
  placements: SheetPlacements;
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

export type CutIneligibleReason = 'deleted' | 'already_reserved' | 'wrong_status' | 'no_sheet_spec';

export interface EligibleDetailDto {
  orderDetailId: number;
  orderId: number;
  quantity: number;
  materialId: number;
  sheetMaterialTypeId: number | null;
  filmId: number | null;
  eligible: boolean;
  ineligibleReason: CutIneligibleReason | null;
}

export interface EligibleDetailsResponse {
  details: EligibleDetailDto[];
  noSheetSpecCount: number;
}

export type CutRenderPreset = 'thumb' | 'screen' | 'print';
