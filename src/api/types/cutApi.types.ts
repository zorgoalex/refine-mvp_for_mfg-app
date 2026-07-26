export interface CutSelectionCriteria {
  /** Variant B: filter by sheet_material_type_id (replaces materialIds post-034). */
  sheetMaterialTypeIds?: number[];
  orderIds?: number[];
  filmIds?: number[];
  productionStatusIds?: number[];
  dateFrom?: string;
  dateTo?: string;
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

/**
 * Full order-detail data for a reserved cut item (server-resolved dictionary
 * names), mirroring the order form's detail fields. Price/sum
 * (milling_cost_per_sqm, detail_cost) are intentionally absent — the /cut surface
 * is production-facing. Fields are null when the source detail no longer exists.
 */
export interface CutDetailInfoDto {
  /** Raw order_details row values, keyed by DB column name, for operator tooltip. */
  detailFields?: Record<string, unknown> | null;
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
  /** Whether the film has a texture/grain direction (null when no film). */
  filmTexture: boolean | null;
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
  /** Order name from orders.order_name (present only on enriched single-job read). */
  orderName?: string | null;
}

export interface SheetPlacementPiece {
  item_id: string;
  instance: number;
  x_mm: number;
  y_mm: number;
  width_mm: number;
  height_mm: number;
  rotated: boolean;
  rotation_forbidden?: boolean;
  /** Frozen label snapshot from calculate (absent in legacy records). */
  label?: { orderId: number | null; detailNumber: number | null; widthMm: number | null; heightMm: number | null };
}

export interface SheetPlacements {
  coordinate_contract?: 'native_portrait_v1';
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

/** A single sheet in a manual layout (no DB sheet row — light shape). */
export interface CutManualSheet {
  sheetIndex: number;
  placements: SheetPlacements;
  viewTransform?: Omit<CutSheetViewTransform, 'sheetIndex'>;
}

/** Saved manual placement layout for a cut group. */
export interface CutManualLayout {
  groupKey: string;
  sheets: CutManualSheet[];
  isActive: boolean;
  isStale: boolean;
  version: number;
}

export interface CutGroupDto {
  cutGroupId: number;
  sheetMaterialTypeId: number | null;
  filmId: number | null;
  status: string;
  pdfTemplate: string;
  summary: Record<string, unknown> | null;
  sheets: CutGroupSheetDto[];
  /** Saved manual layout for this group (null when none, absent on list endpoint). */
  manualLayout?: CutManualLayout | null;
  /** Opaque render token for cache-busting render endpoints (present on single-job GET). */
  renderToken?: string;
}

export interface CutJobTotals {
  positions: number;
  details: number;
  area: number;
  sheets: number;
  /** resolved sheet materials (override-aware): a per-job sheet override → 1,
   *  else distinct non-null per-detail sheet materials */
  materialsCount: number;
  /** distinct non-null films among the job's details */
  filmsCount: number;
}

/** Per-job editor geometry params (trim is read from placements.trim_mm). */
export interface CutEditorParams {
  kerfMm: number;
  spacingMm: number;
}

/** A single manual placement move (input body for PATCH manual-layout). */
export interface CutManualMove {
  itemId: string;
  instance: number;
  sheetIndex: number;
  xMm: number;
  yMm: number;
  rotated: boolean;
}

export interface CutSheetViewTransform {
  sheetIndex: number;
  rotationDeg: 0 | 90 | 180 | 270;
  mirrorHorizontal: boolean;
  mirrorVertical: boolean;
}

/** Body for PATCH /cut-jobs/:cutJobId/groups/:groupId/manual-layout */
export interface SaveManualLayoutRequest {
  jobVersion: number;
  active: boolean;
  placements: CutManualMove[];
  sheetTransforms: CutSheetViewTransform[];
  commandId: string;
}

export interface CutJobDto {
  cutJobId: number;
  name: string;
  status: string;
  source: string;
  version: number;
  pdfPrewarmState: string;
  /** Stable failure code when status === 'failed' (else null/absent). */
  failureCode?: string | null;
  /** Operator-facing Russian explanation when status === 'failed' (else null/absent). */
  failureReason?: string | null;
  paramProfileId: number | null;
  sheetMaterialTypeId: number | null;
  pdfTemplate: string;
  /** true = group details by sheet material only (films of the same material
   *  share sheets); false (default) = group by (material, film). */
  combineFilms: boolean;
  /** true (default) = split by material (different materials → separate groups);
   *  false = all details in one group. */
  splitByMaterial: boolean;
  /** Unique per-detail material names in this job (not the per-job sheet override). */
  materialNames: string[];
  totals: CutJobTotals;
  items: CutJobItemDto[];
  groups: CutGroupDto[];
  unplaced?: Array<{ itemId: string; instance: number; reason: string }>;
  /**
   * Editor geometry params (present on single-job GET, absent on list).
   * Optional to avoid breaking list-endpoint consumers.
   */
  editorParams?: CutEditorParams | null;
  /**
   * True when the stored manual layout is stale and must be recalculated before
   * the editor can save again. Present on single-job GET, absent on list.
   */
  requiresRecalc?: boolean;
  /** Geometry check of stored automatic sheets; invalid legacy layouts require
   * recalculation before manual editing. Present on single-job GET. */
  autoLayoutValidation?: { valid: boolean };
  /** Opaque render token for cache-busting render endpoints (present on single-job GET). */
  renderToken?: string;
  currentCutResult?: CutResultSummary | null;
  cutResults?: CutResultSummary[];
}

export type CutResultKind = 'auto' | 'manual' | 'legacy';

export interface CutResultSummary {
  cutResultId: number;
  cutJobId: number;
  resultNo: number;
  cutNumber: string;
  resultKind: CutResultKind;
  sourceJobVersion: number;
  basedOnResultId: number | null;
  createdBy: number | null;
  createdByName: string | null;
  createdAt: string;
  totals: CutJobTotals;
  isCurrent: boolean;
}

export interface CutResultDto extends CutResultSummary {
  job: CutJobDto;
  renderToken: string;
}

export type CutIneligibleReason = 'deleted' | 'wrong_status' | 'not_cuttable' | 'no_sheet_spec';

/** A cut job a detail is placed in (informational; placement is non-exclusive). */
export interface CutJobRef {
  cutJobId: number;
  name: string;
}

export interface EligibleDetailDto {
  orderDetailId: number;
  orderId: number;
  /** orders.order_name — пользователи мыслят названиями, не ID. */
  orderName?: string | null;
  quantity: number;
  /** NULL post-034 (Variant B: material_id sunsetted on order_details). */
  materialId: number | null;
  sheetMaterialTypeId: number | null;
  filmId: number | null;
  eligible: boolean;
  ineligibleReason: CutIneligibleReason | null;
  /** active (non-archived) cut jobs this detail is already placed in */
  activeJobs: CutJobRef[];
  /** true when this detail also exists in at least one archived cut job */
  inArchivedJob: boolean;
}

export interface EligibleDetailsResponse {
  details: EligibleDetailDto[];
  noSheetSpecCount: number;
}

/** Where a detail/order set is already placed (informational, multi-job). */
export interface CutDetailPlacements {
  /** distinct active (non-archived) jobs containing ANY of the requested details */
  jobs: CutJobRef[];
  /** true when ANY requested detail also exists in an archived job */
  hasArchived: boolean;
}

export interface CutDetailLastReadyRef {
  orderDetailId: number;
  cutJobId: number;
  name: string;
}

export interface CutDetailLastReadyResponse {
  details: CutDetailLastReadyRef[];
}

export type CutRenderPreset = 'thumb' | 'screen' | 'print';

/**
 * Minimal sheet-type data for the /cut filter (Variant B Task 11).
 * Returned by the cut.view-gated GET /cut-jobs/sheet-types endpoint.
 * No sheet_materials.view required.
 */
export interface CutSheetTypeOption {
  sheetMaterialTypeId: number;
  name: string;
  widthMm: number;
  heightMm: number;
  /** Only cuttable types are eligible cut criteria. */
  isCuttable: boolean;
  /** Source material type id (matches backend CutSheetTypeOption). */
  materialTypeId: number;
  /** Sheet thickness in mm (matches backend CutSheetTypeOption). */
  thicknessMm: number;
}
