import type { CurrentUser } from '../../../permissions/current-user';
import type { CutAxisOrigin } from '../../../shared/cut-geometry';
import type { CutRenderStyleName } from '../../../shared/cut-render-style';
import type {
  AddCutItemsRequestDto,
  CreateCutJobRequestDto,
  CutDetailLastReadyResponseDto,
  CutDetailPlacementsResponseDto,
  CutFilmOptionDto,
  CutJobDeleteImpactDto,
  CutJobDto,
  CutTextureDirection,
  CutResultDto,
  CutResultSummaryDto,
  CutManualSheetDto,
  EligibleDetailsResponseDto,
  CutSelectionCriteriaDto,
} from '../dto/cut.dto';

export interface ManualMove {
  itemId: string;
  instance: number;
  sheetIndex: number;
  xMm: number;
  yMm: number;
  rotated: boolean;
}

export interface SheetViewTransform {
  sheetIndex: number;
  rotationDeg: 0 | 90 | 180 | 270;
  mirrorHorizontal: boolean;
  mirrorVertical: boolean;
}

export interface SaveManualLayoutCommand {
  currentUser: CurrentUser;
  cutJobId: number;
  cutGroupId: number;
  jobVersion: number;
  placements: ManualMove[];
  sheetTransforms?: SheetViewTransform[];
  active: boolean;
  commandId: string;
  requestId?: string;
}

export interface CreateCutJobCommand {
  currentUser: CurrentUser;
  dto: CreateCutJobRequestDto;
  requestId?: string;
}

export interface AddCutItemsCommand {
  currentUser: CurrentUser;
  cutJobId: number;
  /** optimistic concurrency guard */
  version: number;
  dto: AddCutItemsRequestDto;
  requestId?: string;
}

export interface RemoveCutItemCommand {
  currentUser: CurrentUser;
  cutJobId: number;
  cutJobItemId: number;
  version: number;
  requestId?: string;
}

export interface CalculateCutJobCommand {
  currentUser: CurrentUser;
  cutJobId: number;
  version: number;
  commandId: string;
  requestId?: string;
}

export interface ArchiveCutJobCommand {
  currentUser: CurrentUser;
  cutJobId: number;
  version: number;
  deleteLinkedMdfPackets?: boolean;
  requestId?: string;
}

export interface CreateCutJobMdfBoardCardCommand {
  currentUser: CurrentUser;
  cutJobId: number;
  expectedCutResultId: number;
  requestId?: string;
}

export interface DeleteCutJobMdfBoardCardCommand {
  currentUser: CurrentUser;
  cutJobId: number;
  expectedCutResultId: number;
  requestId?: string;
}

export interface GetCutJobQuery {
  currentUser: CurrentUser;
  cutJobId: number;
  requestId?: string;
}

export interface GetCutJobDeleteImpactQuery {
  currentUser: CurrentUser;
  cutJobId: number;
  requestId?: string;
}

export interface ListCutResultsQuery {
  currentUser: CurrentUser;
  cutJobId: number;
  requestId?: string;
}

export interface GetCutResultQuery extends ListCutResultsQuery {
  resultNo: number;
}

export interface CutResultStateCommand {
  currentUser: CurrentUser;
  cutJobId: number;
  resultNo: number;
  requestId?: string;
}

export interface ListCutJobsQuery {
  currentUser: CurrentUser;
  filters?: {
    status?: string;
    createdBy?: number;
    includeArchived?: boolean;
    /** Match order id or orders.order_name before the list LIMIT is applied. */
    orderSearch?: string;
    /** Match operator-facing job number before the list LIMIT is applied. */
    jobNumber?: string;
    /** Inclusive cut_job.created_at lower bound, YYYY-MM-DD. */
    createdFrom?: string;
    /** Inclusive cut_job.created_at upper bound, YYYY-MM-DD. */
    createdTo?: string;
  };
  requestId?: string;
}

export interface EligibleDetailsQuery {
  currentUser: CurrentUser;
  criteria: CutSelectionCriteriaDto;
  /**
   * Preview-before-create mode: show every detail matching explicit criteria
   * regardless of production status, while still classifying wrong statuses as
   * ineligible. Add/reserve paths keep the ready-status filter.
   */
  includeAllStatuses?: boolean;
  requestId?: string;
}

export interface RenderSheetPngQuery {
  currentUser: CurrentUser;
  cutJobId?: number;
  resultNo?: number;
  cutGroupId: number;
  sheetIndex: number;
  /** render preset NAME; px resolved from cut_render_presets config at render time */
  preset: string;
  /** landscape orientation: rotate the layout 90° (long side horizontal). */
  rotate90?: boolean;
  /** when rotated, anchor the dense cluster at the view's top-left (transpose)
   *  instead of the legacy 90° CW top-right. Ignored when rotate90=false. */
  originTopLeft?: boolean;
  axisOrigin?: CutAxisOrigin;
  variant?: 'auto' | 'manual' | 'active';
  /**
   * When false, baked piece-label `<text>` elements are omitted from the SVG
   * before rasterisation. The on-screen PNG preview passes false so the HTML
   * overlay is the sole label source (no double-label collision).
   * Defaults to true. SVG download and PDF print are unaffected (always true).
   */
  showLabels?: boolean;
  /** Optional named visual profile for screen/Telegram-specific renders. */
  renderStyle?: CutRenderStyleName;
  requestId?: string;
}

export interface RenderSheetSvgQuery {
  currentUser: CurrentUser;
  cutJobId?: number;
  resultNo?: number;
  cutGroupId: number;
  sheetIndex: number;
  /** landscape orientation: rotate the layout 90° (long side horizontal). */
  rotate90?: boolean;
  /** when rotated, anchor the dense cluster at the view's top-left (transpose)
   *  instead of the legacy 90° CW top-right. Ignored when rotate90=false. */
  originTopLeft?: boolean;
  axisOrigin?: CutAxisOrigin;
  variant?: 'auto' | 'manual' | 'active';
  /** Re-render old frozen SVG views from stored placements when they lack piece data-* metadata. */
  pieceMetadata?: boolean;
  /** Optional named visual profile for screen/Telegram-specific renders. */
  renderStyle?: CutRenderStyleName;
  requestId?: string;
}

export interface RenderGroupPdfQuery {
  currentUser: CurrentUser;
  cutJobId?: number;
  resultNo?: number;
  cutGroupId: number;
  /** landscape orientation: rotate the layout 90° (long side horizontal). */
  rotate90?: boolean;
  /** when rotated, anchor the dense cluster at the view's top-left (transpose)
   *  instead of the legacy 90° CW top-right. Ignored when rotate90=false. */
  originTopLeft?: boolean;
  axisOrigin?: CutAxisOrigin;
  variant?: 'auto' | 'manual' | 'active';
  pdfTemplate?: string;
  requestId?: string;
}

export interface RenderJobPdfQuery {
  currentUser: CurrentUser;
  cutJobId: number;
  resultNo?: number;
  /** landscape orientation: rotate the layout 90° (long side horizontal). */
  rotate90?: boolean;
  /** when rotated, anchor the dense cluster at the view's top-left (transpose)
   *  instead of the legacy 90° CW top-right. Ignored when rotate90=false. */
  originTopLeft?: boolean;
  axisOrigin?: CutAxisOrigin;
  variant?: 'auto' | 'manual' | 'active';
  pdfTemplate?: string;
  requestId?: string;
}

export interface SetPdfPrewarmStateQuery {
  cutJobId: number;
  /** version the render was kicked for; the UPDATE no-ops if the job moved on */
  version: number;
  state: 'pending' | 'ready' | 'failed';
  reason?: string;
}

export interface CutPermissionDeniedInput {
  currentUser: CurrentUser;
  requiredPermissions: readonly string[];
  requestId?: string;
  cutJobId?: number;
  /** When present, enriches the denied audit with cut_group + order bridge rows. */
  cutGroupId?: number;
  /** Extra metadata merged into the denied audit's metadata_json. */
  metadata?: Record<string, unknown>;
}

export interface DetailPlacementsQuery {
  currentUser: CurrentUser;
  /** explicit detail ids (detail-level mode); takes precedence over orderIds */
  detailIds?: number[];
  /** order ids whose non-deleted details are resolved when detailIds is empty */
  orderIds?: number[];
  requestId?: string;
}

export interface DetailLastReadyQuery {
  currentUser: CurrentUser;
  /** detail ids whose latest-created ready cut job is resolved (one row max per detail) */
  detailIds?: number[];
  requestId?: string;
}

/** Minimal sheet-type data returned by the cut-gated sheet-lookup endpoint. */
export interface CutSheetTypeOption {
  sheetMaterialTypeId: number;
  name: string;
  materialTypeId: number;
  thicknessMm: number;
  widthMm: number;
  heightMm: number;
  /** Only cuttable sheet types are included in the cut filter. */
  isCuttable: boolean;
}

export interface ListSheetTypesForCutQuery {
  currentUser: CurrentUser;
  requestId?: string;
}

export interface ListFilmOptionsForCutQuery {
  currentUser: CurrentUser;
  criteria: CutSelectionCriteriaDto;
  requestId?: string;
}

export interface SetCutJobProfileCommand {
  currentUser: CurrentUser;
  cutJobId: number;
  /** null = clear the selection (no explicit profile); calculate then uses the
   *  create-time cut_job.params snapshot, runtime default only if it is empty */
  paramProfileId: number | null;
  version: number;
  requestId?: string;
}

export interface SetCutJobSheetMaterialCommand {
  currentUser: CurrentUser;
  cutJobId: number;
  /** null = clear the override; calculate then resolves each detail's own sheet
   *  from order_details.sheet_material_type_id (current behavior). */
  sheetMaterialTypeId: number | null;
  version: number;
  requestId?: string;
}

export interface SetCutJobCombineFilmsCommand {
  currentUser: CurrentUser;
  cutJobId: number;
  /** true = group a job's details by sheet material only (films of the same
   *  material nest on shared sheets). false = group by (material, film), the
   *  per-detail default. Different materials are never combined. */
  combineFilms: boolean;
  version: number;
  requestId?: string;
}

export interface SetCutJobSplitByMaterialCommand {
  currentUser: CurrentUser;
  cutJobId: number;
  /** true (default) = split the job by material type (different materials cut in
   *  separate groups/sheets; the per-job sheet override then only fills no-sheet
   *  details). false = put ALL details into ONE group (cut together). */
  splitByMaterial: boolean;
  version: number;
  requestId?: string;
}

export interface SetCutJobRotationAllowedCommand {
  currentUser: CurrentUser;
  cutJobId: number;
  /** true (default) lets freecut rotate details when profile/grain rules allow;
   *  false forces `rotation: forbid` for every detail in this job calculation. */
  rotationAllowed: boolean;
  version: number;
  requestId?: string;
}

export interface SetCutJobTextureDirectionCommand {
  currentUser: CurrentUser;
  cutJobId: number;
  /** Informational value for PDF maps; does not participate in calculation basis. */
  textureDirection: CutTextureDirection;
  version: number;
  requestId?: string;
}

export interface SetCutJobPdfTemplateCommand {
  currentUser: CurrentUser;
  cutJobId: number;
  pdfTemplate: string;
  requestId?: string;
}

export interface SetCutJobNameCommand {
  currentUser: CurrentUser;
  cutJobId: number;
  name: string;
  version: number;
  requestId?: string;
}

export interface SetCutGroupPdfTemplateCommand {
  currentUser: CurrentUser;
  cutJobId: number;
  cutGroupId: number;
  pdfTemplate: string;
  requestId?: string;
}

export interface GetRenderCacheTokenArgs {
  cutJobId?: number;
  cutGroupId?: number;
  // NOTE: no `variant` here on purpose. The token encodes the layout STATE
  // (job version + per-group manual layout version + effectiveActive) and is
  // variant-independent. Clients append it to render URLs to bust browser/request
  // state after layout changes; current PDF exports still render fresh each time.
}

export interface CutRepositoryPort {
  reconcileExpiredCommands(limit?: number): Promise<number>;
  createJob(command: CreateCutJobCommand): Promise<CutJobDto>;
  recordPermissionDenied(input: CutPermissionDeniedInput): Promise<void>;
  addItems(command: AddCutItemsCommand): Promise<CutJobDto>;
  removeItem(command: RemoveCutItemCommand): Promise<CutJobDto>;
  calculate(command: CalculateCutJobCommand): Promise<CutJobDto>;
  archive(command: ArchiveCutJobCommand): Promise<CutJobDto>;
  createMdfBoardCard(command: CreateCutJobMdfBoardCardCommand): Promise<CutJobDto>;
  deleteMdfBoardCard(command: DeleteCutJobMdfBoardCardCommand): Promise<CutJobDto>;
  getDeleteImpact(query: GetCutJobDeleteImpactQuery): Promise<CutJobDeleteImpactDto>;
  setProfile(command: SetCutJobProfileCommand): Promise<CutJobDto>;
  setSheetMaterial(command: SetCutJobSheetMaterialCommand): Promise<CutJobDto>;
  setCombineFilms(command: SetCutJobCombineFilmsCommand): Promise<CutJobDto>;
  setSplitByMaterial(command: SetCutJobSplitByMaterialCommand): Promise<CutJobDto>;
  setRotationAllowed(command: SetCutJobRotationAllowedCommand): Promise<CutJobDto>;
  setTextureDirection(command: SetCutJobTextureDirectionCommand): Promise<CutJobDto>;
  setJobPdfTemplate(command: SetCutJobPdfTemplateCommand): Promise<CutJobDto>;
  setName(command: SetCutJobNameCommand): Promise<CutJobDto>;
  setGroupPdfTemplate(command: SetCutGroupPdfTemplateCommand): Promise<CutJobDto>;
  getJob(query: GetCutJobQuery): Promise<CutJobDto>;
  listResults(query: ListCutResultsQuery): Promise<CutResultSummaryDto[]>;
  getResult(query: GetCutResultQuery): Promise<CutResultDto>;
  setCurrentResult(command: CutResultStateCommand): Promise<CutJobDto>;
  archiveResult(command: CutResultStateCommand): Promise<CutJobDto>;
  unarchiveResult(command: CutResultStateCommand): Promise<CutJobDto>;
  listJobs(query: ListCutJobsQuery): Promise<CutJobDto[]>;
  listEligibleDetails(query: EligibleDetailsQuery): Promise<EligibleDetailsResponseDto>;
  listFilmOptionsForCut(query: ListFilmOptionsForCutQuery): Promise<CutFilmOptionDto[]>;
  listDetailPlacements(query: DetailPlacementsQuery): Promise<CutDetailPlacementsResponseDto>;
  listDetailLastReady(query: DetailLastReadyQuery): Promise<CutDetailLastReadyResponseDto>;
  renderSheetPng(query: RenderSheetPngQuery): Promise<Buffer>;
  renderSheetSvg(query: RenderSheetSvgQuery): Promise<string>;
  renderGroupPdf(query: RenderGroupPdfQuery): Promise<Buffer>;
  renderJobPdf(query: RenderJobPdfQuery): Promise<Buffer>;
  setPdfPrewarmState(query: SetPdfPrewarmStateQuery): Promise<void>;
  listSheetTypesForCut(query: ListSheetTypesForCutQuery): Promise<CutSheetTypeOption[]>;
  // ── Task 4: manual-layout read/persist ──────────────────────────────────
  getManualLayoutByKey(
    cutJobId: number,
    groupKey: string,
  ): Promise<{ sheets: CutManualSheetDto[]; isActive: boolean; isStale: boolean; version: number } | null>;
  upsertManualLayout(args: {
    cutJobId: number;
    groupKey: string;
    sheets: CutManualSheetDto[];
    active: boolean;
    basedOnJobVersion: number;
    createdBy: number | null;
  }): Promise<void>;
  listManualLayoutsForJob(
    cutJobId: number,
  ): Promise<Array<{ groupKey: string; sheets: CutManualSheetDto[]; isActive: boolean; isStale: boolean; version: number }>>;
  // ── Task 5: manual-layout save command ───────────────────────────────────
  saveManualLayout(command: SaveManualLayoutCommand): Promise<CutJobDto>;
  // ── Task 7: render variant + render state token ─────────────────────────
  /** Returns an opaque server-owned token that changes whenever the rendered
   *  output would change (job version + per-group manual layout version +
   *  effectiveActive). Used by clients as a renderVersion URL discriminator;
   *  current PDF exports render fresh and do not serve cached PDF bytes. */
  getRenderCacheToken(args: GetRenderCacheTokenArgs): Promise<string>;
}
