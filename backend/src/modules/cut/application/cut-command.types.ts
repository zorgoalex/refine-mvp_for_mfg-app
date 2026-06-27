import type { CurrentUser } from '../../../permissions/current-user';
import type {
  AddCutItemsRequestDto,
  CreateCutJobRequestDto,
  CutDetailLastReadyResponseDto,
  CutDetailPlacementsResponseDto,
  CutJobDto,
  EligibleDetailsResponseDto,
  CutSelectionCriteriaDto,
} from '../dto/cut.dto';

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
  requestId?: string;
}

export interface ArchiveCutJobCommand {
  currentUser: CurrentUser;
  cutJobId: number;
  version: number;
  requestId?: string;
}

export interface GetCutJobQuery {
  currentUser: CurrentUser;
  cutJobId: number;
  requestId?: string;
}

export interface ListCutJobsQuery {
  currentUser: CurrentUser;
  filters?: { status?: string; createdBy?: number };
  requestId?: string;
}

export interface EligibleDetailsQuery {
  currentUser: CurrentUser;
  criteria: CutSelectionCriteriaDto;
  requestId?: string;
}

export interface RenderSheetPngQuery {
  currentUser: CurrentUser;
  cutGroupId: number;
  sheetIndex: number;
  /** render preset NAME; px resolved from cut_render_presets config at render time */
  preset: string;
  /** landscape orientation: rotate the layout 90° (long side horizontal). */
  rotate90?: boolean;
  requestId?: string;
}

export interface RenderSheetSvgQuery {
  currentUser: CurrentUser;
  cutGroupId: number;
  sheetIndex: number;
  /** landscape orientation: rotate the layout 90° (long side horizontal). */
  rotate90?: boolean;
  requestId?: string;
}

export interface RenderGroupPdfQuery {
  currentUser: CurrentUser;
  cutGroupId: number;
  /** landscape orientation: rotate the layout 90° (long side horizontal). */
  rotate90?: boolean;
  requestId?: string;
}

export interface RenderJobPdfQuery {
  currentUser: CurrentUser;
  cutJobId: number;
  /** landscape orientation: rotate the layout 90° (long side horizontal). */
  rotate90?: boolean;
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

export interface CutRepositoryPort {
  createJob(command: CreateCutJobCommand): Promise<CutJobDto>;
  recordPermissionDenied(input: CutPermissionDeniedInput): Promise<void>;
  addItems(command: AddCutItemsCommand): Promise<CutJobDto>;
  removeItem(command: RemoveCutItemCommand): Promise<CutJobDto>;
  calculate(command: CalculateCutJobCommand): Promise<CutJobDto>;
  archive(command: ArchiveCutJobCommand): Promise<CutJobDto>;
  setProfile(command: SetCutJobProfileCommand): Promise<CutJobDto>;
  setSheetMaterial(command: SetCutJobSheetMaterialCommand): Promise<CutJobDto>;
  setCombineFilms(command: SetCutJobCombineFilmsCommand): Promise<CutJobDto>;
  getJob(query: GetCutJobQuery): Promise<CutJobDto>;
  listJobs(query: ListCutJobsQuery): Promise<CutJobDto[]>;
  listEligibleDetails(query: EligibleDetailsQuery): Promise<EligibleDetailsResponseDto>;
  listDetailPlacements(query: DetailPlacementsQuery): Promise<CutDetailPlacementsResponseDto>;
  listDetailLastReady(query: DetailLastReadyQuery): Promise<CutDetailLastReadyResponseDto>;
  renderSheetPng(query: RenderSheetPngQuery): Promise<Buffer>;
  renderSheetSvg(query: RenderSheetSvgQuery): Promise<string>;
  renderGroupPdf(query: RenderGroupPdfQuery): Promise<Buffer>;
  renderJobPdf(query: RenderJobPdfQuery): Promise<Buffer>;
  setPdfPrewarmState(query: SetPdfPrewarmStateQuery): Promise<void>;
  listSheetTypesForCut(query: ListSheetTypesForCutQuery): Promise<CutSheetTypeOption[]>;
}
