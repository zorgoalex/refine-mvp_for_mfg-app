import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import {
  type PieceLabelSnapshot,
  type AutoPieceSpec,
  type AutoSheetSpec,
  type GapParams,
  type GeomSheet,
  type ManualViolation,
  calculateBathSheetFilmUsage,
  manualSetMatchesAuto,
  reconstructManualSheets,
  shouldShowBathMeterGuides,
  validateSheetPlacements,
  validateSheetGroupInvariant,
} from '../../../shared/cut-geometry';
import {
  CUT_RENDER_STYLE_DEFAULT,
  type CutRenderStyleName,
} from '../../../shared/cut-render-style';
import { buildCutAuditEvent, buildCutDeniedEvent, CUT_AUDIT_EVENTS, type CutAuditActor } from '../application/cut-audit';
import {
  cutJobSnapshotUsesVacuumTable,
  formatCutJobNumber,
  formatCutNumber,
} from '../application/cut-numbering';
import {
  classifyDetailEligibility,
  type DetailEligibilityCandidate,
} from '../application/cut-eligibility';
import {
  assertWithinBodyLimit,
  assertWithinInstanceLimit,
  backMapSolutions,
  buildOptimizeRequest,
  buildOptimizeRequestWithWarnings,
  freecutItemId,
  NATIVE_PORTRAIT_COORDINATE_CONTRACT,
  parseFreecutItemId,
  type FreecutItem,
  type FreecutParams,
  type FreecutPlacement,
  type SheetPlacementsJson,
  validateFreecutResponseContract,
} from '../application/cut-freecut-mapping';
import { applyEngineSelection } from '../application/cut-engine-selection';
import { computeSelectedSheetFitWarnings } from '../application/cut-sheet-fit-warning';
import { computeRequestHash } from '../application/cut-request-hash';
import {
  describeCutFailure,
  extractCutFailureStatus,
  shouldMarkCutFailed,
} from '../application/cut-failure-reason';
import { ApiError } from '../../../common/errors/api-error';
import { type CutConfigPort, type CutGrainRules } from '../application/cut-config';
import { PgCutConfigRepository } from './pg-cut-config-repository';
import { resolveCalcParams } from './resolve-calc-params';
import type {
  AddCutItemsCommand,
  ArchiveCutJobCommand,
  CalculateCutJobCommand,
  CreateCutJobCommand,
  CutRepositoryPort,
  CutResultStateCommand,
  DetailLastReadyQuery,
  DetailPlacementsQuery,
  EligibleDetailsQuery,
  ListFilmOptionsForCutQuery,
  GetCutJobDeleteImpactQuery,
  GetCutJobQuery,
  GetCutResultQuery,
  GetRenderCacheTokenArgs,
  ListCutJobsQuery,
  ListCutResultsQuery,
  RemoveCutItemCommand,
  RenderGroupPdfQuery,
  RenderJobPdfQuery,
  RenderSheetPngQuery,
  RenderSheetSvgQuery,
  SaveManualLayoutCommand,
  SetCutJobProfileCommand,
  SetCutJobSheetMaterialCommand,
  SetCutJobCombineFilmsCommand,
  SetCutJobPdfTemplateCommand,
  SetCutJobNameCommand,
  SetCutJobSplitByMaterialCommand,
  SetCutJobRotationAllowedCommand,
  SetCutJobTextureDirectionCommand,
  SetCutGroupPdfTemplateCommand,
  SetPdfPrewarmStateQuery,
} from '../application/cut-command.types';
import type {
  CutDetailInfoDto,
  CutDetailLastReadyResponseDto,
  CutDetailPlacementsResponseDto,
  CutFilmOptionDto,
  CutFilmUsageDto,
  CutEditorParamsDto,
  CutGroupDto,
  CutJobDeleteImpactDto,
  CutJobLinkedMdfPacketDto,
  CutJobItemDto,
  CutJobDto,
  CutJobRefDto,
  CutJobTotals,
  CutTextureDirection,
  CutResultDto,
  CutResultKind,
  CutResultSummaryDto,
  CutManualLayoutDto,
  CutManualSheetDto,
  CutSheetRenderSnapshotDto,
  EligibleDetailDto,
  EligibleDetailsResponseDto,
} from '../dto/cut.dto';
import {
  mapTotalsRow,
  roundTo2,
  TOTALS_FROZEN_ITEMS_BY_JOB_SQL,
  TOTALS_BY_JOB_SQL,
  SHEETS_BY_JOB_SQL,
  MATERIAL_NAMES_BY_JOB_SQL,
  type TotalsRow,
} from './cut-totals';
import {
  addBathMeterGuidesToSvg,
  buildBathProfileSheetSvg,
  buildSheetSvg,
  composePieceLabelLines,
  computeGroupItemQuantities,
  createOrderFillResolver,
} from '../render/sheet-svg';
import { renderSheetPng } from '../render/sheet-png';
import {
  buildFrozenSheetsPdf,
  buildSheetsPdf,
  type FrozenPdfRenderContract,
  type PdfSheetDetailRow,
  type PdfSheetInput,
  type PdfSheetMeta,
} from '../render/sheet-pdf';
import {
  CutGroupSheetNotFoundError,
  CutJobItemNotFoundError,
  CutJobNotFoundError,
  CutDetailNotEligibleError,
  CutJobNotMutableError,
  CutNoItemsError,
  CutNoSheetSpecError,
  CutOrderDetailNotFoundError,
  CutParamProfileNotFoundError,
  CutOptimizerInvalidGeometryError,
  CutSheetMaterialNotCuttableError,
  CutStaleVersionError,
} from '../errors/cut.errors';
import type { LabelCustomExpressionScalar } from '../../labels/application/label-custom-field-expression';

const AUDIT_SOURCE = 'backend-cut-command';

/**
 * Ready-to-cut statuses and the default freecut params are sourced from the
 * editable `cut_config` tables (migration 023) via {@link CutConfigPort}, with a
 * documented in-code fallback when the config is empty (see cut-config.ts).
 */

/**
 * Reservation is active (and the job mutable) only in these states. `failed` is
 * mutable so an operator can fix the basket and RE-RUN the calculation on the
 * same job instead of being forced to create a new one (a failed calc persists
 * no groups but keeps its reserved items). `archived` stays terminal.
 */
const MUTABLE_STATUSES = new Set(['draft', 'calculating', 'ready', 'failed']);

/** Profile selection is editable while the basket can still be (re)calculated,
 *  but NOT mid-calculation (the running solve already locked its params) and not
 *  on an archived job. */
const PROFILE_EDITABLE_STATUSES = new Set(['draft', 'ready', 'failed']);

interface RenderDetailInfo {
  orderId: number;
  orderDeleted: boolean;
  detailNumber: number | null;
  widthMm: number | null;
  heightMm: number | null;
  detailFields: Record<string, unknown> | null;
  doweling: boolean | null;
  machineFiles: string[];
  materialName: string | null;
  thicknessMm: number | null;
  filmName: string | null;
  millingTypeName: string | null;
  edgeTypeName: string | null;
  productionStatusName: string | null;
  orderName: string | null;
  orderDate: string | null;
  readyDate: string | null;
  clientName: string | null;
  materialKey: string | null;
}

interface RenderedSheetContext {
  sheetIndex: number;
  placements: SheetPlacementsJson;
  svg: string;
  bathSvg: string;
  pdfMeta: PdfSheetMeta;
  pdfDetailRows: PdfSheetDetailRow[];
  filmRequirementLinearMeters: number | null;
}

interface PdfRenderIdentity {
  cutJobId: number | null;
  cutNumber: string | null;
  currentCutNumber: string | null;
}

interface PdfRenderJobFields {
  jobName: string;
  textureDirection: string;
}

/** Related audit dimensions when a Phase 1 failure has not yet resolved groups. */
interface CalcRelatedDimensions {
  orderIds: number[];
  sheetMaterialTypeIds: number[];
}
const EMPTY_RELATED: CalcRelatedDimensions = { orderIds: [], sheetMaterialTypeIds: [] };

interface FreecutClientLike {
  optimize: (
    request: ReturnType<typeof buildOptimizeRequest>,
  ) => Promise<import('../application/cut-freecut-mapping').FreecutOptimizeResponse>;
}


interface CutJobLockRow extends QueryResultRow {
  cut_job_id: string | number;
  name: string;
  status: string;
  source: string;
  version: string | number;
  pdf_prewarm_state: string;
  params: Record<string, unknown> | null;
  param_profile_id: string | number | null;
  sheet_material_type_id: string | number | null;
  pdf_template_code: string | null;
  combine_films: boolean | null;
  split_by_material: boolean | null;
  rotation_allowed: boolean | null;
  texture_direction: string | null;
}

interface CutResultRow extends QueryResultRow {
  cut_result_id: string | number;
  cut_job_id: string | number;
  source_display_number?: string | number | null;
  result_no: string | number;
  revision_no: string | number;
  result_kind: CutResultKind;
  source_job_version: string | number;
  based_on_result_id: string | number | null;
  snapshot_job: CutJobDto;
  totals_snapshot: CutJobTotals;
  created_by: string | number | null;
  created_by_name_snapshot: string | null;
  created_at: Date | string;
  is_current: boolean;
  archived_at: Date | string | null;
  archived_by: string | number | null;
}

interface ReleasedCutJobItemRow extends QueryResultRow {
  order_id: string | number;
  order_detail_id: string | number;
  sheet_material_type_id: string | number | null;
}

interface DeleteImpactItemRow extends QueryResultRow {
  order_id: string | number;
  order_detail_id: string | number;
}

interface DeleteImpactPacketRow extends QueryResultRow {
  packet_id: string;
  external_packet_key: string;
  workday: string | Date;
  machine: string | null;
  program_name: string | null;
  item_count: string | number;
}

const CUT_RESULT_LEASE_MS = 15 * 60 * 1000;

interface CalcItemRow extends QueryResultRow {
  cut_job_item_id: string | number;
  order_detail_id: string | number;
  order_id: string | number;
  qty: string | number;
  width_mm: string | number;
  height_mm: string | number;
  detail_number: string | number | null;
  material_id?: string | number | null;
  sheet_material_type_id: string | number | null;
  film_id: string | number | null;
  film_texture: boolean | null;
  smt_width_mm: string | number | null;
  smt_height_mm: string | number | null;
}

// ── Manual-layout helpers (Task 4) ──────────────────────────────────────────

/**
 * Stable text key encoding the grouping mode for a cut group. Written to
 * `cut_group.group_key` at calculate time and used to match manual layouts
 * across recalculations.
 *
 * Encoding:
 *   !splitByMaterial+combineFilms → 'all'
 *   !splitByMaterial+!combineFilms → 'all|f:<filmId|null>'
 *   splitByMaterial+combineFilms → 'm:<smtId|null>|f:all'
 *   else                       → 'm:<smtId|null>|f:<filmId|null>'
 */
export function logicalGroupKey(g: {
  splitByMaterial: boolean;
  combineFilms: boolean;
  sheetMaterialTypeId: number | null;
  filmId: number | null;
}): string {
  if (!g.splitByMaterial) return g.combineFilms ? 'all' : `all|f:${g.filmId ?? 'null'}`;
  if (g.combineFilms) return `m:${g.sheetMaterialTypeId ?? 'null'}|f:all`;
  return `m:${g.sheetMaterialTypeId ?? 'null'}|f:${g.filmId ?? 'null'}`;
}

interface BasisInputItem {
  orderDetailId: number;
  qty: number;
  widthMm: number;
  heightMm: number;
  sheetMaterialTypeId: number | null;
  filmId: number | null;
  filmTexture: boolean | null;
}
interface BasisSheetType {
  sheetMaterialTypeId: number;
  widthMm: number;
  heightMm: number;
}
interface BasisInputs {
  params: import('../application/cut-freecut-mapping').FreecutParams;
  grainRules: import('../application/cut-config').CutGrainRules;
  combineFilms: boolean;
  splitByMaterial: boolean;
  rotationAllowed: boolean;
  sheetOverride: { sheetMaterialTypeId: number; widthMm: number; heightMm: number } | null;
  items: BasisInputItem[];
  sheetTypes: BasisSheetType[];
}

export const VACUUM_ROUTING_CONTRACT_VERSION = 'vacuum_profile_routing_v2';

export function routingContractForCalcBasis(
  params: import('../application/cut-freecut-mapping').FreecutParams,
): string | null {
  return params.layout_mode === 'vacuum_table'
    ? VACUUM_ROUTING_CONTRACT_VERSION
    : null;
}

/**
 * Stable SHA-256 hash of all calc-relevant inputs. Same inputs → same hash;
 * any structural change flips it → requiresRecalc=true.
 * Hashes: resolved params, grain rules, combineFilms, splitByMaterial,
 * sheet-override dims (NOT is_cuttable), per-detail cut fields incl. qty
 * (NOT note, NOT updated_at), used sheet-type dims only (NOT is_cuttable).
 * Items and sheetTypes are sorted by id for determinism.
 */
function basisOf(inputs: BasisInputs): string {
  const routingContract = routingContractForCalcBasis(inputs.params);
  const canonical = {
    ...(routingContract === null ? {} : { routing: routingContract }),
    p: inputs.params,
    g: inputs.grainRules,
    cf: inputs.combineFilms,
    sbm: inputs.splitByMaterial,
    ra: inputs.rotationAllowed,
    so: inputs.sheetOverride,
    items: [...inputs.items]
      .sort((a, b) => a.orderDetailId - b.orderDetailId)
      .map((i) => ({ id: i.orderDetailId, q: i.qty, w: i.widthMm, h: i.heightMm, smt: i.sheetMaterialTypeId, f: i.filmId, ft: i.filmTexture })),
    smts: [...inputs.sheetTypes]
      .sort((a, b) => a.sheetMaterialTypeId - b.sheetMaterialTypeId)
      .map((s) => ({ id: s.sheetMaterialTypeId, w: s.widthMm, h: s.heightMm })),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Idempotency key for the profile-changed outbox event. Stable for a given
 *  (job, request) so a transport-level duplicate of the SAME request can't emit
 *  two events; falls back to the version when no requestId is supplied. */
export function profileChangedOutboxKey(cutJobId: number, requestId: string | undefined, version: number): string {
  return `${CUT_AUDIT_EVENTS.profileChanged}:${cutJobId}:${requestId ?? `v${version}`}`;
}

/** Idempotency key for the sheet-material-changed outbox event. Same stability
 *  rule as profileChangedOutboxKey: stable per (job, request), version fallback. */
export function sheetMaterialChangedOutboxKey(cutJobId: number, requestId: string | undefined, version: number): string {
  return `${CUT_AUDIT_EVENTS.sheetMaterialChanged}:${cutJobId}:${requestId ?? `v${version}`}`;
}

/** Idempotency key for the combine-films-changed outbox event. Same stability
 *  rule as sheetMaterialChangedOutboxKey: stable per (job, request), version fallback. */
export function combineFilmsChangedOutboxKey(cutJobId: number, requestId: string | undefined, version: number): string {
  return `${CUT_AUDIT_EVENTS.combineFilmsChanged}:${cutJobId}:${requestId ?? `v${version}`}`;
}

/** Idempotency key for the split-by-material-changed outbox event. Same stability
 *  rule: stable per (job, request), version fallback. */
export function splitByMaterialChangedOutboxKey(cutJobId: number, requestId: string | undefined, version: number): string {
  return `${CUT_AUDIT_EVENTS.splitByMaterialChanged}:${cutJobId}:${requestId ?? `v${version}`}`;
}

/** Idempotency key for the rotation-allowed-changed outbox event. Same stability
 *  rule: stable per (job, request), version fallback. */
export function rotationAllowedChangedOutboxKey(cutJobId: number, requestId: string | undefined, version: number): string {
  return `${CUT_AUDIT_EVENTS.rotationAllowedChanged}:${cutJobId}:${requestId ?? `v${version}`}`;
}

/** Idempotency key for the texture-direction-changed outbox event. Same
 *  stability rule: stable per (job, request), version fallback. */
export function textureDirectionChangedOutboxKey(cutJobId: number, requestId: string | undefined, version: number): string {
  return `${CUT_AUDIT_EVENTS.textureDirectionChanged}:${cutJobId}:${requestId ?? `v${version}`}`;
}

/** Idempotency key for cut-job rename events. Stable per (job, request), version fallback. */
export function nameChangedOutboxKey(cutJobId: number, requestId: string | undefined, version: number): string {
  return `${CUT_AUDIT_EVENTS.nameChanged}:${cutJobId}:${requestId ?? `v${version}`}`;
}

/** Idempotency key for the manual-layout-saved outbox event. Keyed by the
 *  POST-BUMP job version (nextVersion) — NOT by requestId — so each distinct
 *  save produces exactly one outbox row (Codex R11 MAJOR #4). requestId rides
 *  only in the payload for relay dedupe/trace. */
export function manualLayoutSavedOutboxKey(cutJobId: number, nextVersion: number): string {
  return `${CUT_AUDIT_EVENTS.manualLayoutSaved}:${cutJobId}:v${nextVersion}`;
}

export interface CutResultAllocation {
  resultNo: number;
  revisionNo: number;
  basedOnResultId: number | null;
  nextResultNo: number;
  reusesCurrentManualVersion: boolean;
}

/**
 * Allocate one operator-visible result number.
 *
 * Manual saves revise the current manual result without consuming another
 * public number. Every revision is still an immutable cut_result row, so frozen
 * PDFs, label maps, command dedupe, and audit links keep their original bytes.
 */
export function planCutResultAllocation(input: {
  nextResultNo: number;
  reuseCurrentManualVersion: boolean;
  current: {
    cutResultId: number;
    resultNo: number;
    revisionNo: number;
    resultKind: CutResultKind;
    basedOnResultId: number | null;
  } | null;
}): CutResultAllocation {
  const reuse = input.reuseCurrentManualVersion && input.current?.resultKind === 'manual';
  if (reuse && input.current) {
    return {
      resultNo: input.current.resultNo,
      revisionNo: input.current.revisionNo + 1,
      basedOnResultId: input.current.basedOnResultId,
      nextResultNo: input.nextResultNo,
      reusesCurrentManualVersion: true,
    };
  }
  return {
    resultNo: input.nextResultNo,
    revisionNo: 1,
    basedOnResultId: input.current?.cutResultId ?? null,
    nextResultNo: input.nextResultNo + 1,
    reusesCurrentManualVersion: false,
  };
}

/**
 * Stable key-sorted JSON of CutManualSheetDto[] for no-op comparison.
 * Required because PostgreSQL JSONB normalises key order on round-trip, so
 * JSON.stringify of a DB-read object differs from a freshly-computed object
 * with the same values but insertion-order keys.
 */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_key, x: unknown) => {
    if (x !== null && typeof x === 'object' && !Array.isArray(x)) {
      return Object.fromEntries(
        Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return x;
  });
}

function frozenRenderViewKey(view: {
  rotate90?: boolean;
  originTopLeft?: boolean;
  axisOrigin?: 'top-left' | 'bottom-left';
  showLabels?: boolean;
}): string {
  const rotate90 = view.rotate90 === true;
  return [
    rotate90 ? 'r90' : 'r0',
    rotate90 && view.originTopLeft === true ? 'tl' : 'raw',
    view.axisOrigin ?? 'top-left',
    view.showLabels === false ? 'labels-off' : 'labels-on',
  ].join(':');
}

function frozenPieceLabelLines(
  piece: FreecutPlacement,
  itemByItemId: ReadonlyMap<string, CutJobItemDto>,
  quantities: ReadonlyMap<string, number>,
): string[] {
  const item = itemByItemId.get(piece.item_id);
  const label = (piece as { label?: PieceLabelSnapshot }).label;
  const detailId = parseFreecutItemId(piece.item_id);
  return composePieceLabelLines({
    orderId: label?.orderId ?? item?.orderId ?? null,
    orderName: label?.orderName ?? item?.orderName ?? null,
    detailId: label?.detailId ?? detailId,
    detailNumber: label?.detailNumber ?? item?.detail?.detailNumber ?? null,
    widthMm: label?.widthMm ?? item?.detail?.width ?? null,
    heightMm: label?.heightMm ?? item?.detail?.height ?? null,
    itemId: piece.item_id,
    instance: piece.instance,
    qty: quantities.get(piece.item_id) ?? item?.qty ?? 1,
    materialName: label?.materialName ?? null,
  });
}

const FROZEN_RENDER_VIEW_COUNT = 12;

function sheetsMatchCanonical(existing: import('../dto/cut.dto').CutManualSheetDto[], canonical: import('../dto/cut.dto').CutManualSheetDto[]): boolean {
  return stableJson(existing) === stableJson(canonical);
}

// ── Task 7: variant helpers ───────────────────────────────────────────────────

/**
 * Resolve the *effective* render variant from the requested variant and the
 * current manual layout state.
 *
 * - `auto`   → always auto (use `cut_group_sheet`).
 * - `manual` → manual ONLY when a layout is present AND not stale; else auto.
 *              The caller MUST hard-fail (409) when an explicit `manual` request
 *              resolves to `auto` — there is NO silent auto fallback for `manual`.
 *              (`is_active` is NOT required: an explicit manual request prints the
 *              stored manual layout regardless of the active-selector flag.)
 * - `active` → manual iff `effectiveActive = isActive && !isStale`; else auto
 *              (this is the ONLY variant that legitimately falls back to auto).
 *
 * Returning a plain `'auto' | 'manual'` (the actual sheet source) keeps the
 * unavailable-manual decision in one place: a `manual` request that yields
 * `'auto'` here means the manual layout is missing or stale → the caller 409s.
 */
export function resolveEffectiveVariant(
  variant: 'auto' | 'manual' | 'active',
  manual: { isActive: boolean; isStale: boolean } | null,
): 'auto' | 'manual' {
  if (variant === 'auto') return 'auto';
  // A present, non-stale layout is required to render manual sheets at all.
  const usable = manual !== null && !manual.isStale;
  if (variant === 'manual') return usable ? 'manual' : 'auto';
  // active: additionally requires the layout to be the active one.
  return usable && manual.isActive ? 'manual' : 'auto';
}

export function resolvePdfTemplateSelection(
  requestedTemplate: string | undefined,
  frozenTemplate: string | undefined,
): { code: string; requiresActiveCheck: boolean; usesCurrentLayout: boolean } {
  if (requestedTemplate !== undefined) {
    return {
      code: requestedTemplate,
      // Preserve an archived snapshot's original template even if it was later
      // deactivated. Any actual override must resolve to an active template.
      requiresActiveCheck: frozenTemplate === undefined || requestedTemplate !== frozenTemplate,
      // An explicit preview selection always means “render with the current
      // saved layout”, including historical results whose geometry stays frozen.
      usesCurrentLayout: true,
    };
  }
  if (frozenTemplate !== undefined) {
    return { code: frozenTemplate, requiresActiveCheck: false, usesCurrentLayout: false };
  }
  return { code: 'standard', requiresActiveCheck: true, usesCurrentLayout: true };
}

export class PgCutRepository implements CutRepositoryPort {
  private readonly config: CutConfigPort;
  private readonly nativePortraitWriter: boolean;
  private readonly heuristicAutoThresholdInstances: number;

  constructor(
    private readonly database: DatabaseService,
    private readonly freecut: FreecutClientLike,
    config?: CutConfigPort,
    options?: { nativePortraitWriter?: boolean; heuristicAutoThresholdInstances?: number },
  ) {
    this.config = config ?? new PgCutConfigRepository(database);
    this.nativePortraitWriter = options?.nativePortraitWriter === true;
    this.heuristicAutoThresholdInstances = options?.heuristicAutoThresholdInstances ?? 100;
  }

  async reconcileExpiredCommands(limit = 50): Promise<number> {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
    return this.database.transaction(async (tx) => {
      const expired = await tx.query<{
        cut_job_id: string | number;
        command_id: string;
        claimed_job_version: string | number | null;
      }>(
        `SELECT c.cut_job_id, c.command_id, c.claimed_job_version
         FROM cut_result_command c
         JOIN cut_job j ON j.cut_job_id = c.cut_job_id
         WHERE c.command_type = 'calculate' AND c.status = 'in_progress'
           AND c.lease_expires_at <= now()
         ORDER BY c.lease_expires_at, c.cut_job_id
         LIMIT $1
         FOR UPDATE OF c, j SKIP LOCKED`,
        [boundedLimit],
      );
      for (const row of expired.rows) {
        await tx.query(
          `UPDATE cut_result_command
           SET status = 'failed', failure_code = 'CUT_RESULT_COMMAND_ABANDONED',
               owner_token = NULL, lease_expires_at = NULL,
               heartbeat_at = now(), completed_at = now()
           WHERE cut_job_id = $1 AND command_id = $2::uuid AND status = 'in_progress'`,
          [toNum(row.cut_job_id), row.command_id],
        );
        if (row.claimed_job_version !== null) {
          await tx.query(
            `UPDATE cut_job
             SET status = 'failed', failure_code = 'CUT_RESULT_COMMAND_ABANDONED',
                 failure_reason = 'Предыдущий процесс расчёта был прерван', updated_at = now()
             WHERE cut_job_id = $1 AND status = 'calculating' AND version = $2`,
            [toNum(row.cut_job_id), toNum(row.claimed_job_version)],
          );
        }
      }
      return expired.rows.length;
    });
  }

  /** Audited RBAC denial (plan §11). Best-effort for generic denials (fire-and-
   *  forget); for save-manual-layout denials the service AWAITS this call before
   *  throwing 403 (to ensure bridge rows are committed). Uses the audit service's
   *  own pool connection (no surrounding tx needed).
   *
   *  Enrichment: when `cutGroupId` is present, verifies the group belongs to the
   *  job and resolves its distinct order ids → emits `cut_group` + `order` bridge
   *  rows on the `cut_job.permission_denied` audit row. On group mismatch only the
   *  cutJobId bridge (no group rows) is written. */
  async recordPermissionDenied(input: import('../application/cut-command.types').CutPermissionDeniedInput): Promise<void> {
    const actor: CutAuditActor = {
      id: input.currentUser.id,
      username: input.currentUser.username,
      role: input.currentUser.role,
    };

    let related: { cutGroupIds?: number[]; orderIds?: number[] } | undefined;
    let metadata: Record<string, unknown> | undefined;

    if (input.cutGroupId != null && input.cutJobId != null) {
      // Verify the cut_group belongs to cut_job; if so, resolve its order ids.
      const groupCheck = await this.database.query<{ cut_group_id: string | number }>(
        `SELECT cut_group_id FROM cut_group WHERE cut_group_id = $1 AND cut_job_id = $2`,
        [input.cutGroupId, input.cutJobId],
      );
      if (groupCheck.rows.length > 0) {
        const orderRes = await this.database.query<{ order_id: string | number }>(
          `SELECT DISTINCT order_id FROM cut_job_item WHERE cut_group_id = $1 AND is_active = true`,
          [input.cutGroupId],
        );
        const orderIds = orderRes.rows.map((r) => toNum(r.order_id));
        related = { cutGroupIds: [input.cutGroupId], orderIds };
      }
      // Enrich metadata for the save denial (always, when cutGroupId is present).
      metadata = { ...(input.metadata ?? {}), permission: 'cut.manage', action: 'manual_layout_save' };
    }

    await auditService.recordDenied(
      this.database,
      buildCutDeniedEvent({
        cutJobId: input.cutJobId ?? 0,
        actor,
        requestId: input.requestId ?? AUDIT_SOURCE,
        source: AUDIT_SOURCE,
        reason: 'permission_denied',
        requiredPermissions: input.requiredPermissions,
        related,
        metadata,
      }),
    );
  }

  createJob(command: CreateCutJobCommand): Promise<CutJobDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      // Snapshot the freecut params at creation (config-as-data, plan §4a): a
      // config edit after the draft exists must NOT retro-mutate this job. The
      // snapshot is the authoritative payload at calculate time.
      const paramsSnapshot = await this.config.getDefaultParams();
      const inserted = await tx.query<{ cut_job_id: string | number }>(
        `
        INSERT INTO cut_job (name, source, selection_criteria, params, created_by)
        VALUES ($1, 'manual', $2::jsonb, $3::jsonb, $4)
        RETURNING cut_job_id
        `,
        [
          command.dto.name,
          command.dto.criteria ? JSON.stringify(command.dto.criteria) : null,
          JSON.stringify(paramsSnapshot),
          numOrNull(command.currentUser.id),
        ],
      );
      const cutJobId = toNum(inserted.rows[0].cut_job_id);

      const readyStatusIds = await this.resolveReadyStatusIds();
      const reservedOrderIds: number[] = [];
      const reservedSheetTypeIds: number[] = [];
      let insertedCount = 0;
      for (const detailId of command.dto.detailIds ?? []) {
        const { orderId, sheetMaterialTypeId, inserted } = await this.reserveDetail(tx, cutJobId, detailId, readyStatusIds);
        if (inserted) {
          reservedOrderIds.push(orderId);
          if (sheetMaterialTypeId !== null) reservedSheetTypeIds.push(sheetMaterialTypeId);
          insertedCount += 1;
        }
      }

      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.created,
        cutJobId,
        requestId: command.requestId,
        related: { orderIds: reservedOrderIds, sheetMaterialTypeIds: reservedSheetTypeIds },
        metadata: { detailCount: insertedCount },
      });

      return loadJob(tx, cutJobId);
    });
  }

  addItems(command: AddCutItemsCommand): Promise<CutJobDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const job = await loadJobForUpdate(tx, command.cutJobId);
      assertVersion(job, command.version);
      assertMutable(job);

      const readyStatusIds = await this.resolveReadyStatusIds();
      const reservedOrderIds: number[] = [];
      const reservedSheetTypeIds: number[] = [];
      const insertedDetailIds: number[] = [];
      for (const detailId of command.dto.detailIds) {
        const { orderId, sheetMaterialTypeId, inserted } = await this.reserveDetail(tx, command.cutJobId, detailId, readyStatusIds);
        if (inserted) {
          reservedOrderIds.push(orderId);
          if (sheetMaterialTypeId !== null) reservedSheetTypeIds.push(sheetMaterialTypeId);
          insertedDetailIds.push(detailId);
        }
      }

      // No NEW rows (every requested detail was already in this job): no-op — skip the
      // version bump and the itemAdded audit so a same-job re-add neither churns the
      // optimistic version nor writes a misleading audit row (Critic AUDIT-DEBT).
      if (insertedDetailIds.length === 0) {
        return loadJob(tx, command.cutJobId);
      }

      await bumpVersion(tx, command.cutJobId);
      await this.invalidateManualLayoutsForJob(tx, command.cutJobId, 'items_added');
      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.itemAdded,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        related: { orderIds: reservedOrderIds, sheetMaterialTypeIds: reservedSheetTypeIds },
        metadata: { detailIds: insertedDetailIds },
      });

      return loadJob(tx, command.cutJobId);
    });
  }

  removeItem(command: RemoveCutItemCommand): Promise<CutJobDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const job = await loadJobForUpdate(tx, command.cutJobId);
      assertVersion(job, command.version);
      assertMutable(job);

      const released = await tx.query<{ order_id: string | number; order_detail_id: string | number; sheet_material_type_id: string | number | null }>(
        `
        UPDATE cut_job_item cji
        SET is_active = false, updated_at = now()
        FROM order_details od
        WHERE cji.cut_job_item_id = $1 AND cji.cut_job_id = $2 AND cji.is_active = true
          AND od.detail_id = cji.order_detail_id
        RETURNING cji.order_id, cji.order_detail_id, od.sheet_material_type_id
        `,
        [command.cutJobItemId, command.cutJobId],
      );
      if (released.rowCount === 0) {
        throw new CutJobItemNotFoundError(command.cutJobItemId);
      }
      const removedRow = released.rows[0];
      const removedSheetTypeId = removedRow.sheet_material_type_id === null ? null : toNum(removedRow.sheet_material_type_id);

      await bumpVersion(tx, command.cutJobId);
      await this.invalidateManualLayoutsForJob(tx, command.cutJobId, 'item_removed');
      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.itemRemoved,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        related: {
          orderIds: [toNum(removedRow.order_id)],
          sheetMaterialTypeIds: removedSheetTypeId !== null ? [removedSheetTypeId] : [],
        },
        metadata: { cutJobItemId: command.cutJobItemId },
      });

      return loadJob(tx, command.cutJobId);
    });
  }

  async calculate(command: CalculateCutJobCommand): Promise<CutJobDto> {
    const commandPayloadHash = hashCutResultCommand({
      type: 'calculate',
      version: command.version,
    });
    const ownerToken = randomUUID();
    // Phase 1 — read + validate + build request under a short lock (NOT held
    // across the external freecut call). A validation failure here (no items, no
    // sheet spec, instance/body limit) is a calculation outcome too: persist a
    // matching reason so the durable "Ошибка" never lingers stale from a prior
    // attempt (and never mismatches the live toast).
    // Captured as soon as Phase 1 has loaded+grouped the items, so a Phase 1
    // validation failure (no sheet spec / instance|body limit / grain) still
    // audits the affected order/material/sheet dimensions (query/report-ready),
    // not an empty related set. A throw before grouping (empty basket) leaves it
    // empty, which is correct — there are no affected entities to record.
    let phase1Related: CalcRelatedDimensions = EMPTY_RELATED;
    const prep = await this.database
      .transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const job = await loadJobForUpdate(tx, command.cutJobId);

      const priorCommand = await tx.query<{
        command_type: string;
        payload_hash: string;
        status: 'in_progress' | 'completed' | 'failed';
        cut_result_id: string | number | null;
        failure_code: string | null;
        lease_alive: boolean;
        claimed_job_version: string | number | null;
      }>(
        `SELECT command_type, payload_hash, status, cut_result_id, failure_code,
                (lease_expires_at > now()) AS lease_alive, claimed_job_version
         FROM cut_result_command
         WHERE cut_job_id = $1 AND command_id = $2::uuid
         FOR UPDATE`,
        [command.cutJobId, command.commandId],
      );
      const prior = priorCommand.rows[0];
      if (prior) {
        if (prior.command_type !== 'calculate' || prior.payload_hash !== commandPayloadHash) {
          throw new ApiError(409, 'CUT_RESULT_COMMAND_CONFLICT', 'commandId уже использован с другим запросом');
        }
        if (prior.status === 'completed' && prior.cut_result_id !== null) {
          return { kind: 'completed' as const };
        }
        if (prior.status === 'failed') {
          throw new ApiError(409, 'CUT_RESULT_COMMAND_FAILED', 'Команда раскроя уже завершилась ошибкой', {
            failureCode: prior.failure_code,
          });
        }
        if (prior.lease_alive) {
          throw new ApiError(409, 'CUT_RESULT_COMMAND_IN_PROGRESS', 'Расчёт уже выполняется');
        }
        await tx.query(
          `UPDATE cut_result_command
           SET status = 'failed', failure_code = 'CUT_RESULT_COMMAND_ABANDONED',
               owner_token = NULL, completed_at = now(), lease_expires_at = NULL,
               heartbeat_at = now()
           WHERE cut_job_id = $1 AND command_id = $2::uuid`,
          [command.cutJobId, command.commandId],
        );
        await tx.query(
          `UPDATE cut_job
           SET status = 'failed', failure_code = 'CUT_RESULT_COMMAND_ABANDONED',
               failure_reason = 'Предыдущий процесс расчёта был прерван', updated_at = now()
           WHERE cut_job_id = $1 AND status = 'calculating' AND version = $2`,
          [command.cutJobId, numOrNull(prior.claimed_job_version)],
        );
        return { kind: 'abandoned' as const };
      }

      if (job.status === 'calculating') {
        throw new ApiError(409, 'CUT_CALCULATION_IN_PROGRESS', 'Для задания уже выполняется расчёт');
      }

      assertVersion(job, command.version);
      assertMutable(job);

      await tx.query(
        `INSERT INTO cut_result_command
          (cut_job_id, command_id, command_type, payload_hash, status,
            owner_token, lease_expires_at, heartbeat_at, claimed_job_version, created_by)
         VALUES ($1, $2::uuid, 'calculate', $3, 'in_progress',
                 $4::uuid, now() + ($5::bigint * interval '1 millisecond'), now(), $6, $7)`,
        [command.cutJobId, command.commandId, commandPayloadHash, ownerToken, CUT_RESULT_LEASE_MS, job.version + 1, numOrNull(command.currentUser.id)],
      );

      let items = await loadCalcItems(tx, command.cutJobId);
      if (items.length === 0) {
        throw new CutNoItemsError(command.cutJobId);
      }

      // Per-job sheet override (migration 040). Validate it is still active +
      // cuttable (it may have been deactivated after selection) — reject with 422,
      // precondition passthrough (job is NOT marked failed).
      // Variant B: a chosen sheet override ALWAYS forces EVERY detail onto the
      // chosen sheet, regardless of split_by_material. «Разделять по материалу»
      // is irrelevant when an override is present — the whole job is cut on one sheet.
      let sheetOverrideForBasis: { sheetMaterialTypeId: number; widthMm: number; heightMm: number } | null = null;
      if (job.sheetMaterialTypeId !== null) {
        const sheetRes = await tx.query<{ width_mm: string | number; height_mm: string | number }>(
          `SELECT width_mm, height_mm FROM sheet_material_types
           WHERE sheet_material_type_id = $1 AND is_active = true AND is_cuttable = true`,
          [job.sheetMaterialTypeId],
        );
        if (sheetRes.rows.length === 0) {
          throw new CutSheetMaterialNotCuttableError(job.sheetMaterialTypeId);
        }
        const overrideDims = {
          sheetMaterialTypeId: job.sheetMaterialTypeId,
          widthMm: toNum(sheetRes.rows[0].width_mm),
          heightMm: toNum(sheetRes.rows[0].height_mm),
        };
        sheetOverrideForBasis = overrideDims;
        items = applySheetOverride(
          items,
          { sheetMaterialTypeId: overrideDims.sheetMaterialTypeId, widthMm: overrideDims.widthMm, heightMm: overrideDims.heightMm },
          { onlyNoSheetSpec: false },
        );
      }

      // Recalculation: drop the PREVIOUS result set under the lock so a re-cut
      // leaves exactly the new groups, and a failed re-cut (status -> failed in
      // Phase 2) leaves NO groups — never a stale layout mixed into the manifest
      // or PDF. cut_group_sheet cascades; cut_job_item.cut_group_id is FK
      // ON DELETE SET NULL (items stay active/reserved), set explicitly for clarity.
      await tx.query(`UPDATE cut_job_item SET cut_group_id = NULL WHERE cut_job_id = $1 AND cut_group_id IS NOT NULL`, [command.cutJobId]);
      await tx.query(`DELETE FROM cut_group WHERE cut_job_id = $1`, [command.cutJobId]);
      // Hard-invalidate any existing manual layouts NOW (in Phase 1's committed tx)
      // so a Phase-2 freecut failure still leaves them stale+inactive on the failed job.
      await this.invalidateManualLayoutsForJob(tx, command.cutJobId, 'recalc');

      // Multi-material fan-out (plan §6): one cut_group + one freecut call per
      // cuttable key (sheet_material_type_id, film_id). Slice-2 removes the
      // single-group 422 — a mixed-material job fans out to N groups.
      const groups = [...groupByCuttableKey(items, job.combineFilms, job.splitByMaterial).values()];
      phase1Related = {
        orderIds: groups.flatMap((g) => g.orderIds),
        sheetMaterialTypeIds: groups
          .map((g) => g.sheetMaterialTypeId)
          .filter((id): id is number => id !== null),
      };
      // Resolve params from the job's chosen profile, or fall back to the
      // create-time snapshot (or runtime defaults for legacy jobs with no snapshot).
      // A non-null chosen profile that is inactive/missing is REJECTED with 422 —
      // never silently substituted — because the UI shows the chosen profile and
      // substituting surprise params would violate stale-safety. The operator must
      // clear or re-pick an active profile.
      let profileParams: FreecutParams | null = null;
      if (job.paramProfileId !== null) {
        profileParams = await this.config.getParamsByProfileId(job.paramProfileId);
        if (profileParams === null) {
          throw new CutParamProfileNotFoundError(job.paramProfileId);
        }
      }
      const params = resolveCalcParams({
        profileId: job.paramProfileId,
        jobParams: (job.params ?? null) as FreecutParams | null,
        profileParams,
        defaultParams: await this.config.getDefaultParams(),
      });
      const grainRules = await this.config.getGrainRules();

      const groupPreps = groups.map((group) => {
        if (group.sheetMaterialTypeId === null || group.smtWidthMm === null || group.smtHeightMm === null) {
          // A group whose material has no sheet spec cannot be cut; eligibility
          // surfaces this as no_sheet_spec before add, but fail closed here too.
          // Distinct error so the durable reason names the real cause (not "no items").
          throw new CutNoSheetSpecError(command.cutJobId);
        }
        const freecutItems: FreecutItem[] = group.items.map((item) => ({
          id: freecutItemId(item.orderDetailId),
          width_mm: item.widthMm,
          height_mm: item.heightMm,
          qty: item.qty,
          ...(item.filmTexture === true ? grainRules.textured : grainRules.plain),
        }));
        const totalInstances = freecutItems.reduce((sum, item) => sum + item.qty, 0);
        const engineSelection = applyEngineSelection(
          params,
          totalInstances,
          this.heuristicAutoThresholdInstances,
        );
        const optimizeInput = buildOptimizeRequestWithWarnings({
          stock: { id: `smt-${group.sheetMaterialTypeId}`, width_mm: group.smtWidthMm, height_mm: group.smtHeightMm },
          items: freecutItems,
          params: engineSelection.params,
          includeSvg: false,
          nativePortrait: this.nativePortraitWriter,
        });
        const request = optimizeInput.request;
        if (!job.rotationAllowed) {
          request.items = request.items.map((item) => ({ ...item, rotation: 'forbid' }));
        }
        // Per-group pre-call guards (a fan-out group can independently exceed limits).
        assertWithinInstanceLimit(freecutItems);
        assertWithinBodyLimit(request);
        return { group, request, engineSelection, totalInstances, vacuumWarningsByItemId: optimizeInput.vacuumWarningsByItemId };
      });

      // Reflect the lifecycle: draft|ready -> calculating, and BUMP version so a
      // second concurrent calculate with the same client version is rejected at
      // its own Phase 1 (FOR UPDATE serializes) BEFORE it dispatches freecut —
      // no wasted optimize call, no racing Phase 3 writes. Also reset the PDF
      // pre-warm state: the new version's PDF is not yet rendered, so a stale
      // 'ready' from the previous version must not linger.
      await tx.query(
        `UPDATE cut_job
         SET status = 'calculating', version = version + 1,
             pdf_prewarm_state = 'pending', pdf_prewarm_failure_reason = NULL,
             failure_code = NULL, failure_reason = NULL, updated_at = now()
         WHERE cut_job_id = $1`,
        [command.cutJobId],
      );

      // Freeze the basis from the Phase-1 snapshot (Codex R16 BLOCKER #1):
      // compute basisOf from the EXACT inputs used to build the freecut request.
      // Carried in prep and persisted in Phase 3. NOT recomputed after freecut
      // returns (params/grain/stock/details may have changed in the gap).
      const usedSheetTypeMap = new Map<number, { widthMm: number; heightMm: number }>();
      for (const { group } of groupPreps) {
        if (group.sheetMaterialTypeId !== null && group.smtWidthMm !== null && group.smtHeightMm !== null) {
          usedSheetTypeMap.set(group.sheetMaterialTypeId, { widthMm: group.smtWidthMm, heightMm: group.smtHeightMm });
        }
      }
      const basisItems: BasisInputItem[] = groupPreps.flatMap(({ group }) =>
        group.items.map((item) => ({
          orderDetailId: item.orderDetailId,
          qty: item.qty,
          widthMm: item.widthMm,
          heightMm: item.heightMm,
          sheetMaterialTypeId: group.sheetMaterialTypeId,
          filmId: group.filmId,
          filmTexture: item.filmTexture,
        })),
      );
      const basisSheetTypes: BasisSheetType[] = [...usedSheetTypeMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([id, dims]) => ({ sheetMaterialTypeId: id, widthMm: dims.widthMm, heightMm: dims.heightMm }));
      const calcBasis = basisOf({
        params,
        grainRules,
        combineFilms: job.combineFilms,
        splitByMaterial: job.splitByMaterial,
        rotationAllowed: job.rotationAllowed,
        sheetOverride: sheetOverrideForBasis,
        items: basisItems,
        sheetTypes: basisSheetTypes,
      });

      return { kind: 'new' as const, groupPreps, params, expectedVersion: job.version + 1, calcBasis, calcParams: params };
      })
      // A Phase 1 validation failure (no items / no sheet spec / instance|body
      // limit) is a calculation outcome: persist a matching reason. Guard on the
      // version the calc STARTED with (prep rolled back, so it is unchanged) — if a
      // concurrent archive/add/remove committed in the gap, the version no longer
      // matches and the failure write is skipped (supersede-safe, no clobber).
      // Concurrency / precondition errors pass through unchanged (markCalcFailed).
      .catch((error) => this.markCalcFailed(error, command, phase1Related, command.version));

    if (prep.kind === 'completed') {
      return this.getJob({
        currentUser: command.currentUser,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
      });
    }
    if (prep.kind === 'abandoned') {
      throw new ApiError(409, 'CUT_RESULT_COMMAND_ABANDONED', 'Предыдущий процесс расчёта был прерван; запустите новый расчёт');
    }

    // Related dimensions aggregated across ALL groups (audit query/report-ready).
    const allOrderIds = prep.groupPreps.flatMap((p) => p.group.orderIds);
    const allSheetMaterialTypeIds = prep.groupPreps.map((p) => p.group.sheetMaterialTypeId as number);

    // Phase 2 — external freecut calls (no DB lock held), one per group.
    // Partial-failure policy: ANY group error fails the WHOLE job (status=failed
    // + cut_job.calculate_failed). All-or-nothing — no group is persisted on a
    // partial failure, so the operator never sees a half-cut job. (Sequential so
    // a failure short-circuits the remaining optimize calls.)
    const responses: Array<{
      prep: (typeof prep.groupPreps)[number];
      response: Awaited<ReturnType<FreecutClientLike['optimize']>>;
    }> = [];
    try {
      for (const groupPrep of prep.groupPreps) {
        await this.database.query(
          `UPDATE cut_result_command
           SET heartbeat_at = now(),
               lease_expires_at = now() + ($4::bigint * interval '1 millisecond')
           WHERE cut_job_id = $1 AND command_id = $2::uuid
             AND owner_token = $3::uuid AND status = 'in_progress'`,
          [command.cutJobId, command.commandId, ownerToken, CUT_RESULT_LEASE_MS],
        );
        const response = await this.freecut.optimize(groupPrep.request);
        const contractViolations = validateFreecutResponseContract(groupPrep.request, response);
        if (contractViolations.length > 0) {
          throw new CutOptimizerInvalidGeometryError(contractViolations.length, contractViolations.slice(0, 20));
        }
        const filmTextureByItemId = new Map(groupPrep.request.items.map((item) => [item.id, item.rotation === 'forbid']));
        const violations = backMapSolutions(response, {
          requestItems: groupPrep.request.items,
          vacuumWarningsByItemId: groupPrep.vacuumWarningsByItemId,
          ...(this.nativePortraitWriter ? { coordinateContract: NATIVE_PORTRAIT_COORDINATE_CONTRACT } : {}),
        }).flatMap((sheet) =>
          validateSheetPlacements({
            sheetIndex: sheet.sheetIndex,
            placements: sheet.placements,
            gap: { kerfMm: prep.params.kerf_mm, spacingMm: prep.params.spacing_mm },
            filmTextureByItemId,
            stopAfterFirst: true,
          }),
        );
        if (violations.length > 0) {
          throw new CutOptimizerInvalidGeometryError(violations.length, violations.slice(0, 20));
        }
        responses.push({ prep: groupPrep, response });
      }
    } catch (error) {
      // A freecut failure fails the WHOLE job. Guard the status write on THIS
      // calculation's version so a newer calculate/mutation in flight is not
      // clobbered (supersede-safe).
      await this.markCalcFailed(
        error,
        command,
        { orderIds: allOrderIds, sheetMaterialTypeIds: allSheetMaterialTypeIds },
        prep.expectedVersion,
      );
    }

    // Phase 3 — persist ALL groups + a single audit + a single outbox row.
    try {
      await this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const job = await loadJobForUpdate(tx, command.cutJobId);
      assertVersion(job, prep.expectedVersion);
      const ownership = await tx.query(
        `SELECT 1 FROM cut_result_command
         WHERE cut_job_id = $1 AND command_id = $2::uuid
           AND owner_token = $3::uuid AND status = 'in_progress'
           AND lease_expires_at > now()
         FOR UPDATE`,
        [command.cutJobId, command.commandId, ownerToken],
      );
      if (ownership.rowCount !== 1) {
        throw new ApiError(409, 'CUT_RESULT_COMMAND_ABANDONED', 'Владение командой расчёта потеряно');
      }

      const cutGroupIds: number[] = [];
      let totalSheets = 0;
      let totalUnplaced = 0;
      for (const { prep: groupPrep, response } of responses) {
        const { group, request } = groupPrep;
        // Compute the stable group key (written to cut_group.group_key so manual
        // layouts survive recalculations that keep the same logical grouping).
        const gKey = logicalGroupKey({
          splitByMaterial: job.splitByMaterial,
          combineFilms: job.combineFilms,
          sheetMaterialTypeId: group.sheetMaterialTypeId,
          filmId: group.filmId,
        });

        const groupInsert = await tx.query<{ cut_group_id: string | number }>(
          `
          INSERT INTO cut_group (cut_job_id, sheet_material_type_id, film_id, status, summary, group_key)
          VALUES ($1, $2, $3, 'ready', $4::jsonb, $5)
          RETURNING cut_group_id
          `,
          [
            command.cutJobId,
            group.sheetMaterialTypeId,
            group.filmId,
            JSON.stringify({
              ...(response.summary ?? {}),
              engine_used: groupPrep.engineSelection.engineUsed,
              engine_reason: groupPrep.engineSelection.engineReason,
            }),
            gKey,
          ],
        );
        const cutGroupId = toNum(groupInsert.rows[0].cut_group_id);
        cutGroupIds.push(cutGroupId);

        // Assign only THIS group's items to the new cut_group (scoped by detail).
        await tx.query(
          `UPDATE cut_job_item SET cut_group_id = $1, updated_at = now()
           WHERE cut_job_id = $2 AND is_active = true AND order_detail_id = ANY($3::bigint[])`,
          [cutGroupId, command.cutJobId, group.items.map((item) => item.orderDetailId)],
        );

        // Build a label lookup from the Phase-1 snapshot so render never re-reads
        // order_details (Codex R8/R10 BLOCKER #1).
        const labelByItemId = new Map<string, PieceLabelSnapshot>(
          group.items.map((item) => [
            freecutItemId(item.orderDetailId),
            {
              orderId: item.orderId,
              detailNumber: item.detailNumber,
              widthMm: item.widthMm,
              heightMm: item.heightMm,
            },
          ]),
        );

        for (const sheet of backMapSolutions(response, {
          requestItems: request.items,
          vacuumWarningsByItemId: groupPrep.vacuumWarningsByItemId,
          ...(this.nativePortraitWriter ? { coordinateContract: NATIVE_PORTRAIT_COORDINATE_CONTRACT } : {}),
        })) {
          const placementsWithLabels: SheetPlacementsJson = {
            ...sheet.placements,
            pieces: sheet.placements.pieces.map((piece) => ({
              ...piece,
              label: labelByItemId.get(piece.item_id) ?? { orderId: null, detailNumber: null, widthMm: piece.width_mm, heightMm: piece.height_mm },
            })),
          };
          await tx.query(
            `
            INSERT INTO cut_group_sheet (cut_group_id, sheet_index, sheet_material_type_id, placements)
            VALUES ($1, $2, $3, $4::jsonb)
            `,
            [cutGroupId, sheet.sheetIndex, group.sheetMaterialTypeId, JSON.stringify(placementsWithLabels)],
          );
          totalSheets += 1;
        }
        totalUnplaced += response.unplaced_items?.length ?? 0;
      }

      // Idempotency anchor over the WHOLE resolved item set (all groups). The
      // hash covers each detail's geometry + cuttable key + qty, so a re-cut after
      // a geometry/material/film change emits a fresh outbox row (not suppressed),
      // while an identical re-cut stays one row.
      const allHashItems = prep.groupPreps.flatMap((p) =>
        p.group.items.map((item) => ({
          detailId: item.orderDetailId,
          qty: item.qty,
          widthMm: item.widthMm,
          heightMm: item.heightMm,
          sheetMaterialTypeId: p.group.sheetMaterialTypeId,
          filmId: p.group.filmId,
          filmTexture: item.filmTexture,
        })),
      );
      const requestHash = computeRequestHash({
        items: allHashItems,
        // Fold the job-level combine-films flag into the hashed params so toggling
        // it re-cuts (emits a fresh outbox row) even when the resolved groups would
        // otherwise hash identically (e.g. one film per material).
        params: {
          ...(prep.params as unknown as Record<string, unknown>),
          combineFilms: job.combineFilms,
          splitByMaterial: job.splitByMaterial,
          ...(this.nativePortraitWriter ? { coordinateContract: NATIVE_PORTRAIT_COORDINATE_CONTRACT } : {}),
        },
      });
      await tx.query(
        `
        UPDATE cut_job
        SET status = 'ready', request_hash = $2, version = version + 1, updated_at = now(),
            last_calc_params = $3::jsonb, last_calc_basis = $4
        WHERE cut_job_id = $1
        `,
        [command.cutJobId, requestHash, JSON.stringify(prep.calcParams), prep.calcBasis],
      );

      const cutResult = await this.createCutResult(tx, {
        cutJobId: command.cutJobId,
        resultKind: 'auto',
        commandId: command.commandId,
        commandPayloadHash,
        actor: command.currentUser,
        unplaced: responses.flatMap(({ response }) =>
          (response.unplaced_items ?? []).map((item) => ({
            itemId: item.item_id,
            instance: item.instance,
            reason: item.reason,
          })),
        ),
      });

      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.calculated,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        related: {
          orderIds: allOrderIds,
          sheetMaterialTypeIds: allSheetMaterialTypeIds,
          cutGroupIds,
          cutResultIds: [cutResult.cutResultId],
        },
        metadata: {
          groupCount: responses.length,
          sheetCount: totalSheets,
          unplacedCount: totalUnplaced,
          engines: prep.groupPreps.map((groupPrep) => ({
            engine: groupPrep.engineSelection.engineUsed,
            reason: groupPrep.engineSelection.engineReason,
            instances: groupPrep.totalInstances,
          })),
          cutResultId: cutResult.cutResultId,
          resultNo: cutResult.resultNo,
          cutNumber: cutResult.cutNumber,
          resultKind: cutResult.resultKind,
          basedOnResultId: cutResult.basedOnResultId,
        },
      });

      await tx.query(
        `
        INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
        VALUES ($1, $2, $3, $4::jsonb, $5)
        ON CONFLICT (idempotency_key) DO NOTHING
        `,
        [
          CUT_AUDIT_EVENTS.calculated,
          'cut_job',
          String(command.cutJobId),
          JSON.stringify({
            cutJobId: command.cutJobId,
            cutGroupIds,
            actorUserId: command.currentUser.id,
            requestId: command.requestId ?? null,
            orderIds: allOrderIds,
            sheetMaterialTypeIds: allSheetMaterialTypeIds,
            requestHash,
            cutResultId: cutResult.cutResultId,
            resultNo: cutResult.resultNo,
            cutNumber: cutResult.cutNumber,
          }),
          // Scope the outbox idempotency key to the JOB: after migration 031 two
          // DIFFERENT jobs can legitimately share an identical detail set / params
          // (and thus requestHash). Without cutJobId the global dedupe would swallow
          // the second job's calculated event. Same-job re-calc still dedupes.
          `${CUT_AUDIT_EVENTS.calculated}:${command.cutJobId}:${cutResult.resultNo}`,
        ],
      );
      });
    } catch (error) {
      await this.markCalcFailed(
        error,
        command,
        { orderIds: allOrderIds, sheetMaterialTypeIds: allSheetMaterialTypeIds },
        prep.expectedVersion,
      );
    }

    // All cut commands (calculate + setters) return the fully enriched job via a
    // post-commit getJob read (with editorParams, requiresRecalc, renderToken).
    // The FE does setJob(response) after each command, so it must always receive
    // complete enriched data — including the correct requiresRecalc state so the
    // «устарел» badge and PDF/edit button guards reflect reality without a reload.
    return this.getJob({ currentUser: command.currentUser, cutJobId: command.cutJobId });
  }

  /**
   * Persist a calculation failure (Phase 1 validation or Phase 2 freecut) as a
   * durable code + operator reason, audit it, and re-throw a friendly ApiError
   * whose message matches the persisted reason. Precondition/concurrency errors
   * (stale version, not-mutable, not-found) pass through unchanged. Always throws.
   *
   * @param guardVersion the version this calc owns — Phase 2 passes the bumped
   *   `calculating` version (prep.expectedVersion); Phase 1 passes the original
   *   `command.version` (its prep tx rolled back, leaving the version unchanged).
   *   Either way the status write is guarded `WHERE version = guardVersion`, so a
   *   concurrent mutation that advanced the version is NOT clobbered (rowCount 0
   *   → the failure write is skipped). Both phases are supersede-safe.
   */
  private async markCalcFailed(
    error: unknown,
    command: CalculateCutJobCommand,
    related: CalcRelatedDimensions,
    guardVersion: number,
  ): Promise<never> {
    if (!shouldMarkCutFailed(error)) {
      // Not a calculation outcome — leave status/reason untouched.
      throw error;
    }
    const failure = describeCutFailure(error);
    const originalCode = (error as { code?: unknown })?.code;
    await this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const failed = await tx.query(
        `UPDATE cut_job
         SET status = 'failed', failure_code = $3, failure_reason = $4,
             pdf_prewarm_state = 'pending', pdf_prewarm_failure_reason = NULL,
             version = version + 1, updated_at = now()
         WHERE cut_job_id = $1 AND version = $2`,
        [command.cutJobId, guardVersion, failure.code, failure.reason],
      );
      if (failed.rowCount === 0) {
        return; // superseded by a newer version — skip status + audit.
      }
      // A failed job must carry NO layout (invariant: never a stale group/PDF on
      // an "Ошибка" job). Phase 2's prep already dropped the prior result set, but
      // a Phase 1 failure rolled its prep back — so clear here for BOTH paths
      // uniformly (no-op when there is nothing to drop). cut_group_sheet cascades;
      // items stay active/reserved (FK ON DELETE SET NULL), unlinked for clarity.
      await tx.query(
        `UPDATE cut_job_item SET cut_group_id = NULL WHERE cut_job_id = $1 AND cut_group_id IS NOT NULL`,
        [command.cutJobId],
      );
      await tx.query(`DELETE FROM cut_group WHERE cut_job_id = $1`, [command.cutJobId]);
      await tx.query(
        `INSERT INTO cut_result_command
           (cut_job_id, command_id, command_type, payload_hash, status,
            failure_code, created_by, completed_at)
         VALUES ($1, $2::uuid, 'calculate', $3, 'failed', $4, $5, now())
         ON CONFLICT (cut_job_id, command_id) DO UPDATE
           SET status = 'failed', failure_code = EXCLUDED.failure_code,
               owner_token = NULL, lease_expires_at = NULL,
               heartbeat_at = now(), completed_at = now()`,
        [
          command.cutJobId,
          command.commandId,
          hashCutResultCommand({ type: 'calculate', version: command.version }),
          failure.code,
          numOrNull(command.currentUser.id),
        ],
      );
      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.calculateFailed,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        related,
        metadata: {
          // Raw technical message + original code for diagnostics, plus the
          // mapped code/reason the operator actually saw.
          error: error instanceof Error ? error.message : 'cut calculation error',
          code: typeof originalCode === 'string' ? originalCode : null,
          failureCode: failure.code,
          failureReason: failure.reason,
        },
      });
    });
    // Surface the friendly reason; preserve the original HTTP status (422/413/504/
    // ...) when the error carried one (duck-typed), else 500.
    throw new ApiError(extractCutFailureStatus(error), failure.code, failure.reason, {
      cutJobId: command.cutJobId,
      ...(typeof originalCode === 'string' ? { originalCode } : {}),
    });
  }

  async getDeleteImpact(query: GetCutJobDeleteImpactQuery): Promise<CutJobDeleteImpactDto> {
    await loadJob(this.database, query.cutJobId, false);
    return loadCutJobDeleteImpact(this.database, query.cutJobId);
  }

  archive(command: ArchiveCutJobCommand): Promise<CutJobDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const job = await loadJobForUpdate(tx, command.cutJobId);
      assertVersion(job, command.version);
      if (job.status === 'archived') {
        throw new ApiError(409, 'CUT_JOB_ALREADY_DELETED', 'Задание уже удалено');
      }

      const impact = await loadCutJobDeleteImpact(tx, command.cutJobId);
      if (impact.linkedMdfPackets.length > 0 && command.deleteLinkedMdfPackets !== true) {
        throw new ApiError(
          409,
          'CUT_JOB_LINKED_MDF_PACKETS',
          'Есть связанные карточки файлов станка на MDF-доске',
          { cutJobId: command.cutJobId, linkedMdfPackets: impact.linkedMdfPackets },
        );
      }

      const hiddenMdfPacketIds =
        command.deleteLinkedMdfPackets === true
          ? await hideLinkedMdfPacketsForCutJob(tx, command.cutJobId, command.currentUser.id)
          : [];

      const released = await tx.query<ReleasedCutJobItemRow>(
        `
        UPDATE cut_job_item cji
        SET is_active = false, updated_at = now()
        FROM order_details od
        WHERE cji.cut_job_id = $1 AND cji.is_active = true
          AND od.detail_id = cji.order_detail_id
        RETURNING cji.order_id, cji.order_detail_id, od.sheet_material_type_id
        `,
        [command.cutJobId],
      );
      const releasedRows = released.rows as ReleasedCutJobItemRow[];
      await tx.query(
        `UPDATE cut_job SET status = 'archived', version = version + 1, updated_at = now() WHERE cut_job_id = $1`,
        [command.cutJobId],
      );

      const archivedSheetTypeIds = [
        ...new Set(
          releasedRows
            .map((row) => (row.sheet_material_type_id === null ? null : toNum(row.sheet_material_type_id)))
            .filter((id): id is number => id !== null),
        ),
      ];
      const releasedOrderIds = releasedRows.map((row) => toNum(row.order_id));
      const releasedOrderDetailIds = releasedRows.map((row) => toNum(row.order_detail_id));
      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.deleted,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        related: {
          orderIds: releasedOrderIds,
          sheetMaterialTypeIds: archivedSheetTypeIds,
        },
        metadata: {
          releasedCount: released.rowCount ?? 0,
          releasedOrderDetailIds,
          hiddenMdfPacketCount: hiddenMdfPacketIds.length,
          hiddenMdfPacketIds,
          deleteLinkedMdfPackets: command.deleteLinkedMdfPackets === true,
        },
      });

      return loadJob(tx, command.cutJobId);
    });
  }

  async getJob(query: GetCutJobQuery): Promise<CutJobDto> {
    const base = await loadJob(this.database, query.cutJobId);

    // Read last_calc_params and last_calc_basis from cut_job (single extra query).
    const calcRow = await this.database.query<{ last_calc_params: unknown; last_calc_basis: string | null }>(
      `SELECT last_calc_params, last_calc_basis FROM cut_job WHERE cut_job_id = $1`,
      [query.cutJobId],
    );
    const lastCalcBasis = calcRow.rows[0]?.last_calc_basis ?? null;
    const lastCalcParamsRaw = (calcRow.rows[0]?.last_calc_params ?? null) as FreecutParams | null;

    // Compute requiresRecalc via non-throwing probe (Codex R12 BLOCKER #2).
    // Returns true when: last_calc_basis is null, probe returns null, or basis differs.
    let requiresRecalc = true;
    const basisInputs = await this.loadCurrentCalcBasisInputs(query.cutJobId);
    if (basisInputs !== null && lastCalcBasis !== null) {
      requiresRecalc = basisOf(basisInputs) !== lastCalcBasis;
    }

    // editorParams from the frozen last_calc_params (null for legacy/pre-migration jobs).
    const editorParams: CutEditorParamsDto | null = lastCalcParamsRaw
      ? { kerfMm: lastCalcParamsRaw.kerf_mm, spacingMm: lastCalcParamsRaw.spacing_mm }
      : null;

    const autoLayoutValidation = editorParams
      ? {
          valid: !base.groups.some((group) => group.sheets.some((sheet) => validateSheetPlacements({
                sheetIndex: sheet.sheetIndex,
                placements: sheet.placements,
                gap: editorParams,
                // The migration boundary is for stored spatial geometry. Grain
                // remains enforced authoritatively during calculate/manual save.
                filmTextureByItemId: new Map(),
                stopAfterFirst: true,
              }).length > 0)),
        }
      : undefined;

    const itemByDetailId = new Map(base.items.map((item) => [item.orderDetailId, item]));
    const sheetFitWarnings = basisInputs === null
      ? []
      : computeSelectedSheetFitWarnings({
          selectedSheet: basisInputs.sheetOverride,
          items: basisInputs.items,
          params: basisInputs.params,
          grainRules: basisInputs.grainRules,
          nativePortrait: this.nativePortraitWriter,
        }).flatMap((warning) => {
          const jobItem = itemByDetailId.get(warning.orderDetailId);
          if (!jobItem) return [];
          return [{
            ...warning,
            orderId: jobItem.orderId,
            detailNumber: jobItem.detail?.detailNumber ?? null,
            detailName: jobItem.detail?.detailName ?? null,
          }];
        });

    // Read group_key for each cut_group (extra query scoped to single job).
    const groupKeyResult = await this.database.query<{ cut_group_id: string | number; group_key: string | null }>(
      `SELECT cut_group_id, group_key FROM cut_group WHERE cut_job_id = $1`,
      [query.cutJobId],
    );
    const groupKeyMap = new Map(groupKeyResult.rows.map((r) => [toNum(r.cut_group_id), r.group_key ?? null]));

    // Read manual layouts for this job and index by group_key.
    const manualLayouts = await this.listManualLayoutsForJob(query.cutJobId);
    const manualLayoutMap = new Map(manualLayouts.map((ml) => [ml.groupKey, ml]));

    // Enrich groups with groupKey + manualLayout (single-job path only).
    const enrichedGroups: CutGroupDto[] = base.groups.map((group) => {
      const groupKey = groupKeyMap.get(group.cutGroupId) ?? null;
      const ml = groupKey ? (manualLayoutMap.get(groupKey) ?? null) : null;
      const manualLayout: CutManualLayoutDto | null = ml
        ? { groupKey: ml.groupKey, sheets: ml.sheets, isActive: ml.isActive, isStale: ml.isStale, version: ml.version }
        : null;
      return { ...group, groupKey, manualLayout };
    });

    // Task 7 Rule 10: populate renderToken on each group and the whole job.
    // Token encodes: job version + per-group manual layout version + effectiveActive.
    // Always uses 'active' semantics: if the manual layout is active+fresh, it IS
    // the current rendered output; if stale, auto is the current output.
    const enrichedGroupsWithTokens: CutGroupDto[] = enrichedGroups.map((group) => {
      const ml = group.manualLayout;
      const effectiveActive = ml != null && ml.isActive && !ml.isStale;
      const manualVersion = ml?.version ?? 0;
      const renderToken = `j${base.version}:m${manualVersion}:a${effectiveActive ? 1 : 0}`;
      return { ...group, renderToken };
    });

    // Job render token: aggregates job version + all groups' individual tokens.
    const jobRenderToken = `j${base.version}:${enrichedGroupsWithTokens
      .map((g) => {
        const ml = g.manualLayout;
        const ea = ml != null && ml.isActive && !ml.isStale;
        return `g${g.cutGroupId}:m${ml?.version ?? 0}:a${ea ? 1 : 0}`;
      })
      .join(',')}`;

    const cutResults = await this.listResults({
      currentUser: query.currentUser,
      cutJobId: query.cutJobId,
      requestId: query.requestId,
    });

    return {
      ...base,
      groups: enrichedGroupsWithTokens,
      editorParams,
      requiresRecalc,
      autoLayoutValidation,
      sheetFitWarnings,
      renderToken: jobRenderToken,
      currentCutResult: cutResults.find((result) => result.isCurrent) ?? null,
      cutResults,
    };
  }

  async listResults(query: ListCutResultsQuery): Promise<CutResultSummaryDto[]> {
    const result = await this.database.query<CutResultRow>(
      `SELECT DISTINCT ON (r.result_no)
              r.cut_result_id, r.cut_job_id, r.result_no, r.revision_no, r.result_kind,
              r.source_job_version, r.based_on_result_id, r.totals_snapshot,
              r.created_by, r.created_by_name_snapshot, r.created_at,
              j.source_display_number,
              (current_result.result_no = r.result_no AND archive.archived_at IS NULL) AS is_current,
              archive.archived_at,
              archive.archived_by,
              r.snapshot_job
       FROM cut_result r
       JOIN cut_job j ON j.cut_job_id = r.cut_job_id
       LEFT JOIN cut_result current_result
         ON current_result.cut_result_id = j.current_cut_result_id
       LEFT JOIN cut_result_archive_state archive
         ON archive.cut_job_id = r.cut_job_id
        AND archive.result_no = r.result_no
       WHERE r.cut_job_id = $1
       ORDER BY r.result_no DESC, r.revision_no DESC`,
      [query.cutJobId],
    );
    return result.rows.map(mapCutResultSummary);
  }

  async getResult(query: GetCutResultQuery): Promise<CutResultDto> {
    const result = await this.database.query<CutResultRow & { snapshot_digest: string; computed_digest: string; job_created_at: Date | string }>(
      `SELECT r.cut_result_id, r.cut_job_id, r.result_no, r.revision_no, r.result_kind,
              r.source_job_version, r.based_on_result_id, r.totals_snapshot,
              r.created_by, r.created_by_name_snapshot, r.created_at,
              j.created_at AS job_created_at,
              j.source_display_number,
              r.snapshot_job, r.snapshot_digest,
              cut_result_snapshot_digest(r.snapshot_job) AS computed_digest,
              (current_result.result_no = r.result_no AND archive.archived_at IS NULL) AS is_current,
              archive.archived_at,
              archive.archived_by
       FROM cut_result r
       JOIN cut_job j ON j.cut_job_id = r.cut_job_id
       LEFT JOIN cut_result current_result
         ON current_result.cut_result_id = j.current_cut_result_id
       LEFT JOIN cut_result_archive_state archive
         ON archive.cut_job_id = r.cut_job_id
        AND archive.result_no = r.result_no
       WHERE r.cut_job_id = $1 AND r.result_no = $2
       ORDER BY r.revision_no DESC
       LIMIT 1`,
      [query.cutJobId, query.resultNo],
    );
    const row = result.rows[0];
    if (!row) {
      throw new ApiError(404, 'CUT_RESULT_NOT_FOUND', `Раскрой ${query.cutJobId}-${query.resultNo} не найден`);
    }
    if (row.computed_digest !== row.snapshot_digest) {
      throw new ApiError(500, 'CUT_RESULT_SNAPSHOT_CORRUPT', 'Исторический раскрой повреждён');
    }
    const summary = mapCutResultSummary(row);
    const snapshotIsVacuum = cutJobSnapshotUsesVacuumTable(row.snapshot_job);
    return {
      ...summary,
      job: {
        ...row.snapshot_job,
        displayNumber: formatCutJobNumber(toNum(row.cut_job_id), snapshotIsVacuum, row.source_display_number),
        createdAt: row.snapshot_job.createdAt ?? dateTimeIso(row.job_created_at),
        rotationAllowed: row.snapshot_job.rotationAllowed ?? true,
        textureDirection: row.snapshot_job.textureDirection ?? 'none',
        totals: normalizeCutJobTotals(row.snapshot_job.totals),
        currentCutResult: summary,
        cutResults: undefined,
      },
      renderToken: `r${summary.cutResultId}:${row.snapshot_digest.slice(0, 16)}`,
    };
  }

  async setCurrentResult(command: CutResultStateCommand): Promise<CutJobDto> {
    await this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const job = await tx.query<{
        current_cut_result_id: string | number | null;
        current_result_no: string | number | null;
        status: string;
      }>(
        `SELECT j.current_cut_result_id, current_result.result_no AS current_result_no, j.status
         FROM cut_job j
         LEFT JOIN cut_result current_result
           ON current_result.cut_result_id = j.current_cut_result_id
         WHERE j.cut_job_id = $1
         FOR UPDATE OF j`,
        [command.cutJobId],
      );
      const jobRow = job.rows[0];
      if (!jobRow) throw new CutJobNotFoundError(command.cutJobId);
      if (jobRow.status === 'archived') {
        throw new CutJobNotMutableError(command.cutJobId, jobRow.status);
      }
      const result = await tx.query<{
        cut_result_id: string | number;
        archived_at: Date | string | null;
      }>(
        `SELECT r.cut_result_id, archive.archived_at
         FROM cut_result r
         LEFT JOIN cut_result_archive_state archive
           ON archive.cut_job_id = r.cut_job_id
          AND archive.result_no = r.result_no
         WHERE r.cut_job_id = $1 AND r.result_no = $2
         ORDER BY r.revision_no DESC
         LIMIT 1`,
        [command.cutJobId, command.resultNo],
      );
      const resultRow = result.rows[0];
      if (!resultRow) {
        throw new ApiError(404, 'CUT_RESULT_NOT_FOUND', `Раскрой ${command.cutJobId}-${command.resultNo} не найден`);
      }
      if (resultRow.archived_at !== null) {
        throw new ApiError(409, 'CUT_RESULT_ARCHIVED', 'Архивный раскрой нельзя сделать действующим');
      }
      const nextCurrentResultId = toNum(resultRow.cut_result_id);
      const previousCurrentResultId = numOrNull(jobRow.current_cut_result_id);
      if (previousCurrentResultId === nextCurrentResultId) return;
      await tx.query(
        `UPDATE cut_job
            SET current_cut_result_id = $2, version = version + 1, updated_at = now()
          WHERE cut_job_id = $1`,
        [command.cutJobId, nextCurrentResultId],
      );
      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.currentResultChanged,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        related: { cutResultIds: [previousCurrentResultId, nextCurrentResultId].filter((id): id is number => id !== null) },
        before: { currentCutResultId: previousCurrentResultId },
        after: { currentCutResultId: nextCurrentResultId, resultNo: command.resultNo },
        metadata: { resultNo: command.resultNo },
      });
    });
    return this.getJob({ currentUser: command.currentUser, cutJobId: command.cutJobId });
  }

  async archiveResult(command: CutResultStateCommand): Promise<CutJobDto> {
    await this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const job = await tx.query<{
        current_cut_result_id: string | number | null;
        current_result_no: string | number | null;
        status: string;
      }>(
        `SELECT j.current_cut_result_id, current_result.result_no AS current_result_no, j.status
         FROM cut_job j
         LEFT JOIN cut_result current_result
           ON current_result.cut_result_id = j.current_cut_result_id
         WHERE j.cut_job_id = $1
         FOR UPDATE OF j`,
        [command.cutJobId],
      );
      const jobRow = job.rows[0];
      if (!jobRow) throw new CutJobNotFoundError(command.cutJobId);
      if (jobRow.status === 'archived') {
        throw new CutJobNotMutableError(command.cutJobId, jobRow.status);
      }
      const result = await tx.query<{ cut_result_id: string | number }>(
        `SELECT cut_result_id
         FROM cut_result
         WHERE cut_job_id = $1 AND result_no = $2
         ORDER BY revision_no DESC
         LIMIT 1`,
        [command.cutJobId, command.resultNo],
      );
      const resultRow = result.rows[0];
      if (!resultRow) {
        throw new ApiError(404, 'CUT_RESULT_NOT_FOUND', `Раскрой ${command.cutJobId}-${command.resultNo} не найден`);
      }
      const cutResultId = toNum(resultRow.cut_result_id);
      if (
        numOrNull(jobRow.current_result_no) === command.resultNo
        || numOrNull(jobRow.current_cut_result_id) === cutResultId
      ) {
        throw new ApiError(409, 'CUT_RESULT_CURRENT', 'Действующий раскрой нельзя архивировать. Сначала назначьте действующим другой раскрой.');
      }
      const inserted = await tx.query(
        `INSERT INTO cut_result_archive_state (cut_job_id, result_no, archived_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (cut_job_id, result_no) DO NOTHING
         RETURNING cut_job_id`,
        [command.cutJobId, command.resultNo, numOrNull(command.currentUser.id)],
      );
      if ((inserted.rowCount ?? 0) === 0) return;
      await tx.query(
        `UPDATE cut_job SET version = version + 1, updated_at = now() WHERE cut_job_id = $1`,
        [command.cutJobId],
      );
      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.resultArchived,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        related: { cutResultIds: [cutResultId] },
        after: { resultNo: command.resultNo, archived: true },
        metadata: { resultNo: command.resultNo },
      });
    });
    return this.getJob({ currentUser: command.currentUser, cutJobId: command.cutJobId });
  }

  async unarchiveResult(command: CutResultStateCommand): Promise<CutJobDto> {
    await this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const job = await tx.query<{ status: string }>(
        `SELECT status FROM cut_job WHERE cut_job_id = $1 FOR UPDATE`,
        [command.cutJobId],
      );
      const jobRow = job.rows[0];
      if (!jobRow) throw new CutJobNotFoundError(command.cutJobId);
      if (jobRow.status === 'archived') {
        throw new CutJobNotMutableError(command.cutJobId, jobRow.status);
      }
      const result = await tx.query<{ cut_result_id: string | number }>(
        `SELECT cut_result_id
         FROM cut_result
         WHERE cut_job_id = $1 AND result_no = $2
         ORDER BY revision_no DESC
         LIMIT 1`,
        [command.cutJobId, command.resultNo],
      );
      const resultRow = result.rows[0];
      if (!resultRow) {
        throw new ApiError(404, 'CUT_RESULT_NOT_FOUND', `Раскрой ${command.cutJobId}-${command.resultNo} не найден`);
      }
      const deleted = await tx.query(
        `DELETE FROM cut_result_archive_state
         WHERE cut_job_id = $1 AND result_no = $2
         RETURNING cut_job_id`,
        [command.cutJobId, command.resultNo],
      );
      if ((deleted.rowCount ?? 0) === 0) return;
      await tx.query(
        `UPDATE cut_job SET version = version + 1, updated_at = now() WHERE cut_job_id = $1`,
        [command.cutJobId],
      );
      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.resultUnarchived,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        related: { cutResultIds: [toNum(resultRow.cut_result_id)] },
        after: { resultNo: command.resultNo, archived: false },
        metadata: { resultNo: command.resultNo },
      });
    });
    return this.getJob({ currentUser: command.currentUser, cutJobId: command.cutJobId });
  }

  async backfillLegacyResults(batchSize = 50): Promise<number> {
    return this.database.transaction(async (tx) => {
      const jobs = await tx.query<{
        cut_job_id: string | number;
        version: string | number;
        request_hash: string | null;
        created_by: string | number | null;
        username: string | null;
      }>(
        `SELECT j.cut_job_id, j.version, j.request_hash, j.created_by, u.username
         FROM cut_job j
         LEFT JOIN users u ON u.user_id = j.created_by
         WHERE j.current_cut_result_id IS NULL
           AND EXISTS (SELECT 1 FROM cut_group g WHERE g.cut_job_id = j.cut_job_id)
         ORDER BY j.cut_job_id
         FOR UPDATE OF j SKIP LOCKED
         LIMIT $1`,
        [batchSize],
      );
      for (const row of jobs.rows) {
        const cutJobId = toNum(row.cut_job_id);
        let snapshot = synthesizeLegacyUnplaced(await loadFrozenJobSnapshot(tx, cutJobId));
        snapshot = await this.attachFrozenRenderSnapshots(tx, snapshot);
        validateFrozenJobSnapshot(snapshot);
        const manifest = buildCutResultManifest(snapshot);
        const inserted = await tx.query<{ cut_result_id: string | number }>(
          `INSERT INTO cut_result
             (cut_job_id, result_no, result_kind, source_job_version,
              request_hash, snapshot_job, snapshot_manifest, snapshot_digest,
              totals_snapshot, created_by, created_by_name_snapshot)
           VALUES ($1, 1, 'legacy', $2, $3, $4::jsonb, $5::jsonb,
                   cut_result_snapshot_digest($4::jsonb), $6::jsonb, $7, $8)
           ON CONFLICT (cut_job_id, result_no, revision_no) DO NOTHING
           RETURNING cut_result_id`,
          [
            cutJobId,
            toNum(row.version),
            row.request_hash,
            JSON.stringify(snapshot),
            JSON.stringify(manifest),
            JSON.stringify(snapshot.totals),
            numOrNull(row.created_by),
            row.username,
          ],
        );
        const existing = inserted.rows[0] ?? (await tx.query<{ cut_result_id: string | number }>(
          `SELECT cut_result_id
           FROM cut_result
           WHERE cut_job_id = $1 AND result_no = 1
           ORDER BY revision_no DESC
           LIMIT 1`,
          [cutJobId],
        )).rows[0];
        if (!existing) throw new ApiError(500, 'CUT_RESULT_BACKFILL_FAILED', `Не создан legacy раскрой задания ${cutJobId}`);
        await tx.query(
          `UPDATE cut_job
           SET current_cut_result_id = $2, next_cut_result_no = 2
           WHERE cut_job_id = $1 AND current_cut_result_id IS NULL`,
          [cutJobId, toNum(existing.cut_result_id)],
        );
      }
      return jobs.rows.length;
    });
  }

  private async loadFrozenRenderContext(args: {
    currentUser: CurrentUser;
    cutJobId: number;
    resultNo: number;
    cutGroupId: number;
    variant: 'auto' | 'manual' | 'active';
    rotate90?: boolean;
    originTopLeft?: boolean;
    axisOrigin?: import('../../../shared/cut-geometry').CutAxisOrigin;
    showLabels?: boolean;
    pieceMetadata?: boolean;
    renderStyle?: CutRenderStyleName;
    refreshPdfDynamicFields?: boolean;
  }): Promise<{
    job: CutJobDto;
    group: CutGroupDto;
    sheets: RenderedSheetContext[];
    renderContractVersion: FrozenPdfRenderContract;
  }> {
    const frozen = await this.getResult({
      currentUser: args.currentUser,
      cutJobId: args.cutJobId,
      resultNo: args.resultNo,
    });
    const group = frozen.job.groups.find((candidate) => candidate.cutGroupId === args.cutGroupId);
    if (!group) {
      throw new ApiError(404, 'CUT_GROUP_NOT_FOUND', `Группа ${args.cutGroupId} не принадлежит раскрою ${frozen.cutNumber}`);
    }
    const manual = group.manualLayout;
    const useManual = args.variant === 'manual'
      ? manual !== null && manual !== undefined
      : args.variant === 'active'
        ? manual !== null && manual !== undefined && manual.isActive && !manual.isStale
        : false;
    if (args.variant === 'manual' && !useManual) {
      throw new ApiError(409, 'CUT_MANUAL_LAYOUT_UNAVAILABLE', 'Ручной вариант раскроя недоступен');
    }
    const sourceSheets = useManual ? manual!.sheets : group.sheets;
    const renderStyleName = args.renderStyle ?? CUT_RENDER_STYLE_DEFAULT;
    const renderStyle = await this.config.getRenderStyleRule(renderStyleName);
    const rebuildForRenderStyle = renderStyleName !== CUT_RENDER_STYLE_DEFAULT;
    const rebuildFrozenPieceMetadata = args.pieceMetadata === true || args.refreshPdfDynamicFields === true || rebuildForRenderStyle;
    const rebuildSvgWithPieceMetadata = args.pieceMetadata === true || rebuildForRenderStyle;
    const rebuildBathSvgWithCurrentRenderer = args.refreshPdfDynamicFields === true;
    const frozenQuantities = rebuildFrozenPieceMetadata
      ? computeGroupItemQuantities(sourceSheets.map((sheet) => ({
          sheetIndex: sheet.sheetIndex,
          placements: sheet.placements,
        })))
      : new Map<string, number>();
    const frozenItemByItemId = rebuildFrozenPieceMetadata
      ? new Map(frozen.job.items.map((item) => [freecutItemId(item.orderDetailId), item]))
      : new Map<string, CutJobItemDto>();
    const frozenFillByOrder = rebuildFrozenPieceMetadata
      ? createOrderFillResolver(frozen.job.items.map((item) => item.orderId), renderStyle)
      : (() => '#eef3f8');
    const bathGuideMeta = await this.database.query<{
      last_calc_params: FreecutParams | null;
      sheet_material_name: string | null;
      sheet_material_width_mm: string | number | null;
      sheet_material_height_mm: string | number | null;
    }>(
      `SELECT cj.last_calc_params,
              smt.name AS sheet_material_name,
              smt.width_mm AS sheet_material_width_mm,
              smt.height_mm AS sheet_material_height_mm
       FROM cut_job cj
       LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = $2
       WHERE cj.cut_job_id = $1`,
      [frozen.job.cutJobId, group.sheetMaterialTypeId],
    );
    const showBathMeterGuides = shouldShowBathMeterGuides({
      engineUsed: group.summary?.engine_used,
      layoutMode: bathGuideMeta.rows[0]?.last_calc_params?.layout_mode,
      materialName: bathGuideMeta.rows[0]?.sheet_material_name,
      materialWidthMm: bathGuideMeta.rows[0]?.sheet_material_width_mm,
      materialHeightMm: bathGuideMeta.rows[0]?.sheet_material_height_mm,
    });
    const sheets = sourceSheets.map((sheet) => {
      const placements = sheet.placements;
      const renderSnapshot = sheet.renderSnapshot;
      const view = renderSnapshot?.views[frozenRenderViewKey({
        rotate90: args.rotate90,
        originTopLeft: args.originTopLeft,
        axisOrigin: args.axisOrigin,
        showLabels: args.showLabels,
      })];
      if (!renderSnapshot || renderSnapshot.contractVersion !== 'cut_sheet_render_v1' || !view) {
        throw new ApiError(500, 'CUT_RESULT_SNAPSHOT_CORRUPT', `Нет frozen render листа ${sheet.sheetIndex}`);
      }
      const baseSvg = rebuildSvgWithPieceMetadata && (rebuildForRenderStyle || !view.svg.includes('data-detail-id='))
        ? buildSheetSvg({
            sheet: placements,
            labelFor: (piece) => frozenPieceLabelLines(piece, frozenItemByItemId, frozenQuantities),
            fillFor: (piece) => {
              const item = frozenItemByItemId.get(piece.item_id);
              const orderId = (piece as { label?: PieceLabelSnapshot }).label?.orderId ?? item?.orderId ?? null;
              return frozenFillByOrder(orderId);
            },
            rotate90: args.rotate90,
            originTopLeft: args.originTopLeft,
            axisOrigin: args.axisOrigin,
            showLabels: args.showLabels,
            renderStyle,
          })
        : view.svg;
      const svg = showBathMeterGuides
        ? addBathMeterGuidesToSvg(baseSvg, placements, args.rotate90 === true)
        : baseSvg;
      const baseBathSvg = rebuildBathSvgWithCurrentRenderer
        ? buildBathProfileSheetSvg({
            sheet: placements,
            labelFor: (piece) => frozenPieceLabelLines(piece, frozenItemByItemId, frozenQuantities),
            bathDetailInfoFor: (piece) => {
              const detail = frozenItemByItemId.get(piece.item_id)?.detail;
              return {
                edgeTypeName: detail?.edgeTypeName ?? null,
                millingTypeName: detail?.millingTypeName ?? null,
                doweling: detail?.doweling ?? false,
              };
            },
            fillFor: (piece) => {
              const item = frozenItemByItemId.get(piece.item_id);
              const orderId = (piece as { label?: PieceLabelSnapshot }).label?.orderId ?? item?.orderId ?? null;
              return frozenFillByOrder(orderId);
            },
            rotate90: args.rotate90,
            originTopLeft: args.originTopLeft,
            axisOrigin: args.axisOrigin,
          })
        : view.bathSvg;
      const bathSvg = showBathMeterGuides
        ? addBathMeterGuidesToSvg(baseBathSvg, placements, args.rotate90 === true)
        : baseBathSvg;
      return {
        sheetIndex: sheet.sheetIndex,
        placements,
        svg,
        bathSvg,
        pdfMeta: renderSnapshot.pdfMeta as PdfSheetMeta,
        pdfDetailRows: renderSnapshot.pdfDetailRows as PdfSheetDetailRow[],
        filmRequirementLinearMeters: showBathMeterGuides
          ? calculateBathSheetFilmUsage(placements)?.linearMeters ?? null
          : null,
      };
    });
    const resolvedSheets = args.refreshPdfDynamicFields
      ? await this.refreshPdfDynamicFieldsForSheets(args.cutGroupId, sheets)
      : sheets;
    return { job: frozen.job, group, sheets: resolvedSheets, renderContractVersion: 'cut_sheet_render_v1' };
  }

  private async attachFrozenRenderSnapshots(tx: TransactionClient, snapshot: CutJobDto): Promise<CutJobDto> {
    const groups: CutGroupDto[] = [];
    for (const group of snapshot.groups) {
      const freezeVariant = async <T extends { sheetIndex: number; placements: SheetPlacementsJson }>(
        variant: 'auto' | 'manual',
        sourceSheets: T[],
      ): Promise<Array<T & { renderSnapshot: CutSheetRenderSnapshotDto }>> => {
        const renderBySheet = new Map<number, CutSheetRenderSnapshotDto>();
        const viewArgs: Array<{ rotate90: boolean; originTopLeft: boolean; axisOrigin: 'top-left' | 'bottom-left'; showLabels: boolean }> = [];
        for (const rotate90 of [false, true]) {
          for (const originTopLeft of rotate90 ? [false, true] : [false]) {
            for (const axisOrigin of ['top-left', 'bottom-left'] as const) {
              for (const showLabels of [false, true]) {
                viewArgs.push({ rotate90, originTopLeft, axisOrigin, showLabels });
              }
            }
          }
        }
        for (const view of viewArgs) {
          const rendered = await this.loadGroupRenderContext(
            group.cutGroupId,
            view.rotate90,
            view.originTopLeft,
            view.axisOrigin,
            variant,
            snapshot.cutJobId,
            view.showLabels,
            tx,
            true,
          );
          for (const sheet of rendered.sheets) {
            const existing = renderBySheet.get(sheet.sheetIndex) ?? {
              contractVersion: 'cut_sheet_render_v1' as const,
              views: {},
              pdfMeta: sheet.pdfMeta,
              pdfDetailRows: sheet.pdfDetailRows,
            };
            existing.views[frozenRenderViewKey(view)] = { svg: sheet.svg, bathSvg: sheet.bathSvg };
            renderBySheet.set(sheet.sheetIndex, existing);
          }
        }
        return sourceSheets.map((sheet) => {
          const renderSnapshot = renderBySheet.get(sheet.sheetIndex);
          if (!renderSnapshot) {
            throw new ApiError(500, 'CUT_RESULT_SNAPSHOT_INCOMPLETE', `Не создан render snapshot листа ${sheet.sheetIndex}`);
          }
          return { ...sheet, renderSnapshot };
        });
      };

      const autoSheets = await freezeVariant('auto', group.sheets);
      const manualLayout = group.manualLayout
        ? {
            ...group.manualLayout,
            sheets: await freezeVariant('manual', group.manualLayout.sheets),
          }
        : group.manualLayout;
      groups.push({ ...group, sheets: autoSheets, manualLayout });
    }
    return { ...snapshot, groups };
  }

  private async createCutResult(
    tx: TransactionClient,
    args: {
      cutJobId: number;
      resultKind: Exclude<CutResultKind, 'legacy'>;
      commandId: string;
      commandPayloadHash: string;
      actor: CurrentUser;
      unplaced?: CutJobDto['unplaced'];
      reuseCurrentManualVersion?: boolean;
    },
  ): Promise<CutResultSummaryDto> {
    const state = await tx.query<{
      version: string | number;
      next_cut_result_no: string | number;
      current_cut_result_id: string | number | null;
      request_hash: string | null;
      current_result_no: string | number | null;
      current_revision_no: string | number | null;
      current_result_kind: CutResultKind | null;
      current_based_on_result_id: string | number | null;
      current_created_by: string | number | null;
      current_created_by_name_snapshot: string | null;
      current_created_at: Date | string | null;
    }>(
      `SELECT j.version, j.next_cut_result_no, j.current_cut_result_id, j.request_hash,
              current_result.result_no AS current_result_no,
              current_result.revision_no AS current_revision_no,
              current_result.result_kind AS current_result_kind,
              current_result.based_on_result_id AS current_based_on_result_id,
              current_result.created_by AS current_created_by,
              current_result.created_by_name_snapshot AS current_created_by_name_snapshot,
              current_result.created_at AS current_created_at
       FROM cut_job j
       LEFT JOIN cut_result current_result
         ON current_result.cut_result_id = j.current_cut_result_id
        AND current_result.cut_job_id = j.cut_job_id
       WHERE j.cut_job_id = $1`,
      [args.cutJobId],
    );
    const jobState = state.rows[0];
    if (!jobState) throw new CutJobNotFoundError(args.cutJobId);

    let snapshot = await loadFrozenJobSnapshot(tx, args.cutJobId);
    if (args.unplaced !== undefined) {
      snapshot = { ...snapshot, unplaced: args.unplaced };
    } else if (jobState.current_cut_result_id !== null) {
      const prior = await tx.query<{ snapshot_job: CutJobDto }>(
        `SELECT snapshot_job FROM cut_result WHERE cut_result_id = $1 AND cut_job_id = $2`,
        [toNum(jobState.current_cut_result_id), args.cutJobId],
      );
      snapshot = { ...snapshot, unplaced: prior.rows[0]?.snapshot_job.unplaced ?? [] };
    }
    snapshot = await this.attachFrozenRenderSnapshots(tx, snapshot);
    validateFrozenJobSnapshot(snapshot);
    const manifest = buildCutResultManifest(snapshot);
    const current = jobState.current_cut_result_id !== null
      && jobState.current_result_no !== null
      && jobState.current_revision_no !== null
      && jobState.current_result_kind !== null
      ? {
          cutResultId: toNum(jobState.current_cut_result_id),
          resultNo: toNum(jobState.current_result_no),
          revisionNo: toNum(jobState.current_revision_no),
          resultKind: jobState.current_result_kind,
          basedOnResultId: numOrNull(jobState.current_based_on_result_id),
        }
      : null;
    const allocation = planCutResultAllocation({
      nextResultNo: toNum(jobState.next_cut_result_no),
      reuseCurrentManualVersion: args.reuseCurrentManualVersion === true,
      current,
    });
    const resultCreatedBy = allocation.reusesCurrentManualVersion
      ? numOrNull(jobState.current_created_by)
      : numOrNull(args.actor.id);
    const resultCreatedByName = allocation.reusesCurrentManualVersion
      ? jobState.current_created_by_name_snapshot
      : args.actor.username;
    const resultCreatedAt = allocation.reusesCurrentManualVersion
      ? jobState.current_created_at
      : null;
    const inserted = await tx.query<CutResultRow>(
      `INSERT INTO cut_result
         (cut_job_id, result_no, revision_no, result_kind, source_job_version,
          based_on_result_id, command_id, command_payload_hash, request_hash,
          snapshot_job, snapshot_manifest, snapshot_digest, totals_snapshot,
          created_by, created_by_name_snapshot, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::uuid, $8, $9,
               $10::jsonb, $11::jsonb, cut_result_snapshot_digest($10::jsonb),
               $12::jsonb, $13, $14, COALESCE($15::timestamptz, now()))
       RETURNING cut_result_id, cut_job_id, result_no, revision_no, result_kind,
                 source_job_version, based_on_result_id, snapshot_job,
                 totals_snapshot, created_by, created_by_name_snapshot,
                 created_at, FALSE AS is_current`,
      [
        args.cutJobId,
        allocation.resultNo,
        allocation.revisionNo,
        args.resultKind,
        toNum(jobState.version),
        allocation.basedOnResultId,
        args.commandId,
        args.commandPayloadHash,
        jobState.request_hash,
        JSON.stringify(snapshot),
        JSON.stringify(manifest),
        JSON.stringify(snapshot.totals),
        resultCreatedBy,
        resultCreatedByName,
        resultCreatedAt,
      ],
    );
    const resultRow = inserted.rows[0];
    const cutResultId = toNum(resultRow.cut_result_id);

    const verified = await tx.query<{ snapshot_job: CutJobDto; snapshot_manifest: Record<string, unknown>; snapshot_digest: string; computed_digest: string }>(
      `SELECT snapshot_job, snapshot_manifest, snapshot_digest,
              cut_result_snapshot_digest(snapshot_job) AS computed_digest
       FROM cut_result WHERE cut_result_id = $1 AND cut_job_id = $2`,
      [cutResultId, args.cutJobId],
    );
    const reread = verified.rows[0];
    if (
      !reread
      || stableJson(reread.snapshot_manifest) !== stableJson(manifest)
      || reread.computed_digest !== reread.snapshot_digest
    ) {
      throw new ApiError(500, 'CUT_RESULT_SNAPSHOT_INCOMPLETE', 'Не удалось проверить полноту версии раскроя');
    }

    await tx.query(
      `UPDATE cut_job
       SET current_cut_result_id = $2, next_cut_result_no = $3, updated_at = now()
       WHERE cut_job_id = $1`,
      [args.cutJobId, cutResultId, allocation.nextResultNo],
    );
    await tx.query(
      `UPDATE cut_result_command
       SET status = 'completed', cut_result_id = $3, completed_at = now(),
           owner_token = NULL, heartbeat_at = now(), lease_expires_at = NULL
       WHERE cut_job_id = $1 AND command_id = $2::uuid AND status = 'in_progress'`,
      [args.cutJobId, args.commandId, cutResultId],
    );

    return { ...mapCutResultSummary(resultRow), isCurrent: true };
  }

  // ── Task 4: manual-layout read/persist/invalidate ────────────────────────

  async getManualLayoutByKey(
    cutJobId: number,
    groupKey: string,
    client: DatabaseClient = this.database,
  ): Promise<{ sheets: CutManualSheetDto[]; isActive: boolean; isStale: boolean; version: number } | null> {
    const result = await client.query<{
      sheets: unknown;
      is_active: boolean;
      is_stale: boolean;
      version: string | number;
    }>(
      `SELECT sheets, is_active, is_stale, version
       FROM cut_group_manual_layout
       WHERE cut_job_id = $1 AND group_key = $2
       LIMIT 1`,
      [cutJobId, groupKey],
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return {
      sheets: row.sheets as CutManualSheetDto[],
      isActive: row.is_active,
      isStale: row.is_stale,
      version: Number(row.version),
    };
  }

  async upsertManualLayout(args: {
    cutJobId: number;
    groupKey: string;
    sheets: CutManualSheetDto[];
    active: boolean;
    basedOnJobVersion: number;
    createdBy: number | null;
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO cut_group_manual_layout
         (cut_job_id, group_key, sheets, is_active, is_stale, based_on_job_version, version, created_by)
       VALUES ($1, $2, $3::jsonb, $4, FALSE, $5, 1, $6)
       ON CONFLICT (cut_job_id, group_key) DO UPDATE
         SET sheets              = EXCLUDED.sheets,
             is_active           = EXCLUDED.is_active,
             is_stale            = FALSE,
             based_on_job_version = EXCLUDED.based_on_job_version,
             version             = cut_group_manual_layout.version + 1,
             updated_at          = now()`,
      [args.cutJobId, args.groupKey, JSON.stringify(args.sheets), args.active, args.basedOnJobVersion, args.createdBy],
    );
  }

  async listManualLayoutsForJob(
    cutJobId: number,
  ): Promise<ManualLayoutReadModel[]> {
    return loadManualLayouts(this.database, cutJobId);
  }

  /** Hard-invalidates all active/non-stale manual layouts for a job.
   *  Called inside the caller's existing transaction so it participates in
   *  the same atomicity boundary (a rolled-back caller rolls this back too). */
  private async invalidateManualLayoutsForJob(tx: DatabaseClient, cutJobId: number, _reason: string): Promise<void> {
    await tx.query(
      `UPDATE cut_group_manual_layout
       SET is_stale = TRUE, is_active = FALSE, updated_at = now()
       WHERE cut_job_id = $1 AND (is_stale = FALSE OR is_active = TRUE)`,
      [cutJobId],
    );
  }

  /** Non-throwing probe: loads the same inputs calculate uses to build its
   *  freecut request (Phase 1 snapshot) without strict profile validation.
   *  Returns null when the current params cannot be resolved (inactive profile),
   *  which makes requiresRecalc=true (conservative, correct direction). */
  private async loadCurrentCalcBasisInputs(cutJobId: number): Promise<BasisInputs | null> {
    const jobRes = await this.database.query<{
      params: FreecutParams | null;
      param_profile_id: string | number | null;
      sheet_material_type_id: string | number | null;
      combine_films: boolean | null;
      split_by_material: boolean | null;
      rotation_allowed: boolean | null;
    }>(
      `SELECT params, param_profile_id, sheet_material_type_id, combine_films, split_by_material, rotation_allowed
       FROM cut_job WHERE cut_job_id = $1`,
      [cutJobId],
    );
    if (!jobRes.rows[0]) return null;
    const job = jobRes.rows[0];

    const combineFilms = job.combine_films === true;
    const splitByMaterial = job.split_by_material !== false;
    const rotationAllowed = job.rotation_allowed !== false;

    let items = await loadCalcItems(this.database, cutJobId);

    // Sheet override (no active/cuttable guard — non-throwing probe).
    // Variant B: a chosen sheet override forces EVERY detail onto the chosen sheet,
    // regardless of split_by_material. onlyNoSheetSpec is always false when an
    // override is present, matching the calculate() path exactly so basisOf is identical.
    let sheetOverride: { sheetMaterialTypeId: number; widthMm: number; heightMm: number } | null = null;
    const sheetMaterialTypeId =
      job.sheet_material_type_id === null || job.sheet_material_type_id === undefined
        ? null
        : toNum(job.sheet_material_type_id);
    if (sheetMaterialTypeId !== null) {
      const sheetRes = await this.database.query<{ width_mm: string | number; height_mm: string | number }>(
        `SELECT width_mm, height_mm FROM sheet_material_types WHERE sheet_material_type_id = $1`,
        [sheetMaterialTypeId],
      );
      if (sheetRes.rows[0]) {
        const sw = {
          sheetMaterialTypeId,
          widthMm: toNum(sheetRes.rows[0].width_mm),
          heightMm: toNum(sheetRes.rows[0].height_mm),
        };
        sheetOverride = sw;
        items = applySheetOverride(
          items,
          { sheetMaterialTypeId: sw.sheetMaterialTypeId, widthMm: sw.widthMm, heightMm: sw.heightMm },
          { onlyNoSheetSpec: false },
        );
      }
    }

    // Non-throwing param probe: inactive/missing profile → return null → requiresRecalc=true.
    // ALSO swallow any throw from the config resolvers (malformed/corrupt stored profile
    // params or grain-rule rows raise 422). getJob must stay loadable: any failure to
    // resolve the current basis → null → requiresRecalc=true, editorParams=null. The
    // strict calculate path keeps its own throwing resolver and still rejects.
    let params: FreecutParams;
    let grainRules: CutGrainRules;
    try {
      const profileId =
        job.param_profile_id === null || job.param_profile_id === undefined ? null : toNum(job.param_profile_id);
      let profileParams: FreecutParams | null = null;
      if (profileId !== null) {
        profileParams = await this.config.getParamsByProfileId(profileId);
        if (profileParams === null) return null; // inactive/missing profile
      }
      params = resolveCalcParams({
        profileId,
        jobParams: (job.params ?? null) as FreecutParams | null,
        profileParams,
        defaultParams: await this.config.getDefaultParams(),
      });
      grainRules = await this.config.getGrainRules();
    } catch {
      return null; // malformed/corrupt stored config → cannot resolve basis
    }

    // Use groupByCuttableKey to mirror Phase 1's group-level sheetMaterialTypeId
    // (for splitByMaterial=false, the representative sheet matters for the hash).
    const groups = [...groupByCuttableKey(items, combineFilms, splitByMaterial).values()];
    const usedSheetTypeMap = new Map<number, { widthMm: number; heightMm: number }>();
    for (const group of groups) {
      if (group.sheetMaterialTypeId !== null && group.smtWidthMm !== null && group.smtHeightMm !== null) {
        usedSheetTypeMap.set(group.sheetMaterialTypeId, { widthMm: group.smtWidthMm, heightMm: group.smtHeightMm });
      }
    }
    const sheetTypes: BasisSheetType[] = [...usedSheetTypeMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([id, dims]) => ({ sheetMaterialTypeId: id, widthMm: dims.widthMm, heightMm: dims.heightMm }));
    const basisItems: BasisInputItem[] = groups.flatMap((group) =>
      group.items.map((item) => ({
        orderDetailId: item.orderDetailId,
        qty: item.qty,
        widthMm: item.widthMm,
        heightMm: item.heightMm,
        sheetMaterialTypeId: group.sheetMaterialTypeId,
        filmId: group.filmId,
        filmTexture: item.filmTexture,
      })),
    );

    return { params, grainRules, combineFilms, splitByMaterial, rotationAllowed, sheetOverride, items: basisItems, sheetTypes };
  }

  async listJobs(query: ListCutJobsQuery): Promise<CutJobDto[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const jobNumber = normalizeCutJobNumberFilter(query.filters?.jobNumber);
    if (query.filters?.status) {
      params.push(query.filters.status);
      conditions.push(`j.status = $${params.length}`);
    } else if (query.filters?.includeArchived !== true) {
      params.push('archived');
      conditions.push(`j.status <> $${params.length}`);
    }
    if (query.filters?.createdBy) {
      params.push(query.filters.createdBy);
      conditions.push(`j.created_by = $${params.length}`);
    }
    if (query.filters?.createdFrom) {
      params.push(query.filters.createdFrom);
      conditions.push(`j.created_at >= $${params.length}::date`);
    }
    if (query.filters?.createdTo) {
      params.push(query.filters.createdTo);
      conditions.push(`j.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    if (jobNumber) {
      params.push(jobNumber);
      conditions.push(`NULLIF(trim(j.source_display_number::text), '') = $${params.length}`);
    }
    const orderSearch = query.filters?.orderSearch?.trim();
    if (orderSearch) {
      params.push(`%${escapeLikePattern(orderSearch)}%`);
      conditions.push(`
        EXISTS (
          SELECT 1
          FROM cut_job_item cji
          LEFT JOIN orders o ON o.order_id = cji.order_id
          WHERE cji.cut_job_id = j.cut_job_id
            AND cji.is_active = true
            AND (
              cji.order_id::text ILIKE $${params.length} ESCAPE '\\'
              OR o.order_name ILIKE $${params.length} ESCAPE '\\'
            )
        )
      `);
    }
    const result = await this.database.query<{ cut_job_id: string | number }>(
      `SELECT j.cut_job_id FROM cut_job j${conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY j.cut_job_id DESC LIMIT 200`,
      params,
    );
    const ids = result.rows.map((row) => toNum(row.cut_job_id));
    const totalsById = await computeTotals(this.database, ids);
    const materialNamesById = await computeMaterialNames(this.database, ids);
    const jobs: CutJobDto[] = [];
    for (const id of ids) {
      // List only renders item/group counts -> skip the per-item detail joins.
      jobs.push(await loadJob(this.database, id, false, totalsById.get(id), materialNamesById.get(id) ?? []));
    }
    return jobs;
  }

  async listEligibleDetails(query: EligibleDetailsQuery): Promise<EligibleDetailsResponseDto> {
    const readyStatusIds = await this.resolveReadyStatusIds();

    const conditions: string[] = ['od.delete_flag = false', 'ord.delete_flag = false'];
    const params: unknown[] = [];
    const addArrayFilter = (column: string, values: number[] | undefined) => {
      if (values && values.length > 0) {
        params.push(values);
        conditions.push(`${column} = ANY($${params.length}::bigint[])`);
      }
    };
    addArrayFilter('od.order_id', query.criteria.orderIds);
    addArrayFilter('od.sheet_material_type_id', query.criteria.sheetMaterialTypeIds);
    addArrayFilter('od.film_id', query.criteria.filmIds);
    if (query.criteria.dateFrom) {
      params.push(query.criteria.dateFrom);
      conditions.push(`ord.order_date >= $${params.length}::date`);
    }
    if (query.criteria.dateTo) {
      params.push(query.criteria.dateTo);
      conditions.push(`ord.order_date <= $${params.length}::date`);
    }
    if (query.criteria.productionStatusIds && query.criteria.productionStatusIds.length > 0) {
      // Operator override: explicit status filter wins over the ready-set default.
      addArrayFilter('od.production_status_id', query.criteria.productionStatusIds);
    } else if (query.includeAllStatuses) {
      // Create-preview mode: show every detail matching explicit criteria so the
      // operator can see why some rows cannot be selected. Eligibility below
      // still marks wrong statuses as disabled.
    } else if (readyStatusIds.length > 0) {
      // Default: only ready-to-cut statuses, so the LIMIT can never be exhausted
      // by thousands of wrong-status rows and silently hide the eligible subset
      // (Critic MAJOR). Reserved-but-ready details still surface (already_reserved).
      params.push(readyStatusIds);
      conditions.push(`od.production_status_id = ANY($${params.length}::smallint[])`);
    } else {
      // The configured ready-set resolved to ZERO status ids (e.g. typoed/unknown
      // codes). Fail closed — nothing is ready-to-cut — rather than dropping the
      // filter and returning every status unfiltered (leakage regression).
      conditions.push('false');
    }

    const result = await this.database.query<EligibleRow>(
      `
      SELECT od.detail_id, od.order_id, ord.order_name, od.quantity, od.material_id,
             od.sheet_material_type_id,
             clients.client_name,
             od.detail_number, od.detail_name, od.height, od.width, od.area,
             COALESCE(smt.name, materials.material_name) AS material_name,
             mt.milling_type_name, et.edge_type_name,
             od.film_id, od.production_status_id, od.delete_flag,
             films.film_name, ps.production_status_name,
             od.priority, od.joint_order_id, od.note,
             od.link_cutting_file, od.link_cutting_image_file, od.link_cad_file, od.link_pdf_file,
             smt.is_cuttable
      FROM order_details od
      JOIN orders ord ON ord.order_id = od.order_id
      LEFT JOIN clients ON clients.client_id = ord.client_id
      LEFT JOIN materials ON materials.material_id = od.material_id
      LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = od.sheet_material_type_id
      LEFT JOIN milling_types mt ON mt.milling_type_id = od.milling_type_id
      LEFT JOIN edge_types et ON et.edge_type_id = od.edge_type_id
      LEFT JOIN films ON films.film_id = od.film_id
      LEFT JOIN production_statuses ps ON ps.production_status_id = od.production_status_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY od.detail_id
      LIMIT 2000
      `,
      params,
    );

    // Placement is informational, not exclusive (migration 031): a detail may be
    // in any number of jobs. Resolve where each candidate is already placed so the
    // UI can SHOW it without ever blocking the add.
    const placements = await this.loadDetailPlacements(
      this.database,
      result.rows.map((row) => toNum(row.detail_id)),
    );

    let noSheetSpecCount = 0;
    const details: EligibleDetailDto[] = result.rows.map((row) => {
      const candidate: DetailEligibilityCandidate = {
        detailId: toNum(row.detail_id),
        deleteFlag: Boolean(row.delete_flag),
        productionStatusId: row.production_status_id === null ? null : toNum(row.production_status_id),
        sheetMaterialTypeId: row.sheet_material_type_id === null ? null : toNum(row.sheet_material_type_id),
        // When sheet_material_type_id is null (no_sheet_spec path), is_cuttable comes
        // back null from the LEFT JOIN. Default to true so the not_cuttable guard never
        // fires before no_sheet_spec handles the missing-spec case.
        // Also treat undefined (absent column in test stubs) as true for the same reason.
        isCuttable: row.is_cuttable == null ? true : Boolean(row.is_cuttable),
      };
      const { eligible, reason } = classifyDetailEligibility(candidate, { readyStatusIds });
      if (reason === 'no_sheet_spec') {
        noSheetSpecCount += 1;
      }
      const placement = placements.get(candidate.detailId);
      return {
        orderDetailId: candidate.detailId,
        orderId: toNum(row.order_id),
        orderName: row.order_name ?? null,
        clientName: row.client_name ?? null,
        detailNumber: numOrNull(row.detail_number),
        detailName: row.detail_name ?? null,
        height: numOrNull(row.height),
        width: numOrNull(row.width),
        quantity: toNum(row.quantity),
        area: numOrNull(row.area),
        materialId: row.material_id === null || row.material_id === undefined ? null : toNum(row.material_id),
        sheetMaterialTypeId: candidate.sheetMaterialTypeId,
        materialName: row.material_name ?? null,
        millingTypeName: row.milling_type_name ?? null,
        edgeTypeName: row.edge_type_name ?? null,
        filmId: row.film_id === null ? null : toNum(row.film_id),
        filmName: row.film_name ?? null,
        productionStatusName: row.production_status_name ?? null,
        priority: numOrNull(row.priority),
        jointOrderId: numOrNull(row.joint_order_id),
        note: row.note ?? null,
        linkCuttingFile: row.link_cutting_file ?? null,
        linkCuttingImageFile: row.link_cutting_image_file ?? null,
        linkCadFile: row.link_cad_file ?? null,
        linkPdfFile: row.link_pdf_file ?? null,
        eligible,
        ineligibleReason: reason,
        activeJobs: placement?.activeJobs ?? [],
        archivedJobs: placement?.archivedJobs ?? [],
        inArchivedJob: placement?.inArchivedJob ?? false,
      };
    });

    return { details, noSheetSpecCount };
  }

  async listFilmOptionsForCut(query: ListFilmOptionsForCutQuery): Promise<CutFilmOptionDto[]> {
    const conditions: string[] = [
      'od.delete_flag = false',
      'ord.delete_flag = false',
      'od.film_id IS NOT NULL',
      'f.film_name IS NOT NULL',
      `btrim(f.film_name) <> ''`,
    ];
    const params: unknown[] = [];
    const addArrayFilter = (column: string, values: number[] | undefined) => {
      if (values && values.length > 0) {
        params.push(values);
        conditions.push(`${column} = ANY($${params.length}::bigint[])`);
      }
    };
    addArrayFilter('od.order_id', query.criteria.orderIds);
    addArrayFilter('od.sheet_material_type_id', query.criteria.sheetMaterialTypeIds);
    if (query.criteria.dateFrom) {
      params.push(query.criteria.dateFrom);
      conditions.push(`ord.order_date >= $${params.length}::date`);
    }
    if (query.criteria.dateTo) {
      params.push(query.criteria.dateTo);
      conditions.push(`ord.order_date <= $${params.length}::date`);
    }
    if (query.criteria.productionStatusIds && query.criteria.productionStatusIds.length > 0) {
      addArrayFilter('od.production_status_id', query.criteria.productionStatusIds);
    }

    const result = await this.database.query<{ film_id: string | number; film_name: string }>(
      `
      SELECT DISTINCT od.film_id, f.film_name
      FROM order_details od
      JOIN orders ord ON ord.order_id = od.order_id
      JOIN films f ON f.film_id = od.film_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY f.film_name, od.film_id
      LIMIT 500
      `,
      params,
    );
    return result.rows.map((row) => ({
      filmId: toNum(row.film_id),
      name: row.film_name,
    }));
  }

  /**
   * Per-detail cut-job placement (informational; migration 031 dropped exclusivity).
   * Returns, for each requested detail id, the distinct ACTIVE (non-archived) jobs
   * it sits in plus whether it also exists in any archived job.
   */
  private async loadDetailPlacements(
    client: DatabaseClient,
    detailIds: readonly number[],
  ): Promise<Map<number, { activeJobs: CutJobRefDto[]; archivedJobs: CutJobRefDto[]; inArchivedJob: boolean }>> {
    const map = new Map<number, { activeJobs: CutJobRefDto[]; archivedJobs: CutJobRefDto[]; inArchivedJob: boolean }>();
    if (detailIds.length === 0) return map;
    const rows = await client.query<{
      order_detail_id: string | number;
      cut_job_id: string | number;
      name: string;
      status: string;
      is_active: boolean;
      param_profile_id: string | number | null;
      profile_name: string | null;
      profile_is_active: boolean | null;
    }>(
      `
      SELECT cji.order_detail_id, cj.cut_job_id, cj.name, cj.status, cji.is_active,
             cj.param_profile_id, cpp.name AS profile_name, cpp.is_active AS profile_is_active
      FROM cut_job_item cji
      JOIN cut_job cj ON cj.cut_job_id = cji.cut_job_id
      LEFT JOIN cut_param_profiles cpp ON cpp.cut_param_profile_id = cj.param_profile_id
      WHERE cji.order_detail_id = ANY($1::bigint[])
      ORDER BY cj.cut_job_id
      `,
      [[...detailIds]],
    );
    for (const row of rows.rows) {
      const detailId = toNum(row.order_detail_id);
      const entry = map.get(detailId) ?? { activeJobs: [], archivedJobs: [], inArchivedJob: false };
      const isArchived = row.status === 'archived';
      const ref: CutJobRefDto = {
        cutJobId: toNum(row.cut_job_id),
        name: row.name,
        paramProfileId: row.param_profile_id === null ? null : toNum(row.param_profile_id),
        profileName: row.profile_name ?? null,
        profileIsActive: row.profile_is_active ?? null,
      };
      if (isArchived) {
        entry.inArchivedJob = true;
        if (!entry.archivedJobs.some((j) => j.cutJobId === ref.cutJobId)) {
          entry.archivedJobs.push(ref);
        }
      } else if (row.is_active) {
        // a detail can appear once per active job; ORDER BY keeps these stable
        if (!entry.activeJobs.some((j) => j.cutJobId === ref.cutJobId)) {
          entry.activeJobs.push(ref);
        }
      }
      map.set(detailId, entry);
    }
    return map;
  }

  /**
   * Subset of the given detail ids that are eligible to be added (same rule as the
   * add path: not deleted, ready production status, resolvable sheet type). Used to
   * keep placements precise — only details that WOULD be added are reported.
   */
  private async filterEligibleDetailIds(detailIds: readonly number[]): Promise<number[]> {
    if (detailIds.length === 0) return [];
    const readyStatusIds = await this.resolveReadyStatusIds();
    if (readyStatusIds.length === 0) return [];
    const result = await this.database.query<{ detail_id: string | number }>(
      `
      SELECT od.detail_id
      FROM order_details od
      WHERE od.detail_id = ANY($1::bigint[])
        AND od.delete_flag = false
        AND od.production_status_id = ANY($2::smallint[])
        AND od.sheet_material_type_id IS NOT NULL
      `,
      [[...detailIds], readyStatusIds],
    );
    return result.rows.map((row) => toNum(row.detail_id));
  }

  async listDetailPlacements(query: DetailPlacementsQuery): Promise<CutDetailPlacementsResponseDto> {
    // Resolve the target detail set: explicit detailIds win; else all non-deleted
    // details of the given orders.
    let detailIds = query.detailIds ?? [];
    if (detailIds.length === 0 && (query.orderIds?.length ?? 0) > 0) {
      const resolved = await this.database.query<{ detail_id: string | number }>(
        `SELECT detail_id FROM order_details WHERE order_id = ANY($1::bigint[]) AND delete_flag = false`,
        [[...(query.orderIds ?? [])]],
      );
      detailIds = resolved.rows.map((row) => toNum(row.detail_id));
    }
    // Show placements only for details that would actually be ADDED — i.e. the
    // eligible subset (ready status + sheet spec). Otherwise an order with a few
    // wrong-status / no-sheet-spec details would warn about placements for details
    // that the add path silently drops (Critic false-positive).
    const eligibleIds = await this.filterEligibleDetailIds(detailIds);
    const placements = await this.loadDetailPlacements(this.database, eligibleIds);
    const jobsById = new Map<number, CutJobRefDto>();
    let hasArchived = false;
    for (const entry of placements.values()) {
      for (const job of entry.activeJobs) {
        if (!jobsById.has(job.cutJobId)) jobsById.set(job.cutJobId, job);
      }
      if (entry.inArchivedJob) hasArchived = true;
    }
    const jobs = [...jobsById.values()].sort((a, b) => a.cutJobId - b.cutJobId);
    return { jobs, hasArchived };
  }

  async listDetailLastReady(query: DetailLastReadyQuery): Promise<CutDetailLastReadyResponseDto> {
    const detailIds = query.detailIds ?? [];
    if (detailIds.length === 0) return { details: [] };
    const rows = await this.database.query<{
      order_detail_id: string | number;
      cut_job_id: string | number;
      result_no: string | number;
      name: string;
      param_profile_id: string | number | null;
      profile_name: string | null;
      profile_is_active: boolean | null;
      is_vacuum: boolean;
      source_display_number: string | number | null;
    }>(
      `
      WITH candidates AS (
        SELECT cji.order_detail_id,
               cj.cut_job_id,
               cj.source_display_number,
               cj.name,
               cr.result_no,
               cj.param_profile_id,
               cpp.name AS profile_name,
               cpp.is_active AS profile_is_active,
               COALESCE(
                 cj.last_calc_params->>'layout_mode',
                 cpp.params->>'layout_mode',
                 cj.params->>'layout_mode'
               ) = 'vacuum_table' AS is_vacuum
        FROM cut_job_item cji
        JOIN cut_job cj ON cj.cut_job_id = cji.cut_job_id
        JOIN cut_result cr
          ON cr.cut_result_id = cj.current_cut_result_id
         AND cr.cut_job_id = cj.cut_job_id
        LEFT JOIN cut_result_archive_state archived
          ON archived.cut_job_id = cr.cut_job_id
         AND archived.result_no = cr.result_no
        LEFT JOIN cut_param_profiles cpp ON cpp.cut_param_profile_id = cj.param_profile_id
        WHERE cji.order_detail_id = ANY($1::bigint[])
          AND cji.is_active = true
          AND cj.status = 'ready'
          AND cj.last_calc_basis IS NOT NULL
          AND archived.cut_job_id IS NULL
      ),
      ranked AS (
        SELECT *,
               row_number() OVER (
                 PARTITION BY order_detail_id, is_vacuum
                 ORDER BY cut_job_id DESC
               ) AS rn
        FROM candidates
      )
      SELECT order_detail_id, cut_job_id, result_no, name,
             param_profile_id, profile_name, profile_is_active, is_vacuum, source_display_number
      FROM ranked
      WHERE rn = 1
      ORDER BY order_detail_id, is_vacuum
      `,
      [[...detailIds]],
    );
    const byDetail = new Map<number, CutDetailLastReadyResponseDto['details'][number]>();
    for (const row of rows.rows) {
      const orderDetailId = toNum(row.order_detail_id);
      const entry = byDetail.get(orderDetailId) ?? {
        orderDetailId,
        cutJob: null,
        bathCutJob: null,
      };
      const cutJobId = toNum(row.cut_job_id);
      const resultNo = toNum(row.result_no);
      const ref = {
        cutJobId,
        resultNo,
        cutNumber: formatCutNumber(cutJobId, resultNo, row.is_vacuum === true, row.source_display_number),
        name: row.name,
        paramProfileId: row.param_profile_id === null ? null : toNum(row.param_profile_id),
        profileName: row.profile_name,
        profileIsActive: row.profile_is_active,
      };
      if (row.is_vacuum) {
        entry.bathCutJob = ref;
      } else {
        entry.cutJob = ref;
      }
      byDetail.set(orderDetailId, entry);
    }
    return {
      details: [...byDetail.values()].sort((a, b) => a.orderDetailId - b.orderDetailId),
    };
  }

  async renderSheetPng(query: RenderSheetPngQuery): Promise<Buffer> {
    // PNG is NOT recalc-blocked (rule 5): only PDF endpoints enforce the print-block.
    const variant = query.variant ?? 'auto';
    const showLabels = query.showLabels ?? true;
    const { sheets } = query.resultNo !== undefined && query.cutJobId !== undefined
      ? await this.loadFrozenRenderContext({
          currentUser: query.currentUser,
          cutJobId: query.cutJobId,
          resultNo: query.resultNo,
          cutGroupId: query.cutGroupId,
          variant,
          rotate90: query.rotate90,
          originTopLeft: query.originTopLeft,
          axisOrigin: query.axisOrigin,
          showLabels,
          renderStyle: query.renderStyle,
        })
      : await this.loadGroupRenderContext(
          query.cutGroupId,
          query.rotate90,
          query.originTopLeft,
          query.axisOrigin,
          variant,
          query.cutJobId,
          showLabels,
          undefined,
          false,
          query.renderStyle,
        );
    // Rule 8: blank sheets are index-stable and never 404 for PNG/SVG.
    const sheet = sheets.find((s) => s.sheetIndex === query.sheetIndex);
    if (!sheet) {
      throw new CutGroupSheetNotFoundError(query.cutGroupId, query.sheetIndex);
    }
    const targetPx = await this.config.getRenderPresetPx(query.preset);
    // When rotated, the SVG viewBox is h×w — the rasterizer's fit dims must match.
    return renderSheetPng({
      svg: sheet.svg,
      targetPx,
      sheetWidthMm: query.rotate90 ? sheet.placements.sheet_height_mm : sheet.placements.sheet_width_mm,
      sheetHeightMm: query.rotate90 ? sheet.placements.sheet_width_mm : sheet.placements.sheet_height_mm,
    });
  }

  async renderSheetSvg(query: RenderSheetSvgQuery): Promise<string> {
    // SVG is NOT recalc-blocked (rule 5): only PDF endpoints enforce the print-block.
    const variant = query.variant ?? 'auto';
    const { sheets } = query.resultNo !== undefined && query.cutJobId !== undefined
      ? await this.loadFrozenRenderContext({
          currentUser: query.currentUser,
          cutJobId: query.cutJobId,
          resultNo: query.resultNo,
          cutGroupId: query.cutGroupId,
          variant,
          rotate90: query.rotate90,
          originTopLeft: query.originTopLeft,
          axisOrigin: query.axisOrigin,
          pieceMetadata: query.pieceMetadata,
          renderStyle: query.renderStyle,
        })
      : await this.loadGroupRenderContext(
          query.cutGroupId,
          query.rotate90,
          query.originTopLeft,
          query.axisOrigin,
          variant,
          query.cutJobId,
          true,
          undefined,
          false,
          query.renderStyle,
        );
    // Rule 8: blank sheets are index-stable and never 404 for SVG.
    const sheet = sheets.find((s) => s.sheetIndex === query.sheetIndex);
    if (!sheet) {
      throw new CutGroupSheetNotFoundError(query.cutGroupId, query.sheetIndex);
    }
    return sheet.svg;
  }

  async renderGroupPdf(query: RenderGroupPdfQuery): Promise<Buffer> {
    const variant = query.variant ?? 'auto';
    // Rule 6 BEFORE Rule 5: load + assert group↔job ownership first so a wrong
    // cutJobId yields 404 CUT_GROUP_NOT_FOUND, not a 409 recalc block (a missing
    // job makes checkRequiresRecalc conservatively true). This also resolves the
    // variant (manual-unavailable → 409) on the validated group.
    const frozenContext = query.resultNo !== undefined && query.cutJobId !== undefined
      ? await this.loadFrozenRenderContext({
          currentUser: query.currentUser,
          cutJobId: query.cutJobId,
          resultNo: query.resultNo,
          cutGroupId: query.cutGroupId,
          variant,
          rotate90: query.rotate90,
          originTopLeft: query.originTopLeft,
          axisOrigin: query.axisOrigin,
          refreshPdfDynamicFields: true,
        })
      : null;
    const currentContext = frozenContext === null
      ? await this.loadGroupPdfLandscapeRenderContext(
          query.cutGroupId, variant, query.cutJobId, query.originTopLeft, query.axisOrigin,
        )
      : null;
    const templateSelection = resolvePdfTemplateSelection(
      query.pdfTemplate,
      frozenContext?.group.pdfTemplate,
    );
    const pdfTemplate = templateSelection.code;
    if (templateSelection.requiresActiveCheck) await this.assertPdfTemplateActive(pdfTemplate);
    const templateLayout = templateSelection.usesCurrentLayout
      ? await this.loadPdfTemplateLayout(pdfTemplate)
      : null;
    const sheets = frozenContext?.sheets ?? currentContext!.sheets;
    const rotate90 = frozenContext ? (query.rotate90 ?? false) : currentContext!.rotate90;
    // Rule 5: group PDF is blocked while the job requires recalculation.
    // PNG/SVG are NOT blocked; only PDF/print surfaces enforce this.
    if (query.cutJobId !== undefined && query.resultNo === undefined) {
      if (await this.checkRequiresRecalc(query.cutJobId)) {
        throw new ApiError(409, 'CUT_RECALC_REQUIRED', 'Требуется пересчёт раскроя перед печатью');
      }
    }
    // Rule 8: skip blank sheets in PDF assembly only (index-stable for PNG/SVG).
    const printableSheets = sheets.filter((s) => s.placements.pieces.length > 0);
    if (printableSheets.length === 0) {
      throw new CutGroupSheetNotFoundError(query.cutGroupId, 0);
    }
    const pdfIdentity = await this.loadPdfRenderIdentity(query.cutJobId, query.resultNo);
    const pdfJobFields = await this.loadPdfRenderJobFields(query.cutJobId, query.cutGroupId);
    const pdfSheets = printableSheets.map((s, index) => ({
        svg: s.svg,
        bathSvg: s.bathSvg,
        sheetWidthMm: rotate90 ? s.placements.sheet_height_mm : s.placements.sheet_width_mm,
        sheetHeightMm: rotate90 ? s.placements.sheet_width_mm : s.placements.sheet_height_mm,
        sheetNumber: index + 1,
        pageCount: printableSheets.length,
        template: pdfTemplate,
        templateLayout,
        meta: s.pdfMeta,
        detailRows: s.pdfDetailRows,
        cutJobId: pdfIdentity.cutJobId ?? undefined,
        cutNumber: pdfIdentity.cutNumber ?? undefined,
        currentCutNumber: pdfIdentity.currentCutNumber ?? undefined,
        jobName: pdfJobFields.jobName,
        textureDirection: pdfJobFields.textureDirection,
        filmRequirementLinearMeters: s.filmRequirementLinearMeters,
      }));
    return frozenContext && !templateSelection.usesCurrentLayout
      ? buildFrozenSheetsPdf(frozenContext.renderContractVersion, pdfSheets)
      : buildSheetsPdf(pdfSheets);
  }

  async renderJobPdf(query: RenderJobPdfQuery): Promise<Buffer> {
    // Rule 4: variant=manual is PER-GROUP; the whole-job PDF can't coherently pick one
    // group's manual layout. Reject explicitly instead of silently ignoring it.
    if (query.variant === 'manual') {
      throw new ApiError(
        422,
        'CUT_MANUAL_VARIANT_NOT_JOB_SCOPED',
        'variant=manual не поддерживается для PDF всего задания. Используйте endpoint группы.',
      );
    }
    // Rule 5: job PDF is blocked while the job requires recalculation.
    if (query.resultNo === undefined && await this.checkRequiresRecalc(query.cutJobId)) {
      throw new ApiError(409, 'CUT_RECALC_REQUIRED', 'Требуется пересчёт раскроя перед печатью');
    }
    // Rule 4 (active): for variant=active each group resolves effectiveActive independently
    // (a mixed manual+auto job is fine). For variant=auto all groups use auto.
    const variant = query.variant ?? 'auto';
    const frozen = query.resultNo === undefined
      ? null
      : await this.getResult({
          currentUser: query.currentUser,
          cutJobId: query.cutJobId,
          resultNo: query.resultNo,
          requestId: query.requestId,
        });
    const templateSelection = resolvePdfTemplateSelection(
      query.pdfTemplate,
      frozen?.job.pdfTemplate,
    );
    const pdfTemplate = templateSelection.code;
    if (templateSelection.requiresActiveCheck) await this.assertPdfTemplateActive(pdfTemplate);
    const templateLayout = templateSelection.usesCurrentLayout
      ? await this.loadPdfTemplateLayout(pdfTemplate)
      : null;
    const pdfIdentity = await this.loadPdfRenderIdentity(query.cutJobId, query.resultNo);
    const pdfJobFields = await this.loadPdfRenderJobFields(query.cutJobId);
    const groupIds = frozen
      ? frozen.job.groups.map((group) => group.cutGroupId)
      : (await this.database.query<{ cut_group_id: string | number }>(
          `SELECT cut_group_id FROM cut_group WHERE cut_job_id = $1 ORDER BY cut_group_id`,
          [query.cutJobId],
        )).rows.map((row) => toNum(row.cut_group_id));
    const pdfSheets: PdfSheetInput[] = [];
    for (const cutGroupId of groupIds) {
      let frozenContext = frozen
        ? await this.loadFrozenRenderContext({
            currentUser: query.currentUser,
            cutJobId: query.cutJobId,
            resultNo: query.resultNo!,
            cutGroupId,
            variant,
            originTopLeft: query.originTopLeft,
            axisOrigin: query.axisOrigin,
            refreshPdfDynamicFields: true,
          })
        : null;
      const currentContext = frozenContext === null
        ? await this.loadGroupPdfLandscapeRenderContext(
            cutGroupId, variant, query.cutJobId, query.originTopLeft, query.axisOrigin,
          )
        : null;
      const initialSheets = frozenContext?.sheets ?? currentContext!.sheets;
      const first = initialSheets[0]?.placements;
      const rotate90 = frozenContext
        ? first !== undefined && first.sheet_height_mm > first.sheet_width_mm
        : currentContext!.rotate90;
      if (frozenContext && rotate90) {
        frozenContext = await this.loadFrozenRenderContext({
          currentUser: query.currentUser,
          cutJobId: query.cutJobId,
          resultNo: query.resultNo!,
          cutGroupId,
          variant,
          rotate90: true,
          originTopLeft: query.originTopLeft,
          axisOrigin: query.axisOrigin,
          refreshPdfDynamicFields: true,
        });
      }
      const sheets = frozenContext?.sheets ?? currentContext!.sheets;
      // Rule 8: skip blank sheets in PDF assembly.
      let sheetNumber = 1;
      for (const sheet of sheets) {
        if (sheet.placements.pieces.length === 0) continue;
        pdfSheets.push({
          svg: sheet.svg,
          bathSvg: sheet.bathSvg,
          sheetWidthMm: rotate90 ? sheet.placements.sheet_height_mm : sheet.placements.sheet_width_mm,
          sheetHeightMm: rotate90 ? sheet.placements.sheet_width_mm : sheet.placements.sheet_height_mm,
          sheetNumber,
          pageCount: 0,
          template: pdfTemplate,
          templateLayout,
          meta: sheet.pdfMeta,
          detailRows: sheet.pdfDetailRows,
          cutJobId: pdfIdentity.cutJobId ?? undefined,
          cutNumber: pdfIdentity.cutNumber ?? undefined,
          currentCutNumber: pdfIdentity.currentCutNumber ?? undefined,
          jobName: pdfJobFields.jobName,
          textureDirection: pdfJobFields.textureDirection,
          filmRequirementLinearMeters: sheet.filmRequirementLinearMeters,
        });
        sheetNumber += 1;
      }
    }
    if (pdfSheets.length === 0) {
      throw new CutJobNotFoundError(query.cutJobId);
    }
    for (const sheet of pdfSheets) sheet.pageCount = pdfSheets.length;
    return frozen && !templateSelection.usesCurrentLayout
      ? buildFrozenSheetsPdf('cut_sheet_render_v1', pdfSheets)
      : buildSheetsPdf(pdfSheets);
  }

  private async loadPdfRenderIdentity(
    cutJobId: number | undefined,
    requestedResultNo: number | undefined,
  ): Promise<PdfRenderIdentity> {
    if (cutJobId === undefined) return { cutJobId: null, cutNumber: null, currentCutNumber: null };
    const result = await this.database.query<{
      current_result_no: string | number | null;
      job_is_vacuum: boolean | null;
      source_display_number: string | number | null;
      current_snapshot_job: CutJobDto | null;
      requested_snapshot_job: CutJobDto | null;
    }>(
      `SELECT current_result.result_no AS current_result_no,
              j.source_display_number,
              COALESCE(
                j.last_calc_params->>'layout_mode',
                cpp.params->>'layout_mode',
                j.params->>'layout_mode'
              ) = 'vacuum_table' AS job_is_vacuum,
              current_result.snapshot_job AS current_snapshot_job,
              requested_result.snapshot_job AS requested_snapshot_job
       FROM cut_job j
       LEFT JOIN cut_result current_result ON current_result.cut_result_id = j.current_cut_result_id
       LEFT JOIN cut_result requested_result
         ON requested_result.cut_job_id = j.cut_job_id
        AND requested_result.result_no = $2::integer
       LEFT JOIN cut_param_profiles cpp ON cpp.cut_param_profile_id = j.param_profile_id
       WHERE j.cut_job_id = $1`,
      [cutJobId, requestedResultNo ?? null],
    );
    const row = result.rows[0];
    const currentResultNo = numOrNull(row?.current_result_no);
    const resultNo = requestedResultNo ?? currentResultNo;
    const currentIsVacuum = cutJobSnapshotUsesVacuumTable(row?.current_snapshot_job) || row?.job_is_vacuum === true;
    const requestedIsVacuum = requestedResultNo === undefined
      ? currentIsVacuum
      : cutJobSnapshotUsesVacuumTable(row?.requested_snapshot_job) || row?.job_is_vacuum === true;
    return {
      cutJobId,
      cutNumber: resultNo === null ? null : formatCutNumber(cutJobId, resultNo, requestedIsVacuum, row?.source_display_number),
      currentCutNumber: currentResultNo === null ? null : formatCutNumber(cutJobId, currentResultNo, currentIsVacuum, row?.source_display_number),
    };
  }

  private async loadPdfRenderJobFields(cutJobId: number | undefined, cutGroupId?: number): Promise<PdfRenderJobFields> {
    const fallback: PdfRenderJobFields = { jobName: '', textureDirection: '' };
    if (cutJobId === undefined && cutGroupId === undefined) return fallback;
    const row = await this.database.query<{ name: string; texture_direction: string | null }>(
      cutJobId === undefined
        ? `SELECT j.name, j.texture_direction
           FROM cut_group g
           JOIN cut_job j ON j.cut_job_id = g.cut_job_id
           WHERE g.cut_group_id = $1`
        : `SELECT name, texture_direction
           FROM cut_job
           WHERE cut_job_id = $1`,
      [cutJobId ?? cutGroupId],
    );
    const job = row.rows[0];
    if (!job) {
      if (cutJobId !== undefined) throw new CutJobNotFoundError(cutJobId);
      return fallback;
    }
    return {
      jobName: job.name,
      textureDirection: cutTextureDirectionLabel(job.texture_direction),
    };
  }

  private async loadGroupPdfLandscapeRenderContext(
    cutGroupId: number,
    variant: 'auto' | 'manual' | 'active',
    cutJobId: number | undefined,
    originTopLeft = true,
    axisOrigin: 'top-left' | 'bottom-left' = 'top-left',
  ): Promise<{ sheets: RenderedSheetContext[]; rotate90: boolean }> {
    const raw = await this.loadGroupRenderContext(cutGroupId, false, originTopLeft, axisOrigin, variant, cutJobId);
    const firstSheet = raw.sheets[0]?.placements;
    const rotate90 = firstSheet !== undefined && firstSheet.sheet_height_mm > firstSheet.sheet_width_mm;
    if (!rotate90) return { sheets: raw.sheets, rotate90: false };
    const rotated = await this.loadGroupRenderContext(cutGroupId, true, originTopLeft, axisOrigin, variant, cutJobId);
    return { sheets: rotated.sheets, rotate90: true };
  }

  private async assertPdfTemplateActive(code: string, client: DatabaseClient | TransactionClient = this.database): Promise<void> {
    const row = await client.query<{ code: string }>(
      `SELECT code FROM cut_pdf_templates WHERE code = $1 AND is_active = true LIMIT 1`,
      [code],
    );
    if (row.rowCount === 0) {
      throw new ApiError(422, 'CUT_PDF_TEMPLATE_NOT_FOUND', 'Выбранный шаблон PDF не найден или неактивен', { code });
    }
  }

  private async loadPdfTemplateLayout(code: string, client: DatabaseClient | TransactionClient = this.database): Promise<Record<string, unknown> | null> {
    const row = await client.query<{ layout: Record<string, unknown> | null }>(
      `SELECT layout FROM cut_pdf_templates WHERE code = $1 AND is_active = true LIMIT 1`,
      [code],
    );
    const layout = row.rows[0]?.layout;
    return layout && typeof layout === 'object' && !Array.isArray(layout) ? layout : null;
  }

  async setPdfPrewarmState(query: SetPdfPrewarmStateQuery): Promise<void> {
    // Scope the write to the version the render was kicked for: a slow render of
    // version N must not clobber the state of a newer recalculation (version N+1).
    await this.database.query(
      `UPDATE cut_job SET pdf_prewarm_state = $2, pdf_prewarm_failure_reason = $3, updated_at = now()
       WHERE cut_job_id = $1 AND version = $4`,
      [query.cutJobId, query.state, query.reason ?? null, query.version],
    );
  }

  private async loadRenderDetailsForGroup(
    cutGroupId: number,
    client: DatabaseClient = this.database,
  ): Promise<{
    detailById: Map<number, RenderDetailInfo>;
    fillByOrder: (orderId: number | null) => string;
    orderNameForOrderId: (orderId: number | null) => string | null;
  }> {
    // Live detail/dynamic-field lookup. PDF render paths call this on every
    // render so volatile relations (especially CNC packet/card matches) do not
    // come from stale render snapshots or warmed PDF bytes.
    const items = await client.query<{
      order_detail_id: string | number;
      order_id: string | number;
      detail_fields: Record<string, unknown> | null;
      detail_number: string | number | null;
      width: string | number | null;
      height: string | number | null;
      sheet_material_type_id: string | number | null;
      material_id: string | number | null;
      material_name: string | null;
      thickness_mm: string | number | null;
      film_name: string | null;
      milling_type_name: string | null;
      edge_type_name: string | null;
      production_status_name: string | null;
      doweling: boolean | null;
      machine_files: string[] | null;
      order_name: string | null;
      order_date: string | Date | null;
      completion_date: string | Date | null;
      planned_completion_date: string | Date | null;
      client_name: string | null;
      order_delete_flag: boolean | null;
    }>(
      // material_name = sheet-material name (COALESCE sheet_material_type, legacy
      // material) for tooltips/PDF metadata. Piece labels intentionally stay
      // three-line only: order, position, size.
      `SELECT cji.order_detail_id, cji.order_id,
              to_jsonb(od) AS detail_fields,
              od.detail_number, od.width, od.height,
              od.sheet_material_type_id, od.material_id,
              od.doweling,
              COALESCE(smt.name, m.material_name) AS material_name,
              smt.thickness_mm, f.film_name,
              mt.milling_type_name, et.edge_type_name, ps.production_status_name,
              cnc.machine_files,
              o.order_name, o.delete_flag AS order_delete_flag,
              o.order_date, o.completion_date, o.planned_completion_date,
              c.client_name
       FROM cut_job_item cji
       LEFT JOIN order_details od ON od.detail_id = cji.order_detail_id AND od.delete_flag = false
       LEFT JOIN materials m ON m.material_id = od.material_id
       LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = od.sheet_material_type_id
       LEFT JOIN films f ON f.film_id = od.film_id
       LEFT JOIN milling_types mt ON mt.milling_type_id = od.milling_type_id
       LEFT JOIN edge_types et ON et.edge_type_id = od.edge_type_id
       LEFT JOIN production_statuses ps ON ps.production_status_id = od.production_status_id
       LEFT JOIN LATERAL (
         SELECT array_agg(machine_file ORDER BY machine_file) AS machine_files
         FROM (
           SELECT DISTINCT COALESCE(NULLIF(trim(p.program_name), ''), p.external_packet_key) AS machine_file
           FROM cnc_telegram_packet_items cti
           JOIN cnc_telegram_packets p ON p.packet_id = cti.packet_id
           JOIN (
             SELECT max(p2.workday) AS latest_workday
             FROM cnc_telegram_packet_items cti2
             JOIN cnc_telegram_packets p2 ON p2.packet_id = cti2.packet_id
             WHERE cti2.match_detail_id = od.detail_id
               AND cti2.match_status = 'matched'
           ) latest ON latest.latest_workday = p.workday
           WHERE cti.match_detail_id = od.detail_id
             AND cti.match_status = 'matched'
         ) machine_file_rows
       ) cnc ON true
       LEFT JOIN orders o ON o.order_id = cji.order_id
       LEFT JOIN clients c ON c.client_id = o.client_id
       WHERE cji.cut_group_id = $1
       ORDER BY cji.cut_job_item_id`,
      [cutGroupId],
    );
    const detailById = new Map<number, RenderDetailInfo>();
    for (const row of items.rows) {
      // Prefer the sheet-material-type id (Variant-B primary ref); fall back to the
      // legacy material id; else the trimmed name; else null (unknown → ignored).
      const smtId = numOrNull(row.sheet_material_type_id);
      const matId = numOrNull(row.material_id);
      const nm = row.material_name?.trim();
      const materialKey = smtId !== null ? `s${smtId}` : matId !== null ? `m${matId}` : nm ? `n${nm}` : null;
      detailById.set(toNum(row.order_detail_id), {
        orderId: toNum(row.order_id),
        detailNumber: numOrNull(row.detail_number),
        widthMm: numOrNull(row.width),
        heightMm: numOrNull(row.height),
        detailFields: row.detail_fields ?? null,
        doweling: row.doweling === null || row.doweling === undefined ? null : row.doweling === true,
        machineFiles: normalizeMachineFiles(row.machine_files),
        materialName: row.material_name ?? null,
        thicknessMm: numOrNull(row.thickness_mm),
        filmName: row.film_name ?? null,
        millingTypeName: row.milling_type_name ?? null,
        edgeTypeName: row.edge_type_name ?? null,
        productionStatusName: row.production_status_name ?? null,
        orderName: row.order_name ?? null,
        orderDeleted: row.order_delete_flag === true,
        orderDate: dateOnly(row.order_date),
        readyDate: dateOnly(row.completion_date) ?? dateOnly(row.planned_completion_date),
        clientName: row.client_name ?? null,
        materialKey,
      });
    }
    const fillByOrder = createOrderFillResolver(items.rows.map((row) => toNum(row.order_id)));
    const orderNameById = new Map<number, string>();
    for (const row of items.rows) {
      const name = row.order_name?.trim();
      if (name) orderNameById.set(toNum(row.order_id), name);
    }
    const orderNameForOrderId = (orderId: number | null): string | null =>
      orderId === null ? null : orderNameById.get(orderId) ?? null;
    return { detailById, fillByOrder, orderNameForOrderId };
  }

  private async refreshPdfDynamicFieldsForSheets(
    cutGroupId: number,
    sheets: RenderedSheetContext[],
    client: DatabaseClient = this.database,
  ): Promise<RenderedSheetContext[]> {
    const { detailById } = await this.loadRenderDetailsForGroup(cutGroupId, client);
    return sheets.map((sheet) => ({
      ...sheet,
      pdfMeta: buildPdfSheetMeta(sheet.placements, detailById),
      pdfDetailRows: buildPdfDetailRows(sheet.placements, detailById),
    }));
  }

  /**
   * Cut-gated sheet-type lookup (Variant B Task 11). Returns the minimal set of
   * fields needed for the /cut filter: id, name, dims, is_cuttable.
   * Active types only — inactive types are not selectable as cut criteria.
   * No cut.manage or sheet_materials.view required — cut.view is sufficient.
   */
  async listSheetTypesForCut(
    _query: import('../application/cut-command.types').ListSheetTypesForCutQuery,
  ): Promise<import('../application/cut-command.types').CutSheetTypeOption[]> {
    const result = await this.database.query<{
      sheet_material_type_id: string | number;
      name: string;
      material_type_id: string | number;
      thickness_mm: string | number;
      width_mm: string | number;
      height_mm: string | number;
      is_cuttable: boolean | null;
    }>(
      `SELECT sheet_material_type_id, name, material_type_id, thickness_mm, width_mm, height_mm, is_cuttable
       FROM sheet_material_types
       WHERE is_active = true AND is_cuttable = true
       ORDER BY name`,
    );
    return result.rows.map((row) => ({
      sheetMaterialTypeId: toNum(row.sheet_material_type_id),
      name: row.name,
      materialTypeId: toNum(row.material_type_id),
      thicknessMm: toNum(row.thickness_mm),
      widthMm: toNum(row.width_mm),
      heightMm: toNum(row.height_mm),
      isCuttable: row.is_cuttable == null ? true : Boolean(row.is_cuttable),
    }));
  }

  /**
   * Load every sheet of a group as a ready-to-render SVG, with per-group label
   * context (frozen label snapshot or live order/detail fallback) and fill-by-order
   * coloring. Shared by PNG/SVG/PDF render paths.
   *
   * Task 7 additions:
   *   - `variant`: which sheet source to use (auto/manual/active).
   *   - `cutJobId`: when provided, asserts the group belongs to the job (rule 6).
   *   - Frozen label snapshot used when `piece.label` is present (rule 7).
   *   - Blank sheets included for PNG/SVG (index-stable); caller filters for PDF.
   */
  private async loadGroupRenderContext(
    cutGroupId: number,
    rotate90 = false,
    originTopLeft = false,
    axisOrigin: 'top-left' | 'bottom-left' = 'top-left',
    variant: 'auto' | 'manual' | 'active' = 'auto',
    cutJobId?: number,
    showLabels = true,
    client: DatabaseClient = this.database,
    allowStaleManual = false,
    renderStyle: CutRenderStyleName = CUT_RENDER_STYLE_DEFAULT,
  ): Promise<{ sheets: RenderedSheetContext[] }> {
    // Rule 6: load group metadata + assert job ownership when cutJobId provided.
    const groupRes = await client.query<{
      cut_job_id: string | number;
      group_key: string | null;
      summary: Record<string, unknown> | null;
      last_calc_params: FreecutParams | null;
      sheet_material_name: string | null;
      sheet_material_width_mm: string | number | null;
      sheet_material_height_mm: string | number | null;
    }>(
      `SELECT cg.cut_job_id,
              cg.group_key,
              cg.summary,
              cj.last_calc_params,
              smt.name AS sheet_material_name,
              smt.width_mm AS sheet_material_width_mm,
              smt.height_mm AS sheet_material_height_mm
       FROM cut_group cg
       JOIN cut_job cj ON cj.cut_job_id = cg.cut_job_id
       LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = cg.sheet_material_type_id
       WHERE cg.cut_group_id = $1`,
      [cutGroupId],
    );
    if (groupRes.rows.length === 0) {
      throw new CutGroupSheetNotFoundError(cutGroupId, 0);
    }
    const resolvedJobId = toNum(groupRes.rows[0].cut_job_id);
    const groupKey = groupRes.rows[0].group_key ?? null;
    const showBathMeterGuides = shouldShowBathMeterGuides({
      engineUsed: groupRes.rows[0].summary?.engine_used,
      layoutMode: groupRes.rows[0].last_calc_params?.layout_mode,
      materialName: groupRes.rows[0].sheet_material_name,
      materialWidthMm: groupRes.rows[0].sheet_material_width_mm,
      materialHeightMm: groupRes.rows[0].sheet_material_height_mm,
    });

    if (cutJobId !== undefined && resolvedJobId !== cutJobId) {
      throw new ApiError(
        404,
        'CUT_GROUP_NOT_FOUND',
        `cut_group ${cutGroupId} не принадлежит заданию ${cutJobId}`,
      );
    }

    // Load manual layout for variant resolution.
    const manualLayout = groupKey
      ? await this.getManualLayoutByKey(resolvedJobId, groupKey, client)
      : null;

    // Rule 3: resolve effective variant.
    const effectiveVariant = variant === 'manual' && allowStaleManual && manualLayout !== null
      ? 'manual'
      : resolveEffectiveVariant(variant, manualLayout);

    // Rule 3: for explicit `manual` requests, hard-fail when layout is unavailable.
    if (variant === 'manual' && effectiveVariant !== 'manual') {
      throw new ApiError(
        409,
        'CUT_MANUAL_LAYOUT_UNAVAILABLE',
        'Ручная раскладка недоступна или устарела для этой группы. Используйте автоматическую раскладку.',
      );
    }

    // Resolve the sheets source based on effective variant.
    let rawSheets: Array<{ sheetIndex: number; placements: SheetPlacementsJson }>;

    if (effectiveVariant === 'manual' && manualLayout !== null) {
      // Use manual layout sheets (includes blank retained-stock sheets).
      rawSheets = manualLayout.sheets.map((s) => ({ sheetIndex: s.sheetIndex, placements: s.placements }));
    } else {
      // Auto variant: read from cut_group_sheet.
      const autoSheets = await client.query<{ sheet_index: number; placements: SheetPlacementsJson }>(
        `SELECT cgs.sheet_index, cgs.placements FROM cut_group_sheet cgs WHERE cgs.cut_group_id = $1 ORDER BY cgs.sheet_index`,
        [cutGroupId],
      );
      rawSheets = autoSheets.rows.map((row) => ({ sheetIndex: toNum(row.sheet_index), placements: row.placements }));
    }

    const groupInvariantError = validateSheetGroupInvariant(rawSheets);
    if (groupInvariantError) {
      throw new ApiError(500, 'CUT_LAYOUT_INCONSISTENT', `Несовместимые листы в группе: ${groupInvariantError}`);
    }

    const renderStyleRule = await this.config.getRenderStyleRule(renderStyle);
    const quantities = computeGroupItemQuantities(
      rawSheets.map((s) => ({ sheetIndex: s.sheetIndex, placements: s.placements })),
    );

    // Rule 7: build live detail lookup for LEGACY rows (pre-Task 4) that lack
    // a frozen label snapshot. New rows written by calculate always have piece.label.
    const { detailById, fillByOrder: baseFillByOrder, orderNameForOrderId } = await this.loadRenderDetailsForGroup(cutGroupId, client);
    const fillByOrder = renderStyle === CUT_RENDER_STYLE_DEFAULT
      ? baseFillByOrder
      : createOrderFillResolver([...detailById.values()].map((detail) => detail.orderId), renderStyleRule);

    const labelForPiece = (piece: FreecutPlacement): string[] => {
      // Rule 7: use the frozen label snapshot when present (calc persists it).
      // Fall back to the live order_details join ONLY for legacy pre-Task-4 rows
      // whose stored placements have no label field.
      const frozenLabel = (piece as { label?: PieceLabelSnapshot }).label;
      if (frozenLabel) {
        return composePieceLabelLines({
          orderId: frozenLabel.orderId,
          orderName: frozenLabel.orderName ?? orderNameForOrderId(frozenLabel.orderId),
          detailId: frozenLabel.detailId ?? parseFreecutItemId(piece.item_id),
          detailNumber: frozenLabel.detailNumber,
          widthMm: frozenLabel.widthMm,
          heightMm: frozenLabel.heightMm,
          itemId: piece.item_id,
          instance: piece.instance,
          qty: quantities.get(piece.item_id) ?? 1,
        });
      }
      // Legacy fallback: live join.
      const detailId = parseFreecutItemId(piece.item_id);
      const detail = detailId === null ? null : detailById.get(detailId) ?? null;
      const orderId = detail?.orderId ?? null;
      return composePieceLabelLines({
        orderId,
        orderName: detail?.orderName ?? orderNameForOrderId(orderId),
        detailId,
        detailNumber: detail?.detailNumber ?? null,
        widthMm: detail?.widthMm ?? null,
        heightMm: detail?.heightMm ?? null,
        itemId: piece.item_id,
        instance: piece.instance,
        qty: quantities.get(piece.item_id) ?? 1,
      });
    };

    const fillFor = (piece: FreecutPlacement): string => {
      // For fill color, prefer the frozen orderId from the label snapshot.
      const frozenLabel = (piece as { label?: PieceLabelSnapshot }).label;
      const orderId = frozenLabel?.orderId !== undefined
        ? frozenLabel.orderId
        : (parseFreecutItemId(piece.item_id) === null
          ? null
          : detailById.get(parseFreecutItemId(piece.item_id)!)?.orderId ?? null);
      return fillByOrder(orderId);
    };
    const bathDetailInfoFor = (piece: FreecutPlacement) => {
      const detailId = parseFreecutItemId(piece.item_id);
      const detail = detailId === null ? null : detailById.get(detailId) ?? null;
      return {
        edgeTypeName: detail?.edgeTypeName ?? null,
        millingTypeName: detail?.millingTypeName ?? null,
        doweling: detail?.doweling ?? false,
      };
    };

    return {
      sheets: rawSheets.map((s) => {
        const labelFor = (piece: FreecutPlacement): string[] => labelForPiece(piece);
        return {
          sheetIndex: s.sheetIndex,
          placements: s.placements,
          svg: buildSheetSvg({
            sheet: s.placements,
            labelFor,
            fillFor,
            rotate90,
            originTopLeft,
            axisOrigin,
            showLabels,
            showBathMeterGuides,
            renderStyle: renderStyleRule,
          }),
          bathSvg: buildBathProfileSheetSvg({
            sheet: s.placements,
            labelFor,
            bathDetailInfoFor,
            fillFor,
            rotate90,
            originTopLeft,
            axisOrigin,
            showBathMeterGuides,
          }),
          pdfMeta: buildPdfSheetMeta(s.placements, detailById),
          pdfDetailRows: buildPdfDetailRows(s.placements, detailById),
          filmRequirementLinearMeters: showBathMeterGuides
            ? calculateBathSheetFilmUsage(s.placements)?.linearMeters ?? null
            : null,
        };
      }),
    };
  }

  /**
   * Non-throwing recalculation check: returns true when the current calc inputs
   * diverge from the stored last_calc_basis (same logic as getJob.requiresRecalc).
   * Used by PDF render endpoints to enforce the print-block (rule 5).
   */
  private async checkRequiresRecalc(cutJobId: number): Promise<boolean> {
    const calcRow = await this.database.query<{ last_calc_basis: string | null }>(
      `SELECT last_calc_basis FROM cut_job WHERE cut_job_id = $1`,
      [cutJobId],
    );
    const lastCalcBasis = calcRow.rows[0]?.last_calc_basis ?? null;
    const basisInputs = await this.loadCurrentCalcBasisInputs(cutJobId);
    if (basisInputs !== null && lastCalcBasis !== null) {
      return basisOf(basisInputs) !== lastCalcBasis;
    }
    return true; // null basis (never calculated) → conservative: requiresRecalc
  }

  /**
   * Task 7 Rule 9: opaque server-owned render cache token. Changes whenever the
   * rendered output for the given scope would change:
   *   - For a group: job version + manual layout version + effectiveActive.
   *   - For a job: job version + per-group tokens aggregated.
   * 'active' variant semantics are always used (mirrors getJob.renderToken logic).
   */
  async getRenderCacheToken(args: GetRenderCacheTokenArgs): Promise<string> {
    if (args.cutGroupId !== undefined) {
      // Group-scoped token.
      const groupRes = await this.database.query<{
        cut_job_id: string | number;
        group_key: string | null;
      }>(
        `SELECT cut_job_id, group_key FROM cut_group WHERE cut_group_id = $1`,
        [args.cutGroupId],
      );
      // FIX 5: surface a missing group instead of masking it as job 0 (which would
      // mint a bogus stable token and let a wrong group share a cache slot).
      if (groupRes.rows.length === 0) {
        throw new CutGroupSheetNotFoundError(args.cutGroupId, 0);
      }
      const resolvedJobId = toNum(groupRes.rows[0].cut_job_id);
      const groupKey = groupRes.rows[0].group_key ?? null;

      const jobRes = await this.database.query<{ version: string | number }>(
        `SELECT version FROM cut_job WHERE cut_job_id = $1`,
        [resolvedJobId],
      );
      const jobVersion = toNum(jobRes.rows[0]?.version ?? 0);

      const manual = groupKey ? await this.getManualLayoutByKey(resolvedJobId, groupKey) : null;
      const effectiveActive = manual !== null && manual.isActive && !manual.isStale;
      const manualVersion = manual?.version ?? 0;

      return `j${jobVersion}:m${manualVersion}:a${effectiveActive ? 1 : 0}`;
    }

    if (args.cutJobId !== undefined) {
      // Job-scoped token: aggregate from job version + all groups.
      const jobRes = await this.database.query<{ version: string | number }>(
        `SELECT version FROM cut_job WHERE cut_job_id = $1`,
        [args.cutJobId],
      );
      const jobVersion = toNum(jobRes.rows[0]?.version ?? 0);

      const groupsRes = await this.database.query<{ cut_group_id: string | number; group_key: string | null }>(
        `SELECT cut_group_id, group_key FROM cut_group WHERE cut_job_id = $1 ORDER BY cut_group_id`,
        [args.cutJobId],
      );

      const manualLayouts = await this.listManualLayoutsForJob(args.cutJobId);
      const mlByKey = new Map(manualLayouts.map((ml) => [ml.groupKey, ml]));

      const groupTokenParts = groupsRes.rows.map((row) => {
        const gKey = row.group_key ?? null;
        const ml = gKey ? (mlByKey.get(gKey) ?? null) : null;
        const effectiveActive = ml !== null && ml.isActive && !ml.isStale;
        const mlVersion = ml?.version ?? 0;
        return `g${toNum(row.cut_group_id)}:m${mlVersion}:a${effectiveActive ? 1 : 0}`;
      });

      return `j${jobVersion}:${groupTokenParts.join(',')}`;
    }

    return 'none';
  }

  private async reserveDetail(
    tx: TransactionClient,
    cutJobId: number,
    detailId: number,
    readyStatusIds: readonly number[],
  ): Promise<{ orderId: number; sheetMaterialTypeId: number | null; inserted: boolean }> {
    // Resolve the detail WITH its eligibility inputs (status + sheet spec + is_cuttable)
    // so the backend enforces eligibility itself — never trusting the frontend's list
    // (Critic BLOCKER). delete_flag / wrong_status / not_cuttable / no_sheet_spec are
    // rejected here.
    const detail = await tx.query<{
      order_id: string | number;
      quantity: string | number;
      production_status_id: number | null;
      delete_flag: boolean;
      sheet_material_type_id: string | number | null;
      is_cuttable: boolean | null;
    }>(
      `SELECT od.order_id, od.quantity, od.production_status_id, od.delete_flag,
              od.sheet_material_type_id, s.is_cuttable
       FROM order_details od
       LEFT JOIN sheet_material_types s ON s.sheet_material_type_id = od.sheet_material_type_id
       WHERE od.detail_id = $1`,
      [detailId],
    );
    if (detail.rowCount === 0) {
      throw new CutOrderDetailNotFoundError(detailId);
    }
    const row = detail.rows[0];
    const sheetMaterialTypeId = row.sheet_material_type_id === null ? null : toNum(row.sheet_material_type_id);
    const eligibility = classifyDetailEligibility(
      {
        detailId,
        deleteFlag: row.delete_flag,
        productionStatusId: row.production_status_id === null ? null : toNum(row.production_status_id),
        sheetMaterialTypeId,
        isCuttable: row.is_cuttable == null ? true : Boolean(row.is_cuttable),
      },
      { readyStatusIds },
    );
    if (!eligibility.eligible) {
      throw new CutDetailNotEligibleError(detailId, eligibility.reason ?? 'ineligible');
    }
    const orderId = toNum(row.order_id);
    const quantity = toNum(row.quantity);
    // Placement is non-exclusive across jobs (migration 031): the same detail may be
    // in many jobs. WITHIN one job it is unique-and-idempotent — re-adding the same
    // detail is a no-op (ON CONFLICT on the per-job partial unique index), so the
    // requested cut quantity is never silently doubled. `inserted` reports whether a
    // NEW row was actually written, so callers can avoid version/audit churn on no-ops.
    const insert = await tx.query(
      `
      INSERT INTO cut_job_item (cut_job_id, order_detail_id, order_id, qty, is_active, freecut_item_id)
      VALUES ($1, $2, $3, $4, true, $5)
      ON CONFLICT (cut_job_id, order_detail_id) WHERE is_active = true DO NOTHING
      RETURNING cut_job_item_id
      `,
      [cutJobId, detailId, orderId, quantity, freecutItemId(detailId)],
    );
    return { orderId, sheetMaterialTypeId, inserted: (insert.rowCount ?? 0) > 0 };
  }

  private async resolveReadyStatusIds(): Promise<number[]> {
    const readyStatusCodes = await this.config.getReadyStatusCodes();
    const result = await this.database.query<{ production_status_id: string | number }>(
      `SELECT production_status_id FROM production_statuses WHERE production_status_code = ANY($1::text[])`,
      [[...readyStatusCodes]],
    );
    return result.rows.map((row) => toNum(row.production_status_id));
  }

  private async audit(
    tx: TransactionClient,
    currentUser: CurrentUser,
    input: {
      event: (typeof CUT_AUDIT_EVENTS)[keyof typeof CUT_AUDIT_EVENTS];
      cutJobId: number;
      requestId?: string;
      related?: {
        orderIds?: number[];
        sheetMaterialTypeIds?: Array<number | null>;
        cutGroupIds?: number[];
        cutResultIds?: number[];
      };
      metadata?: Record<string, unknown> | null;
      before?: Record<string, unknown> | null;
      after?: Record<string, unknown> | null;
      diff?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    const actor: CutAuditActor = {
      id: currentUser.id,
      username: currentUser.username,
      role: currentUser.role,
    };
    await auditService.record(
      tx,
      buildCutAuditEvent({
        event: input.event,
        cutJobId: input.cutJobId,
        actor,
        requestId: input.requestId ?? AUDIT_SOURCE,
        source: AUDIT_SOURCE,
        related: {
          orderIds: cleanIds(input.related?.orderIds),
          sheetMaterialTypeIds: cleanIds(input.related?.sheetMaterialTypeIds),
          cutGroupIds: cleanIds(input.related?.cutGroupIds),
          cutResultIds: cleanIds(input.related?.cutResultIds),
        },
        metadata: input.metadata ?? null,
        before: input.before ?? null,
        after: input.after ?? null,
        diff: input.diff ?? null,
      }),
    );
  }

  async setProfile(command: SetCutJobProfileCommand): Promise<CutJobDto> {
    await this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const jobRes = await tx.query<{ cut_job_id: string | number; status: string; version: string | number; param_profile_id: string | number | null }>(
        `SELECT cut_job_id, status, version, param_profile_id FROM cut_job WHERE cut_job_id = $1 FOR UPDATE`,
        [command.cutJobId],
      );
      const row = jobRes.rows[0];
      if (!row) throw new CutJobNotFoundError(command.cutJobId);
      assertVersion({ cutJobId: command.cutJobId, version: toNum(row.version) }, command.version);
      if (!PROFILE_EDITABLE_STATUSES.has(row.status)) {
        throw new CutJobNotMutableError(command.cutJobId, row.status);
      }
      if (command.paramProfileId !== null) {
        const exists = await tx.query(
          `SELECT 1 FROM cut_param_profiles WHERE cut_param_profile_id = $1 AND is_active = true LIMIT 1`,
          [command.paramProfileId],
        );
        if (exists.rows.length === 0) throw new CutParamProfileNotFoundError(command.paramProfileId);
      }
      const beforeProfileId = row.param_profile_id === null ? null : toNum(row.param_profile_id);

      // No-op short-circuit (fixes [AUDIT-DEBT]/[NOTIFICATION-DEBT]): an unchanged
      // selection must NOT bump version, write audit, or emit an outbox event —
      // mirrors the repo's existing no-op handling and prevents fake
      // profile_changed rows + needless stale-version conflicts on replays.
      if (beforeProfileId === command.paramProfileId) {
        return;
      }

      await tx.query(
        `UPDATE cut_job SET param_profile_id = $2, version = version + 1, updated_at = now() WHERE cut_job_id = $1`,
        [command.cutJobId, command.paramProfileId],
      );

      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.profileChanged,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        before: { paramProfileId: beforeProfileId },
        after: { paramProfileId: command.paramProfileId },
        metadata: { beforeProfileId, afterProfileId: command.paramProfileId },
      });

      await tx.query(
        `
        INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
        VALUES ($1, $2, $3, $4::jsonb, $5)
        ON CONFLICT (idempotency_key) DO NOTHING
        `,
        [
          CUT_AUDIT_EVENTS.profileChanged,
          'cut_job',
          String(command.cutJobId),
          JSON.stringify({
            cutJobId: command.cutJobId,
            beforeProfileId,
            afterProfileId: command.paramProfileId,
            actorUserId: command.currentUser.id,
            requestId: command.requestId ?? null,
          }),
          profileChangedOutboxKey(command.cutJobId, command.requestId, command.version),
        ],
      );
    });
    return this.getJob({ currentUser: command.currentUser, cutJobId: command.cutJobId });
  }

  async setSheetMaterial(command: SetCutJobSheetMaterialCommand): Promise<CutJobDto> {
    await this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const jobRes = await tx.query<{ status: string; version: string | number; sheet_material_type_id: string | number | null }>(
        `SELECT status, version, sheet_material_type_id FROM cut_job WHERE cut_job_id = $1 FOR UPDATE`,
        [command.cutJobId],
      );
      const row = jobRes.rows[0];
      if (!row) throw new CutJobNotFoundError(command.cutJobId);
      assertVersion({ cutJobId: command.cutJobId, version: toNum(row.version) }, command.version);
      if (!PROFILE_EDITABLE_STATUSES.has(row.status)) {
        throw new CutJobNotMutableError(command.cutJobId, row.status);
      }
      if (command.sheetMaterialTypeId !== null) {
        const exists = await tx.query(
          `SELECT 1 FROM sheet_material_types WHERE sheet_material_type_id = $1 AND is_active = true AND is_cuttable = true LIMIT 1`,
          [command.sheetMaterialTypeId],
        );
        if (exists.rows.length === 0) throw new CutSheetMaterialNotCuttableError(command.sheetMaterialTypeId);
      }
      const beforeId = row.sheet_material_type_id === null ? null : toNum(row.sheet_material_type_id);

      // No-op short-circuit: an unchanged selection must NOT bump version,
      // write audit, or emit an outbox event.
      if (beforeId === command.sheetMaterialTypeId) {
        return;
      }

      await tx.query(
        `UPDATE cut_job SET sheet_material_type_id = $2, version = version + 1, updated_at = now() WHERE cut_job_id = $1`,
        [command.cutJobId, command.sheetMaterialTypeId],
      );

      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.sheetMaterialChanged,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        related: { sheetMaterialTypeIds: [beforeId, command.sheetMaterialTypeId] },
        before: { sheetMaterialTypeId: beforeId },
        after: { sheetMaterialTypeId: command.sheetMaterialTypeId },
        metadata: { beforeSheetMaterialTypeId: beforeId, afterSheetMaterialTypeId: command.sheetMaterialTypeId },
      });

      await tx.query(
        `
        INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
        VALUES ($1, $2, $3, $4::jsonb, $5)
        ON CONFLICT (idempotency_key) DO NOTHING
        `,
        [
          CUT_AUDIT_EVENTS.sheetMaterialChanged,
          'cut_job',
          String(command.cutJobId),
          JSON.stringify({
            cutJobId: command.cutJobId,
            beforeSheetMaterialTypeId: beforeId,
            afterSheetMaterialTypeId: command.sheetMaterialTypeId,
            actorUserId: command.currentUser.id,
            requestId: command.requestId ?? null,
          }),
          sheetMaterialChangedOutboxKey(command.cutJobId, command.requestId, command.version),
        ],
      );
    });
    return this.getJob({ currentUser: command.currentUser, cutJobId: command.cutJobId });
  }

  async setCombineFilms(command: SetCutJobCombineFilmsCommand): Promise<CutJobDto> {
    await this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const jobRes = await tx.query<{ status: string; version: string | number; combine_films: boolean | null }>(
        `SELECT status, version, combine_films FROM cut_job WHERE cut_job_id = $1 FOR UPDATE`,
        [command.cutJobId],
      );
      const row = jobRes.rows[0];
      if (!row) throw new CutJobNotFoundError(command.cutJobId);
      assertVersion({ cutJobId: command.cutJobId, version: toNum(row.version) }, command.version);
      if (!PROFILE_EDITABLE_STATUSES.has(row.status)) {
        throw new CutJobNotMutableError(command.cutJobId, row.status);
      }
      const before = row.combine_films === true;

      // No-op short-circuit: an unchanged value must NOT bump version, write
      // audit, or emit an outbox event.
      if (before === command.combineFilms) {
        return;
      }

      await tx.query(
        `UPDATE cut_job SET combine_films = $2, version = version + 1, updated_at = now() WHERE cut_job_id = $1`,
        [command.cutJobId, command.combineFilms],
      );
      // Grouping changes: existing manual layouts keyed by old group_key are no longer valid.
      await this.invalidateManualLayoutsForJob(tx, command.cutJobId, 'combine_films_changed');

      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.combineFilmsChanged,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        before: { combineFilms: before },
        after: { combineFilms: command.combineFilms },
        metadata: { beforeCombineFilms: before, afterCombineFilms: command.combineFilms },
      });

      await tx.query(
        `
        INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
        VALUES ($1, $2, $3, $4::jsonb, $5)
        ON CONFLICT (idempotency_key) DO NOTHING
        `,
        [
          CUT_AUDIT_EVENTS.combineFilmsChanged,
          'cut_job',
          String(command.cutJobId),
          JSON.stringify({
            cutJobId: command.cutJobId,
            beforeCombineFilms: before,
            afterCombineFilms: command.combineFilms,
            actorUserId: command.currentUser.id,
            requestId: command.requestId ?? null,
          }),
          combineFilmsChangedOutboxKey(command.cutJobId, command.requestId, command.version),
        ],
      );
    });
    return this.getJob({ currentUser: command.currentUser, cutJobId: command.cutJobId });
  }

  async setSplitByMaterial(command: SetCutJobSplitByMaterialCommand): Promise<CutJobDto> {
    await this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const jobRes = await tx.query<{ status: string; version: string | number; split_by_material: boolean | null }>(
        `SELECT status, version, split_by_material FROM cut_job WHERE cut_job_id = $1 FOR UPDATE`,
        [command.cutJobId],
      );
      const row = jobRes.rows[0];
      if (!row) throw new CutJobNotFoundError(command.cutJobId);
      assertVersion({ cutJobId: command.cutJobId, version: toNum(row.version) }, command.version);
      if (!PROFILE_EDITABLE_STATUSES.has(row.status)) {
        throw new CutJobNotMutableError(command.cutJobId, row.status);
      }
      const before = row.split_by_material !== false;

      // No-op short-circuit: an unchanged value must NOT bump version, write audit,
      // or emit an outbox event.
      if (before === command.splitByMaterial) {
        return;
      }

      await tx.query(
        `UPDATE cut_job SET split_by_material = $2, version = version + 1, updated_at = now() WHERE cut_job_id = $1`,
        [command.cutJobId, command.splitByMaterial],
      );
      // Grouping changes: existing manual layouts keyed by old group_key are no longer valid.
      await this.invalidateManualLayoutsForJob(tx, command.cutJobId, 'split_by_material_changed');

      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.splitByMaterialChanged,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        before: { splitByMaterial: before },
        after: { splitByMaterial: command.splitByMaterial },
        metadata: { beforeSplitByMaterial: before, afterSplitByMaterial: command.splitByMaterial },
      });

      await tx.query(
        `
        INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
        VALUES ($1, $2, $3, $4::jsonb, $5)
        ON CONFLICT (idempotency_key) DO NOTHING
        `,
        [
          CUT_AUDIT_EVENTS.splitByMaterialChanged,
          'cut_job',
          String(command.cutJobId),
          JSON.stringify({
            cutJobId: command.cutJobId,
            beforeSplitByMaterial: before,
            afterSplitByMaterial: command.splitByMaterial,
            actorUserId: command.currentUser.id,
            requestId: command.requestId ?? null,
          }),
          splitByMaterialChangedOutboxKey(command.cutJobId, command.requestId, command.version),
        ],
      );
    });
    return this.getJob({ currentUser: command.currentUser, cutJobId: command.cutJobId });
  }

  async setRotationAllowed(command: SetCutJobRotationAllowedCommand): Promise<CutJobDto> {
    await this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const jobRes = await tx.query<{ status: string; version: string | number; rotation_allowed: boolean | null }>(
        `SELECT status, version, rotation_allowed FROM cut_job WHERE cut_job_id = $1 FOR UPDATE`,
        [command.cutJobId],
      );
      const row = jobRes.rows[0];
      if (!row) throw new CutJobNotFoundError(command.cutJobId);
      assertVersion({ cutJobId: command.cutJobId, version: toNum(row.version) }, command.version);
      if (!PROFILE_EDITABLE_STATUSES.has(row.status)) {
        throw new CutJobNotMutableError(command.cutJobId, row.status);
      }
      const before = row.rotation_allowed !== false;

      if (before === command.rotationAllowed) {
        return;
      }

      await tx.query(
        `UPDATE cut_job SET rotation_allowed = $2, version = version + 1, updated_at = now() WHERE cut_job_id = $1`,
        [command.cutJobId, command.rotationAllowed],
      );

      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.rotationAllowedChanged,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        before: { rotationAllowed: before },
        after: { rotationAllowed: command.rotationAllowed },
        metadata: { beforeRotationAllowed: before, afterRotationAllowed: command.rotationAllowed },
      });

      await tx.query(
        `
        INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
        VALUES ($1, $2, $3, $4::jsonb, $5)
        ON CONFLICT (idempotency_key) DO NOTHING
        `,
        [
          CUT_AUDIT_EVENTS.rotationAllowedChanged,
          'cut_job',
          String(command.cutJobId),
          JSON.stringify({
            cutJobId: command.cutJobId,
            beforeRotationAllowed: before,
            afterRotationAllowed: command.rotationAllowed,
            actorUserId: command.currentUser.id,
            requestId: command.requestId ?? null,
          }),
          rotationAllowedChangedOutboxKey(command.cutJobId, command.requestId, command.version),
        ],
      );
    });
    return this.getJob({ currentUser: command.currentUser, cutJobId: command.cutJobId });
  }

  async setTextureDirection(command: SetCutJobTextureDirectionCommand): Promise<CutJobDto> {
    await this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const jobRes = await tx.query<{ status: string; version: string | number; texture_direction: string | null }>(
        `SELECT status, version, texture_direction FROM cut_job WHERE cut_job_id = $1 FOR UPDATE`,
        [command.cutJobId],
      );
      const row = jobRes.rows[0];
      if (!row) throw new CutJobNotFoundError(command.cutJobId);
      assertVersion({ cutJobId: command.cutJobId, version: toNum(row.version) }, command.version);
      if (!PROFILE_EDITABLE_STATUSES.has(row.status)) {
        throw new CutJobNotMutableError(command.cutJobId, row.status);
      }
      const before = normalizeCutTextureDirection(row.texture_direction);
      const after = command.textureDirection;

      if (before === after) {
        return;
      }

      await tx.query(
        `UPDATE cut_job
            SET texture_direction = $2,
                version = version + 1,
                pdf_prewarm_state = 'pending',
                pdf_prewarm_failure_reason = NULL,
                updated_at = now()
          WHERE cut_job_id = $1`,
        [command.cutJobId, after],
      );

      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.textureDirectionChanged,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        before: { textureDirection: before },
        after: { textureDirection: after },
        metadata: { beforeTextureDirection: before, afterTextureDirection: after },
      });

      await tx.query(
        `
        INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
        VALUES ($1, $2, $3, $4::jsonb, $5)
        ON CONFLICT (idempotency_key) DO NOTHING
        `,
        [
          CUT_AUDIT_EVENTS.textureDirectionChanged,
          'cut_job',
          String(command.cutJobId),
          JSON.stringify({
            cutJobId: command.cutJobId,
            beforeTextureDirection: before,
            afterTextureDirection: after,
            actorUserId: command.currentUser.id,
            requestId: command.requestId ?? null,
          }),
          textureDirectionChangedOutboxKey(command.cutJobId, command.requestId, command.version),
        ],
      );
    });
    return this.getJob({ currentUser: command.currentUser, cutJobId: command.cutJobId });
  }

  async setJobPdfTemplate(command: SetCutJobPdfTemplateCommand): Promise<CutJobDto> {
    await this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const job = await tx.query(
        `SELECT cut_job_id FROM cut_job WHERE cut_job_id = $1 FOR UPDATE`,
        [command.cutJobId],
      );
      if (job.rows.length === 0) throw new CutJobNotFoundError(command.cutJobId);
      await this.assertPdfTemplateActive(command.pdfTemplate, tx);
      const updated = await tx.query(
        `UPDATE cut_job
            SET pdf_template_code = $2, updated_at = now()
          WHERE cut_job_id = $1
          RETURNING cut_job_id`,
        [command.cutJobId, command.pdfTemplate],
      );
      if (updated.rows.length === 0) throw new CutJobNotFoundError(command.cutJobId);
    });
    return this.getJob({ currentUser: command.currentUser, cutJobId: command.cutJobId });
  }

  async setName(command: SetCutJobNameCommand): Promise<CutJobDto> {
    await this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const jobRes = await tx.query<{ status: string; version: string | number; name: string }>(
        `SELECT status, version, name FROM cut_job WHERE cut_job_id = $1 FOR UPDATE`,
        [command.cutJobId],
      );
      const row = jobRes.rows[0];
      if (!row) throw new CutJobNotFoundError(command.cutJobId);
      assertVersion({ cutJobId: command.cutJobId, version: toNum(row.version) }, command.version);
      if (!PROFILE_EDITABLE_STATUSES.has(row.status)) {
        throw new CutJobNotMutableError(command.cutJobId, row.status);
      }
      const nextName = command.name.trim();
      const beforeName = row.name;

      if (beforeName === nextName) {
        return;
      }

      await tx.query(
        `UPDATE cut_job SET name = $2, version = version + 1, updated_at = now() WHERE cut_job_id = $1`,
        [command.cutJobId, nextName],
      );

      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.nameChanged,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        before: { name: beforeName },
        after: { name: nextName },
        metadata: { beforeName, afterName: nextName },
      });

      await tx.query(
        `
        INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
        VALUES ($1, $2, $3, $4::jsonb, $5)
        ON CONFLICT (idempotency_key) DO NOTHING
        `,
        [
          CUT_AUDIT_EVENTS.nameChanged,
          'cut_job',
          String(command.cutJobId),
          JSON.stringify({
            cutJobId: command.cutJobId,
            beforeName,
            afterName: nextName,
            actorUserId: command.currentUser.id,
            requestId: command.requestId ?? null,
          }),
          nameChangedOutboxKey(command.cutJobId, command.requestId, command.version),
        ],
      );
    });
    return this.getJob({ currentUser: command.currentUser, cutJobId: command.cutJobId });
  }

  async setGroupPdfTemplate(command: SetCutGroupPdfTemplateCommand): Promise<CutJobDto> {
    await this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const job = await tx.query(
        `SELECT cut_job_id FROM cut_job WHERE cut_job_id = $1 FOR UPDATE`,
        [command.cutJobId],
      );
      if (job.rows.length === 0) throw new CutJobNotFoundError(command.cutJobId);
      await this.assertPdfTemplateActive(command.pdfTemplate, tx);
      const updated = await tx.query(
        `UPDATE cut_group
            SET pdf_template_code = $3, updated_at = now()
          WHERE cut_group_id = $2 AND cut_job_id = $1
          RETURNING cut_group_id`,
        [command.cutJobId, command.cutGroupId, command.pdfTemplate],
      );
      if (updated.rows.length === 0) {
        throw new ApiError(404, 'CUT_GROUP_NOT_FOUND', `cut_group ${command.cutGroupId} не принадлежит заданию ${command.cutJobId}`);
      }
    });
    return this.getJob({ currentUser: command.currentUser, cutJobId: command.cutJobId });
  }

  /**
   * Task 5: Persist a manual sheet-placement override for one cut_group.
   *
   * One transaction:
   *   validate → reconstruct → canonicalize → no-op compare →
   *   upsert layout → version bump → audit + bridge rows + outbox →
   *   prewarm-pending
   *
   * Returns the fully enriched getJob output (with manualLayout populated)
   * read AFTER the transaction commits.
   */
  async saveManualLayout(command: SaveManualLayoutCommand): Promise<CutJobDto> {
    const commandPayloadHash = hashCutResultCommand({
      type: 'manual_save',
      jobVersion: command.jobVersion,
      cutGroupId: command.cutGroupId,
      active: command.active,
      placements: command.placements,
      sheetTransforms: command.sheetTransforms ?? [],
    });
    const outcome = await this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);

      // ── 1. Load cut_job FOR UPDATE; version guard + recalc-basis guard ──────
      const jobRes = await tx.query<{
        status: string;
        version: string | number;
        last_calc_basis: string | null;
        last_calc_params: FreecutParams | null;
        current_cut_result_id: string | number | null;
      }>(
        `SELECT status, version, last_calc_basis, last_calc_params, current_cut_result_id
         FROM cut_job WHERE cut_job_id = $1 FOR UPDATE`,
        [command.cutJobId],
      );
      const jobRow = jobRes.rows[0];
      if (!jobRow) throw new CutJobNotFoundError(command.cutJobId);

      const priorCommand = await tx.query<{
        command_type: string;
        payload_hash: string;
        status: 'in_progress' | 'completed' | 'failed';
        cut_result_id: string | number | null;
        failure_code: string | null;
      }>(
        `SELECT command_type, payload_hash, status, cut_result_id, failure_code
         FROM cut_result_command
         WHERE cut_job_id = $1 AND command_id = $2::uuid
         FOR UPDATE`,
        [command.cutJobId, command.commandId],
      );
      const prior = priorCommand.rows[0];
      if (prior) {
        if (prior.command_type !== 'manual_save' || prior.payload_hash !== commandPayloadHash) {
          throw new ApiError(409, 'CUT_RESULT_COMMAND_CONFLICT', 'commandId уже использован с другим запросом');
        }
        if (prior.status === 'completed' && prior.cut_result_id !== null) {
          return { kind: 'deduped' as const };
        }
        throw new ApiError(
          409,
          prior.status === 'failed' ? (prior.failure_code ?? 'CUT_RESULT_COMMAND_FAILED') : 'CUT_RESULT_COMMAND_IN_PROGRESS',
          prior.status === 'failed' ? 'Сохранение уже завершилось ошибкой' : 'Сохранение уже выполняется',
        );
      }

      await tx.query(
        `INSERT INTO cut_result_command
           (cut_job_id, command_id, command_type, payload_hash, status, created_by)
         VALUES ($1, $2::uuid, 'manual_save', $3, 'in_progress', $4)`,
        [command.cutJobId, command.commandId, commandPayloadHash, numOrNull(command.currentUser.id)],
      );

      const currentVersion = toNum(jobRow.version);
      if (command.jobVersion !== currentVersion) {
        throw new CutStaleVersionError(command.cutJobId, command.jobVersion, currentVersion);
      }

      // Recalc-basis guard: reject when current inputs diverge from last_calc_basis.
      // Uses the same basisOf helper as getJob.requiresRecalc; a null basis (never
      // calculated) always triggers the guard.
      const lastCalcBasis = jobRow.last_calc_basis ?? null;
      // loadCurrentCalcBasisInputs uses this.database (pool) — acceptable here; the
      // cut_job row is locked so no concurrent mutation of its defining fields.
      const basisInputs = await this.loadCurrentCalcBasisInputs(command.cutJobId);
      if (basisInputs === null || lastCalcBasis === null || basisOf(basisInputs) !== lastCalcBasis) {
        throw new ApiError(409, 'CUT_RECALC_REQUIRED', 'Требуется пересчёт перед сохранением ручной раскладки');
      }

      // kerf/spacing come exclusively from the frozen last_calc_params snapshot.
      const lastCalcParams = jobRow.last_calc_params;
      if (!lastCalcParams) {
        throw new ApiError(409, 'CUT_RECALC_REQUIRED', 'Нет параметров расчёта. Требуется пересчёт');
      }
      const gap: GapParams = { kerfMm: lastCalcParams.kerf_mm, spacingMm: lastCalcParams.spacing_mm };

      // ── 2. Load cut_group → verify it belongs to this job; get group_key ────
      const groupRes = await tx.query<{ cut_group_id: string | number; group_key: string | null }>(
        `SELECT cut_group_id, group_key FROM cut_group WHERE cut_group_id = $1 AND cut_job_id = $2`,
        [command.cutGroupId, command.cutJobId],
      );
      if (!groupRes.rows[0]) {
        throw new ApiError(404, 'CUT_GROUP_NOT_FOUND', `cut_group ${command.cutGroupId} не принадлежит заданию ${command.cutJobId}`);
      }
      const groupKey = groupRes.rows[0].group_key;
      if (!groupKey) {
        throw new ApiError(409, 'CUT_RECALC_REQUIRED', 'Группа не имеет ключа (group_key). Требуется пересчёт');
      }

      // ── 3. Load authoritative auto layout from cut_group_sheet ───────────────
      const sheetsRes = await tx.query<{ sheet_index: string | number; placements: SheetPlacementsJson }>(
        `SELECT sheet_index, placements FROM cut_group_sheet WHERE cut_group_id = $1 ORDER BY sheet_index`,
        [command.cutGroupId],
      );
      if (!sheetsRes.rows.length) {
        throw new ApiError(409, 'CUT_RECALC_REQUIRED', 'Нет листов для группы. Требуется пересчёт');
      }

      // Build autoSheets + autoPieces; assert single trim authority across all sheets.
      let sharedTrim: GeomSheet['trim_mm'] | null = null;
      const autoSheets: AutoSheetSpec[] = [];
      const autoPieceMap = new Map<string, AutoPieceSpec>();
      const filmTextureByItemId = new Map<string, boolean>();
      let sharedContract: SheetPlacementsJson['coordinate_contract'] | undefined;
      let sharedDimensions: string | undefined;

      for (const sheetRow of sheetsRes.rows) {
        const pl = sheetRow.placements;
        const sheetIndex = toNum(sheetRow.sheet_index);
        const dimensions = `${pl.sheet_width_mm}x${pl.sheet_height_mm}`;
        if (sharedDimensions === undefined) sharedDimensions = dimensions;
        else if (sharedDimensions !== dimensions) {
          throw new ApiError(500, 'CUT_LAYOUT_INCONSISTENT', 'Несовместимые размеры листов в группе');
        }
        if (autoSheets.length === 0) sharedContract = pl.coordinate_contract;
        else if (sharedContract !== pl.coordinate_contract) {
          throw new ApiError(500, 'CUT_LAYOUT_INCONSISTENT', 'Несовместимые системы координат листов в группе');
        }

        if (sharedTrim === null) {
          sharedTrim = pl.trim_mm;
        } else if (
          pl.trim_mm.left !== sharedTrim.left ||
          pl.trim_mm.right !== sharedTrim.right ||
          pl.trim_mm.top !== sharedTrim.top ||
          pl.trim_mm.bottom !== sharedTrim.bottom
        ) {
          throw new ApiError(500, 'CUT_LAYOUT_INCONSISTENT', 'Несовместимые поля (trim) листов в группе');
        }

        autoSheets.push({
          sheetIndex,
          sheet_width_mm: pl.sheet_width_mm,
          sheet_height_mm: pl.sheet_height_mm,
          trim_mm: pl.trim_mm,
          ...(pl.coordinate_contract ? { coordinate_contract: pl.coordinate_contract } : {}),
        });

        for (const piece of pl.pieces) {
          if (piece.rotation_forbidden !== undefined) {
            filmTextureByItemId.set(piece.item_id, piece.rotation_forbidden);
          }
          const key = `${piece.item_id}#${piece.instance}`;
          if (!autoPieceMap.has(key)) {
            // Base dims are the UNROTATED intrinsic size.
            const baseW = piece.rotated ? piece.height_mm : piece.width_mm;
            const baseH = piece.rotated ? piece.width_mm : piece.height_mm;
            autoPieceMap.set(key, {
              itemId: piece.item_id,
              instance: piece.instance,
              baseW,
              baseH,
              label: piece.label ?? {
                orderId: null,
                detailNumber: null,
                widthMm: piece.width_mm,
                heightMm: piece.height_mm,
              },
              rotationForbidden: piece.rotation_forbidden,
              vacuumOrientationWarning: piece.vacuum_orientation_warning,
            });
          }
        }
      }

      const trim = sharedTrim!;
      const autoPieces = [...autoPieceMap.values()];

      // ── 4. Load film textures for items in this group ─────────────────────
      const itemsRes = await tx.query<{ order_detail_id: string | number; film_texture: boolean | null }>(
        `SELECT cji.order_detail_id, f.film_texture
         FROM cut_job_item cji
         JOIN order_details od ON od.detail_id = cji.order_detail_id
         LEFT JOIN films f ON f.film_id = od.film_id
         WHERE cji.cut_group_id = $1 AND cji.is_active = true`,
        [command.cutGroupId],
      );

      for (const r of itemsRes.rows) {
        const itemId = freecutItemId(toNum(r.order_detail_id));
        if (!filmTextureByItemId.has(itemId) && r.film_texture !== null) {
          filmTextureByItemId.set(itemId, r.film_texture);
        }
      }

      // Distinct order ids for the group (for audit bridge rows).
      const orderRes = await tx.query<{ order_id: string | number }>(
        `SELECT DISTINCT order_id FROM cut_job_item WHERE cut_group_id = $1 AND is_active = true`,
        [command.cutGroupId],
      );
      const groupOrderIds = orderRes.rows.map((r) => toNum(r.order_id));

      // ── 5. Completeness guard (manualSetMatchesAuto) ──────────────────────
      const matchResult = manualSetMatchesAuto({ moves: command.placements, autoPieces });
      if (!matchResult.ok) {
        throw new ApiError(422, 'CUT_MANUAL_LAYOUT_INVALID', matchResult.reason ?? 'Набор деталей не совпадает с расчётным');
      }

      // ── 6. Reconstruct authoritative sheet placements ─────────────────────
      const reconstructResult = reconstructManualSheets({ moves: command.placements, autoPieces, autoSheets, trim });
      if (reconstructResult.error) {
        throw new ApiError(422, 'CUT_MANUAL_LAYOUT_INVALID', reconstructResult.error.message);
      }
      const reconstructedSheets = reconstructResult.sheets;

      // ── 7. Geometry/grain validation ──────────────────────────────────────
      const allViolations: ManualViolation[] = [];
      for (const { sheetIndex, placements: sheetPlacements } of reconstructedSheets) {
        const violations = validateSheetPlacements({ sheetIndex, placements: sheetPlacements, gap, filmTextureByItemId });
        allViolations.push(...violations);
      }
      if (allViolations.length > 0) {
        throw new ApiError(422, 'CUT_MANUAL_LAYOUT_INVALID', 'Нарушения в расположении деталей на листе', { violations: allViolations });
      }

      // ── 8. Canonicalize: preserve auto sheet_index values; empty sheets dropped ─
      //   reconstructManualSheets keeps the REAL sheet_index of every surviving
      //   sheet (no renumber) but omits sheets left empty after a cross-sheet move.
      const transformBySheet = new Map((command.sheetTransforms ?? []).map((transform) => [transform.sheetIndex, transform]));
      const canonicalSheets: import('../dto/cut.dto').CutManualSheetDto[] = reconstructedSheets.map(({ sheetIndex, placements: p }) => {
        const transform = transformBySheet.get(sheetIndex);
        return {
          sheetIndex,
          placements: p,
          ...(transform ? {
            viewTransform: {
              rotationDeg: transform.rotationDeg,
              mirrorHorizontal: transform.mirrorHorizontal,
              mirrorVertical: transform.mirrorVertical,
            },
          } : {}),
        };
      });

      // ── 9. No-op short-circuit ────────────────────────────────────────────
      // Short-circuit ONLY when the FULL target persisted state already matches:
      // canonical sheets AND is_active AND is_stale=false AND
      // based_on_job_version === jobVersion (the incoming version).
      // A STALE row re-saved with unchanged geometry must NOT short-circuit.
      const existingRes = await tx.query<{
        sheets: import('../dto/cut.dto').CutManualSheetDto[];
        is_active: boolean;
        is_stale: boolean;
        based_on_job_version: string | number;
      }>(
        `SELECT sheets, is_active, is_stale, based_on_job_version
         FROM cut_group_manual_layout
         WHERE cut_job_id = $1 AND group_key = $2
         LIMIT 1`,
        [command.cutJobId, groupKey],
      );

      const existing = existingRes.rows[0];
      if (
        existing &&
        !existing.is_stale &&
        existing.is_active === command.active &&
        Number(existing.based_on_job_version) === command.jobVersion &&
        // Compare empty-filtered on both sides: canonicalSheets already omits empty
        // sheets, and a legacy row saved before that rule may still carry them.
        // Without this filter a genuine no-op re-save of such a row would differ
        // only by empty sheets and force a needless version bump/audit/outbox.
        sheetsMatchCanonical(existing.sheets.filter((s) => s.placements.pieces.length > 0), canonicalSheets)
      ) {
        // Identical re-save: no version bump, no audit, no outbox.
        if (jobRow.current_cut_result_id === null) {
          throw new ApiError(409, 'CUT_RESULT_REQUIRED', 'Текущий выполненный раскрой не найден');
        }
        await tx.query(
          `UPDATE cut_result_command
           SET status = 'completed', cut_result_id = $3, completed_at = now()
           WHERE cut_job_id = $1 AND command_id = $2::uuid`,
          [command.cutJobId, command.commandId, toNum(jobRow.current_cut_result_id)],
        );
        return { kind: 'saved' as const };
      }

      // ── 10. Persist: version bump + prewarm reset + upsert + audit + outbox ─
      const nextVersion = currentVersion + 1;

      // Bump version and reset pdf_prewarm_state (new version → no warmed PDF yet).
      await tx.query(
        `UPDATE cut_job SET version = $2, pdf_prewarm_state = 'pending', updated_at = now() WHERE cut_job_id = $1`,
        [command.cutJobId, nextVersion],
      );

      // Upsert manual layout within the TX (not via this.upsertManualLayout which
      // uses this.database; we need the write inside this transaction boundary).
      await tx.query(
        `INSERT INTO cut_group_manual_layout
           (cut_job_id, group_key, sheets, is_active, is_stale, based_on_job_version, version, created_by)
         VALUES ($1, $2, $3::jsonb, $4, FALSE, $5, 1, $6)
         ON CONFLICT (cut_job_id, group_key) DO UPDATE
           SET sheets               = EXCLUDED.sheets,
               is_active            = EXCLUDED.is_active,
               is_stale             = FALSE,
               based_on_job_version = EXCLUDED.based_on_job_version,
               version              = cut_group_manual_layout.version + 1,
               updated_at           = now()`,
        [command.cutJobId, groupKey, JSON.stringify(canonicalSheets), command.active, nextVersion, numOrNull(command.currentUser.id)],
      );

      const cutResult = await this.createCutResult(tx, {
        cutJobId: command.cutJobId,
        resultKind: 'manual',
        commandId: command.commandId,
        commandPayloadHash,
        actor: command.currentUser,
        reuseCurrentManualVersion: true,
      });

      // Audit: before/after metadata + cut_group + order bridge rows.
      const beforeSheets = existing ? (existing.sheets as import('../dto/cut.dto').CutManualSheetDto[]) : [];
      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.manualLayoutSaved,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        related: {
          cutGroupIds: [command.cutGroupId],
          orderIds: groupOrderIds,
          cutResultIds: [cutResult.cutResultId],
        },
        before: {
          cutGroupId: command.cutGroupId,
          active: existing?.is_active ?? null,
          perSheetCounts: beforeSheets.map((s) => s.placements.pieces.length),
        },
        after: {
          cutGroupId: command.cutGroupId,
          active: command.active,
          perSheetCounts: canonicalSheets.map((s) => s.placements.pieces.length),
        },
        metadata: {
          cutGroupId: command.cutGroupId,
          active: command.active,
          perSheetCounts: {
            before: beforeSheets.map((s) => s.placements.pieces.length),
            after: canonicalSheets.map((s) => s.placements.pieces.length),
          },
          movedCount: command.placements.length,
          rotatedCount: command.placements.filter((m) => m.rotated).length,
          cutResultId: cutResult.cutResultId,
          resultNo: cutResult.resultNo,
          cutNumber: cutResult.cutNumber,
          resultKind: cutResult.resultKind,
          basedOnResultId: cutResult.basedOnResultId,
        },
      });

      // Outbox event: idempotency key is (cutJobId, nextVersion) — the immutable
      // mutation identity. requestId rides in payload for relay dedupe only.
      await tx.query(
        `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          CUT_AUDIT_EVENTS.manualLayoutSaved,
          'cut_job',
          String(command.cutJobId),
          JSON.stringify({
            cutJobId: command.cutJobId,
            cutGroupId: command.cutGroupId,
            actorUserId: command.currentUser.id,
            requestId: command.requestId ?? null,
            occurredAtJobVersion: nextVersion,
            active: command.active,
            cutResultId: cutResult.cutResultId,
            resultNo: cutResult.resultNo,
            cutNumber: cutResult.cutNumber,
          }),
          manualLayoutSavedOutboxKey(command.cutJobId, nextVersion),
        ],
      );
      return { kind: 'saved' as const };
    });

    // Return the fully enriched job (with manualLayout, editorParams, requiresRecalc)
    // read after the transaction commits. Uses this.getJob which queries this.database.
    if (outcome.kind === 'deduped') {
      return this.getJob({
        currentUser: command.currentUser,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
      });
    }
    return this.getJob({ currentUser: command.currentUser, cutJobId: command.cutJobId });
  }
}

interface EligibleRow extends QueryResultRow {
  detail_id: string | number;
  order_id: string | number;
  order_name?: string | null;
  client_name?: string | null;
  detail_number?: string | number | null;
  detail_name?: string | null;
  height?: string | number | null;
  width?: string | number | null;
  quantity: string | number;
  area?: string | number | null;
  material_id: string | number | null;
  sheet_material_type_id: string | number | null;
  material_name?: string | null;
  milling_type_name?: string | null;
  edge_type_name?: string | null;
  film_id: string | number | null;
  film_name?: string | null;
  production_status_id: string | number | null;
  production_status_name?: string | null;
  priority?: string | number | null;
  joint_order_id?: string | number | null;
  note?: string | null;
  link_cutting_file?: string | null;
  link_cutting_image_file?: string | null;
  link_cad_file?: string | null;
  link_pdf_file?: string | null;
  delete_flag: boolean;
  /** NULL when sheet_material_type_id is NULL (LEFT JOIN produces no row). */
  is_cuttable: boolean | null;
}

interface CuttableGroup {
  sheetMaterialTypeId: number | null;
  filmId: number | null;
  filmTexture: boolean | null;
  smtWidthMm: number | null;
  smtHeightMm: number | null;
  orderIds: number[];
  items: Array<{ orderDetailId: number; orderId: number; qty: number; widthMm: number; heightMm: number; detailNumber: number | null; filmTexture: boolean | null }>;
}

/** Per-job sheet override (migration 040). When a job has a chosen sheet, every
 *  item is cut on it: rewrite sheet id + stock dims on each row, leaving film_id
 *  per-detail so grain fan-out is preserved. no_sheet_spec rows inherit the
 *  chosen sheet and become cuttable. */
export function applySheetOverride(
  rows: CalcItemRow[],
  override: { sheetMaterialTypeId: number; widthMm: number; heightMm: number },
  options: { onlyNoSheetSpec?: boolean } = {},
): CalcItemRow[] {
  return rows.map((row) => {
    // onlyNoSheetSpec (split_by_material=true): leave materialed details on their
    // own sheet so different materials split; the override only fills details that
    // have no sheet (no_sheet_spec), giving them a cuttable sheet.
    if (options.onlyNoSheetSpec && row.sheet_material_type_id !== null) {
      return row;
    }
    return {
      ...row,
      sheet_material_type_id: override.sheetMaterialTypeId,
      smt_width_mm: override.widthMm,
      smt_height_mm: override.heightMm,
    };
  });
}

/** Fan-out the resolved items into one group per cuttable key.
 *  - splitByMaterial=true (default): one group per material. Default key =
 *    (sheet_material_type_id, film_id) so mixed films cut on their own sheets;
 *    when combineFilms is true the key drops film_id so films of the SAME material
 *    nest on shared sheets (merged group filmId null). Different materials NEVER
 *    merge.
 *  - splitByMaterial=false: materials may share the selected sheet; combineFilms
 *    still controls film grouping. ON uses one all-details group with filmId
 *    null; OFF groups by film across all materials.
 *  Each item always keeps its own filmTexture so freecut applies grain per detail. */
export function groupByCuttableKey(rows: CalcItemRow[], combineFilms = false, splitByMaterial = true): Map<string, CuttableGroup> {
  const groups = new Map<string, CuttableGroup>();
  for (const row of rows) {
    const sheetMaterialTypeId = row.sheet_material_type_id === null ? null : toNum(row.sheet_material_type_id);
    const rowFilmId = row.film_id === null ? null : toNum(row.film_id);
    // The group's film is null only when different films are intentionally mixed.
    // If material splitting is off but film combining is off, keep one group per film.
    const filmId = combineFilms ? null : rowFilmId;
    const key = !splitByMaterial
      ? combineFilms
        ? 'all'
        : `all|f:${rowFilmId ?? 'null'}`
      : combineFilms
        ? `${sheetMaterialTypeId ?? 'null'}:all`
        : `${sheetMaterialTypeId ?? 'null'}:${rowFilmId ?? 'null'}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        sheetMaterialTypeId,
        filmId,
        filmTexture: row.film_texture,
        smtWidthMm: row.smt_width_mm === null ? null : toNum(row.smt_width_mm),
        smtHeightMm: row.smt_height_mm === null ? null : toNum(row.smt_height_mm),
        orderIds: [],
        items: [],
      };
      groups.set(key, group);
    } else if (!splitByMaterial && group.sheetMaterialTypeId === null && sheetMaterialTypeId !== null) {
      // A non-material-split group cuts details together: if its sheet is still
      // unknown (the first row was no_sheet_spec), adopt the first materialed row's
      // sheet/dims instead of failing the whole group with CUT_NO_SHEET_SPEC.
      group.sheetMaterialTypeId = sheetMaterialTypeId;
      group.smtWidthMm = row.smt_width_mm === null ? null : toNum(row.smt_width_mm);
      group.smtHeightMm = row.smt_height_mm === null ? null : toNum(row.smt_height_mm);
    }
    const orderId = toNum(row.order_id);
    group.orderIds.push(orderId);
    group.items.push({
      orderDetailId: toNum(row.order_detail_id),
      orderId,
      qty: toNum(row.qty),
      widthMm: toNum(row.width_mm),
      heightMm: toNum(row.height_mm),
      detailNumber: numOrNull(row.detail_number),
      filmTexture: row.film_texture,
    });
  }
  return groups;
}

async function loadCalcItems(client: DatabaseClient, cutJobId: number): Promise<CalcItemRow[]> {
  const result = await client.query<CalcItemRow>(
    `
    SELECT cji.cut_job_item_id, cji.order_detail_id, cji.order_id, cji.qty,
           od.width AS width_mm, od.height AS height_mm, od.detail_number, od.material_id,
           od.sheet_material_type_id, od.film_id, f.film_texture,
           smt.width_mm AS smt_width_mm, smt.height_mm AS smt_height_mm
    FROM cut_job_item cji
    JOIN order_details od ON od.detail_id = cji.order_detail_id
    LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = od.sheet_material_type_id
    LEFT JOIN films f ON f.film_id = od.film_id
    WHERE cji.cut_job_id = $1 AND cji.is_active = true
    ORDER BY cji.cut_job_item_id
    `,
    [cutJobId],
  );
  return result.rows;
}

async function loadJobForUpdate(tx: TransactionClient, cutJobId: number): Promise<{
  cutJobId: number;
  name: string;
  status: string;
  source: string;
  version: number;
  params: Record<string, unknown> | null;
  paramProfileId: number | null;
  sheetMaterialTypeId: number | null;
  combineFilms: boolean;
  splitByMaterial: boolean;
  rotationAllowed: boolean;
}> {
  const result = await tx.query<CutJobLockRow>(
    `SELECT cut_job_id, name, status, source, version, pdf_prewarm_state, params, param_profile_id, sheet_material_type_id, combine_films, split_by_material, rotation_allowed, texture_direction FROM cut_job WHERE cut_job_id = $1 FOR UPDATE`,
    [cutJobId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new CutJobNotFoundError(cutJobId);
  }
  return {
    cutJobId: toNum(row.cut_job_id),
    name: row.name,
    status: row.status,
    source: row.source,
    version: toNum(row.version),
    params: row.params,
    paramProfileId: row.param_profile_id === null || row.param_profile_id === undefined ? null : toNum(row.param_profile_id),
    sheetMaterialTypeId: row.sheet_material_type_id === null || row.sheet_material_type_id === undefined ? null : toNum(row.sheet_material_type_id),
    combineFilms: row.combine_films === true,
    splitByMaterial: row.split_by_material !== false,
    rotationAllowed: row.rotation_allowed !== false,
  };
}

async function bumpVersion(tx: TransactionClient, cutJobId: number): Promise<void> {
  await tx.query(
    `UPDATE cut_job SET version = version + 1, updated_at = now() WHERE cut_job_id = $1`,
    [cutJobId],
  );
}

function assertVersion(job: { cutJobId: number; version: number }, expected: number): void {
  if (job.version !== expected) {
    throw new CutStaleVersionError(job.cutJobId, expected, job.version);
  }
}

function assertMutable(job: { cutJobId: number; status: string }): void {
  if (!MUTABLE_STATUSES.has(job.status)) {
    throw new CutJobNotMutableError(job.cutJobId, job.status);
  }
}

interface JobRow extends QueryResultRow {
  cut_job_id: string | number;
  name: string;
  status: string;
  source: string;
  source_display_number: string | number | null;
  version: string | number;
  created_at: Date | string;
  pdf_prewarm_state: string;
  failure_code: string | null;
  failure_reason: string | null;
  param_profile_id: string | number | null;
  sheet_material_type_id: string | number | null;
  pdf_template_code: string | null;
  combine_films: boolean | null;
  split_by_material: boolean | null;
  rotation_allowed: boolean | null;
  texture_direction: string | null;
  last_calc_params: FreecutParams | null;
  profile_params: unknown;
}

function cutParamsUseVacuumTable(params: unknown): boolean {
  return typeof params === 'object'
    && params !== null
    && !Array.isArray(params)
    && (params as { layout_mode?: unknown }).layout_mode === 'vacuum_table';
}

function buildPdfSheetMeta(
  placements: SheetPlacementsJson,
  detailById: ReadonlyMap<number, RenderDetailInfo>,
): PdfSheetMeta {
  const meta: {
    orders: string[];
    clients: string[];
    dates: string[];
    readyDates: string[];
    materials: string[];
    thicknesses: string[];
    films: string[];
    edgeTypes: string[];
    machineFiles: string[];
  } = {
    orders: [],
    clients: [],
    dates: [],
    readyDates: [],
    materials: [],
    thicknesses: [],
    films: [],
    edgeTypes: [],
    machineFiles: [],
  };
  const add = (list: string[], value: string | number | null | undefined) => {
    if (value === null || value === undefined) return;
    const text = String(value).trim();
    if (text && !list.includes(text)) list.push(text);
  };
  for (const piece of placements.pieces) {
    const detailId = parseFreecutItemId(piece.item_id);
    const detail = detailId === null ? null : detailById.get(detailId) ?? null;
    if (!detail) continue;
    add(meta.orders, detail.orderName ?? detail.orderId);
    add(meta.clients, detail.clientName);
    add(meta.dates, detail.orderDate);
    add(meta.readyDates, detail.readyDate);
    add(meta.materials, detail.materialName);
    add(meta.thicknesses, detail.thicknessMm);
    add(meta.films, detail.filmName);
    add(meta.edgeTypes, detail.edgeTypeName);
    for (const file of detail.machineFiles) add(meta.machineFiles, file);
  }
  return meta;
}

function buildPdfDetailRows(
  placements: SheetPlacementsJson,
  detailById: ReadonlyMap<number, RenderDetailInfo>,
): PdfSheetDetailRow[] {
  const byKey = new Map<string, PdfSheetDetailRow>();
  for (const piece of placements.pieces) {
    const detailId = parseFreecutItemId(piece.item_id);
    const detail = detailId === null ? null : detailById.get(detailId) ?? null;
    const order = String(detail?.orderName ?? detail?.orderId ?? '-');
    const position = detail?.detailNumber ?? detailId ?? piece.item_id;
    const width = detail?.widthMm ?? piece.width_mm;
    const height = detail?.heightMm ?? piece.height_mm;
    const lengthMm = Math.max(width, height);
    const widthMm = Math.min(width, height);
    const machineFiles = detail?.machineFiles ?? [];
    const machineFile = machineFiles.join(', ');
    const row: PdfSheetDetailRow = {
      order,
      position,
      lengthMm,
      widthMm,
      quantity: 1,
      machineFiles,
      fields: buildPdfDetailRowFields(detail, detailId, {
        order,
        position,
        lengthMm,
        widthMm,
        quantity: 1,
        machineFile,
        material: detail?.materialName ?? null,
        film: detail?.filmName ?? null,
        client: detail?.clientName ?? null,
        orderDate: detail?.orderDate ?? null,
        readyDate: detail?.readyDate ?? null,
        thickness: detail?.thicknessMm ?? null,
      }),
      material: detail?.materialName ?? null,
      film: detail?.filmName ?? null,
      client: detail?.clientName ?? null,
      orderDate: detail?.orderDate ?? null,
      readyDate: detail?.readyDate ?? null,
      due: detail?.readyDate ?? null,
      thickness: detail?.thicknessMm ?? null,
    };
    const key = [
      row.order,
      row.position,
      row.lengthMm,
      row.widthMm,
      row.material ?? '',
      row.film ?? '',
      row.client ?? '',
      row.orderDate ?? '',
      row.readyDate ?? '',
      row.thickness ?? '',
    ].join(':');
    const existing = byKey.get(key);
    if (existing) {
      existing.quantity += 1;
      const mergedMachineFiles = mergeMachineFiles(existing.machineFiles, row.machineFiles);
      existing.machineFiles = mergedMachineFiles;
      existing.fields = {
        ...(existing.fields ?? {}),
        quantity: existing.quantity,
        sheet_quantity: existing.quantity,
        machine_file: mergedMachineFiles.join(', '),
        machine_files: mergedMachineFiles.join(', '),
      };
    } else {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()].sort((a, b) => Number(a.position) - Number(b.position));
}

function buildPdfDetailRowFields(
  detail: RenderDetailInfo | null,
  detailId: number | null,
  row: {
    order: string;
    position: number | string;
    lengthMm: number | null;
    widthMm: number | null;
    quantity: number;
    machineFile: string;
    material: string | null;
    film: string | null;
    client: string | null;
    orderDate: string | null;
    readyDate: string | null;
    thickness: number | null;
  },
): Record<string, LabelCustomExpressionScalar> {
  const fields: Record<string, LabelCustomExpressionScalar> = {};
  for (const [key, value] of Object.entries(detail?.detailFields ?? {})) {
    fields[key] = pdfDetailScalar(value);
  }
  return {
    ...fields,
    detail_id: detailId,
    order_id: detail?.orderId ?? null,
    detail_number: detail?.detailNumber ?? null,
    doweling: detail?.doweling ?? false,
    height: detail?.heightMm ?? null,
    width: detail?.widthMm ?? null,
    quantity: row.quantity,
    sheet_quantity: row.quantity,
    machine_file: row.machineFile,
    machine_files: row.machineFile,
    material_name: row.material,
    materials: row.material,
    film_name: row.film,
    films: row.film,
    milling_type_name: detail?.millingTypeName ?? null,
    edge_type_name: detail?.edgeTypeName ?? null,
    production_status_name: detail?.productionStatusName ?? null,
    order: row.order,
    position: row.position,
    lengthMm: row.lengthMm,
    widthMm: row.widthMm,
    material: row.material,
    film: row.film,
    client: row.client,
    orderDate: row.orderDate,
    readyDate: row.readyDate,
    thickness: row.thickness,
    thicknesses: row.thickness,
  };
}

function normalizeMachineFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const text = String(item ?? '').trim();
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}

function mergeMachineFiles(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): string[] {
  const result: string[] = [];
  for (const value of [...(left ?? []), ...(right ?? [])]) {
    const text = String(value ?? '').trim();
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}

function pdfDetailScalar(value: unknown): LabelCustomExpressionScalar {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

interface ItemRow extends QueryResultRow {
  cut_job_item_id: string | number;
  order_detail_id: string | number;
  order_id: string | number;
  qty: string | number;
  cut_group_id: string | number | null;
  // Enriched order-detail fields (present only when includeItemDetails); null when
  // the source order_detail no longer exists. Price/sum are intentionally omitted.
  // joined_detail_id is the existence sentinel: NULL iff the LEFT JOIN found no
  // live (non-deleted) detail. Never key existence off user data (detail_number).
  joined_detail_id?: string | number | null;
  detail_fields?: Record<string, unknown> | null;
  detail_number?: string | number | null;
  detail_name?: string | null;
  height?: string | number | null;
  width?: string | number | null;
  detail_quantity?: string | number | null;
  area?: string | number | null;
  material_id?: string | number | null;
  sheet_material_type_id?: string | number | null;
  material_name?: string | null;
  doweling?: boolean | null;
  milling_type_id?: string | number | null;
  milling_type_name?: string | null;
  edge_type_id?: string | number | null;
  edge_type_name?: string | null;
  film_id?: string | number | null;
  film_name?: string | null;
  priority?: string | number | null;
  production_status_id?: string | number | null;
  production_status_name?: string | null;
  joint_order_id?: string | number | null;
  note?: string | null;
  link_cutting_file?: string | null;
  link_cutting_image_file?: string | null;
  link_cad_file?: string | null;
  link_pdf_file?: string | null;
  /** Present on enriched and light read paths. */
  order_name?: string | null;
  /** Present on enriched and light read paths. */
  order_delete_flag?: boolean | null;
}

// Enriched item query: joins order_details + dictionaries to resolve the order
// form's detail fields (names, not bare ids) for the /cut "Детали задания" table.
// LEFT JOINs so a reserved-then-hard-deleted detail still returns its item row
// (detail fields null). Price columns (milling_cost_per_sqm, detail_cost) are
// deliberately not selected — the cut surface is production-facing, not financial.
const ENRICHED_ITEMS_QUERY = `
  SELECT i.cut_job_item_id, i.order_detail_id, i.order_id, i.qty, i.cut_group_id,
         od.detail_id AS joined_detail_id,
         to_jsonb(od) AS detail_fields,
         od.detail_number, od.detail_name, od.height, od.width,
         od.quantity AS detail_quantity, od.area,
         od.material_id, od.sheet_material_type_id,
         COALESCE(smt.name, m.material_name) AS material_name,
         od.doweling,
         od.milling_type_id, mt.milling_type_name,
         od.edge_type_id, et.edge_type_name,
         od.film_id, f.film_name,
         od.priority, od.production_status_id, ps.production_status_name,
         od.joint_order_id, od.note,
         od.link_cutting_file, od.link_cutting_image_file, od.link_cad_file, od.link_pdf_file,
         o.order_name AS order_name,
         o.delete_flag AS order_delete_flag
  FROM cut_job_item i
  -- delete_flag in the JOIN (not WHERE): a reserved detail that was later soft-
  -- deleted must still return its item row, but with detail: null (canonical
  -- read-side semantics exclude deleted details — see order_details_view).
  LEFT JOIN order_details od ON od.detail_id = i.order_detail_id AND od.delete_flag = false
  LEFT JOIN materials m ON m.material_id = od.material_id
  LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = od.sheet_material_type_id
  LEFT JOIN milling_types mt ON mt.milling_type_id = od.milling_type_id
  LEFT JOIN edge_types et ON et.edge_type_id = od.edge_type_id
  LEFT JOIN films f ON f.film_id = od.film_id
  LEFT JOIN production_statuses ps ON ps.production_status_id = od.production_status_id
  LEFT JOIN orders o ON o.order_id = i.order_id
  WHERE i.cut_job_id = $1 AND i.is_active = true
  ORDER BY i.cut_job_item_id
`;

const ENRICHED_FROZEN_ITEMS_QUERY = ENRICHED_ITEMS_QUERY.replace(
  ' AND i.is_active = true',
  ` AND (
      i.is_active = true
      OR EXISTS (
        SELECT 1 FROM cut_group frozen_group
        WHERE frozen_group.cut_group_id = i.cut_group_id
          AND frozen_group.cut_job_id = i.cut_job_id
      )
    )`,
);

const LIGHT_ITEMS_QUERY = `
  SELECT i.cut_job_item_id, i.order_detail_id, i.order_id, i.qty, i.cut_group_id,
         o.order_name AS order_name,
         o.delete_flag AS order_delete_flag
  FROM cut_job_item i
  LEFT JOIN orders o ON o.order_id = i.order_id
  WHERE i.cut_job_id = $1 AND i.is_active = true
  ORDER BY i.cut_job_item_id`;
const LIGHT_FROZEN_ITEMS_QUERY = `
  SELECT i.cut_job_item_id, i.order_detail_id, i.order_id, i.qty, i.cut_group_id,
         o.order_name AS order_name,
         o.delete_flag AS order_delete_flag
  FROM cut_job_item i
  LEFT JOIN orders o ON o.order_id = i.order_id
  WHERE i.cut_job_id = $1
    AND (
      i.is_active = true
      OR EXISTS (
        SELECT 1 FROM cut_group frozen_group
        WHERE frozen_group.cut_group_id = i.cut_group_id
          AND frozen_group.cut_job_id = i.cut_job_id
      )
    )
  ORDER BY i.cut_job_item_id`;

function mapItemDetail(row: ItemRow): CutDetailInfoDto | null {
  // Existence keyed off the joined PK, not user data: NULL means the LEFT JOIN
  // matched no live detail (hard-deleted or soft-deleted via delete_flag).
  if (row.joined_detail_id === undefined || row.joined_detail_id === null) {
    return null;
  }
  return {
    detailFields: row.detail_fields ?? null,
    detailNumber: numOrNull(row.detail_number),
    detailName: row.detail_name ?? null,
    height: numOrNull(row.height),
    width: numOrNull(row.width),
    quantity: numOrNull(row.detail_quantity),
    area: numOrNull(row.area),
    materialId: numOrNull(row.material_id),
    sheetMaterialTypeId: numOrNull(row.sheet_material_type_id),
    materialName: row.material_name ?? null,
    doweling: row.doweling === null || row.doweling === undefined ? null : row.doweling === true,
    millingTypeId: numOrNull(row.milling_type_id),
    millingTypeName: row.milling_type_name ?? null,
    edgeTypeId: numOrNull(row.edge_type_id),
    edgeTypeName: row.edge_type_name ?? null,
    filmId: numOrNull(row.film_id),
    filmName: row.film_name ?? null,
    priority: numOrNull(row.priority),
    productionStatusId: numOrNull(row.production_status_id),
    productionStatusName: row.production_status_name ?? null,
    jointOrderId: numOrNull(row.joint_order_id),
    note: row.note ?? null,
    linkCuttingFile: row.link_cutting_file ?? null,
    linkCuttingImageFile: row.link_cutting_image_file ?? null,
    linkCadFile: row.link_cad_file ?? null,
    linkPdfFile: row.link_pdf_file ?? null,
  };
}

interface GroupRow extends QueryResultRow {
  cut_group_id: string | number;
  sheet_material_type_id: string | number | null;
  film_id: string | number | null;
  status: string;
  pdf_template_code: string | null;
  summary: Record<string, unknown> | null;
  group_key: string | null;
  sheet_material_name: string | null;
  sheet_material_width_mm: string | number | null;
  sheet_material_height_mm: string | number | null;
  group_film_name: string | null;
}

interface SheetRow extends QueryResultRow {
  cut_group_sheet_id: string | number;
  cut_group_id: string | number;
  sheet_index: number;
  png_cache_key: string | null;
  placements: SheetPlacementsJson;
}

interface FilmUsageDetailInfo {
  filmId: number | null;
  filmName: string | null;
}

type ManualLayoutReadModel = {
  groupKey: string;
  sheets: CutManualSheetDto[];
  isActive: boolean;
  isStale: boolean;
  version: number;
};

function emptyCutTotals(): CutJobTotals {
  return { positions: 0, details: 0, area: 0, sheets: 0, materialsCount: 0, filmsCount: 0, filmUsage: [] };
}

function normalizeCutJobTotals(totals: CutJobTotals): CutJobTotals {
  return {
    ...totals,
    filmUsage: Array.isArray(totals.filmUsage) ? totals.filmUsage : [],
  };
}

async function loadFilmUsageDetailInfo(
  client: DatabaseClient,
  orderDetailIds: number[],
): Promise<Map<number, FilmUsageDetailInfo>> {
  const out = new Map<number, FilmUsageDetailInfo>();
  const ids = [...new Set(orderDetailIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return out;
  const rows = await client.query<{
    detail_id: string | number;
    film_id: string | number | null;
    film_name: string | null;
  }>(
    `SELECT od.detail_id,
            od.film_id,
            f.film_name
       FROM order_details od
       LEFT JOIN films f ON f.film_id = od.film_id
       WHERE od.detail_id = ANY($1::bigint[])`,
    [ids],
  );
  for (const row of rows.rows) {
    out.set(toNum(row.detail_id), {
      filmId: row.film_id === null ? null : toNum(row.film_id),
      filmName: row.film_name ?? null,
    });
  }
  return out;
}

async function loadManualLayouts(
  client: DatabaseClient,
  cutJobId: number,
): Promise<ManualLayoutReadModel[]> {
  const result = await client.query<{
    group_key: string;
    sheets: unknown;
    is_active: boolean;
    is_stale: boolean;
    version: string | number;
  }>(
    `SELECT group_key, sheets, is_active, is_stale, version
       FROM cut_group_manual_layout
       WHERE cut_job_id = $1`,
    [cutJobId],
  );
  return result.rows.map((row) => ({
    groupKey: row.group_key,
    sheets: row.sheets as CutManualSheetDto[],
    isActive: row.is_active,
    isStale: row.is_stale,
    version: Number(row.version),
  }));
}

function computeBathFilmUsageTotals(input: {
  layoutMode?: unknown;
  groups: CutGroupDto[];
  groupRowsById: ReadonlyMap<number, GroupRow>;
  manualLayoutsByKey: ReadonlyMap<string, ManualLayoutReadModel>;
  detailInfoById: ReadonlyMap<number, FilmUsageDetailInfo>;
}): CutFilmUsageDto[] {
  const totals = new Map<string, CutFilmUsageDto>();
  for (const group of input.groups) {
    const meta = input.groupRowsById.get(group.cutGroupId);
    if (!meta) continue;
    const showBathMeterGuides = shouldShowBathMeterGuides({
      engineUsed: group.summary?.engine_used,
      layoutMode: input.layoutMode,
      materialName: meta.sheet_material_name,
      materialWidthMm: meta.sheet_material_width_mm,
      materialHeightMm: meta.sheet_material_height_mm,
    });
    if (!showBathMeterGuides) continue;

    const groupKey = meta.group_key ?? null;
    const manual = groupKey ? (input.manualLayoutsByKey.get(groupKey) ?? null) : null;
    const sourceSheets = manual && manual.isActive && !manual.isStale
      ? manual.sheets.map((sheet) => ({ sheetIndex: sheet.sheetIndex, placements: sheet.placements }))
      : group.sheets.map((sheet) => ({ sheetIndex: sheet.sheetIndex, placements: sheet.placements }));

    for (const sheet of sourceSheets) {
      const usage = calculateBathSheetFilmUsage(sheet.placements);
      if (!usage) continue;
      const filmRefs = filmRefsForSheet(sheet.placements.pieces, input.detailInfoById, {
        filmId: group.filmId,
        filmName: meta.group_film_name,
      });
      for (const filmRef of filmRefs) {
        const key = filmRef.filmId !== null ? `id:${filmRef.filmId}` : `name:${filmRef.filmName ?? ''}`;
        const current = totals.get(key);
        if (current) {
          current.linearMeters = roundTo2(current.linearMeters + usage.linearMeters);
          current.sheets += 1;
        } else {
          totals.set(key, {
            filmId: filmRef.filmId,
            filmName: filmRef.filmName,
            linearMeters: usage.linearMeters,
            sheets: 1,
          });
        }
      }
    }
  }
  return [...totals.values()]
    .map((row) => ({ ...row, linearMeters: roundTo2(row.linearMeters) }))
    .sort((a, b) => (a.filmName ?? '').localeCompare(b.filmName ?? '', 'ru') || (a.filmId ?? 0) - (b.filmId ?? 0));
}

function filmRefsForSheet(
  pieces: ReadonlyArray<{ item_id: string }>,
  detailInfoById: ReadonlyMap<number, FilmUsageDetailInfo>,
  groupFilm: { filmId: number | null; filmName: string | null },
): Array<{ filmId: number | null; filmName: string | null }> {
  const out: Array<{ filmId: number | null; filmName: string | null }> = [];
  const seen = new Set<string>();
  const add = (filmId: number | null, filmName: string | null) => {
    const cleanName = filmName?.trim() || null;
    if (filmId === null && cleanName === null) return;
    const key = filmId !== null ? `id:${filmId}` : `name:${cleanName}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ filmId, filmName: cleanName });
  };
  for (const piece of pieces) {
    const detailId = parseFreecutItemId(piece.item_id);
    const info = detailId === null ? null : detailInfoById.get(detailId) ?? null;
    add(info?.filmId ?? null, info?.filmName ?? null);
  }
  if (out.length === 0) add(groupFilm.filmId, groupFilm.filmName);
  return out;
}

async function computeTotals(
  client: DatabaseClient,
  cutJobIds: number[],
  frozenItems = false,
): Promise<Map<number, CutJobTotals>> {
  const out = new Map<number, CutJobTotals>();
  for (const id of cutJobIds) out.set(id, emptyCutTotals());
  if (cutJobIds.length === 0) return out;
  // SEQUENTIAL, not Promise.all: loadJob/computeTotals run inside command
  // transactions on a single pg client/connection. Two concurrent queries on one
  // connection corrupt the wire protocol — await them one at a time.
  const agg = await client.query<TotalsRow & { cut_job_id: string | number }>(
    frozenItems ? TOTALS_FROZEN_ITEMS_BY_JOB_SQL : TOTALS_BY_JOB_SQL,
    [cutJobIds],
  );
  const sheets = await client.query<{ cut_job_id: string | number; sheets: string | number }>(SHEETS_BY_JOB_SQL, [cutJobIds]);
  for (const row of agg.rows) {
    const id = toNum(row.cut_job_id);
    out.set(id, mapTotalsRow({ ...row, sheets: out.get(id)?.sheets ?? 0 }));
  }
  for (const row of sheets.rows) {
    const id = toNum(row.cut_job_id);
    const cur = out.get(id) ?? emptyCutTotals();
    out.set(id, { ...cur, sheets: toNum(row.sheets) });
  }
  return out;
}

async function computeMaterialNames(client: DatabaseClient, cutJobIds: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  for (const id of cutJobIds) out.set(id, []);
  if (cutJobIds.length === 0) return out;
  const rows = await client.query<{ cut_job_id: string | number; material_names: string[] | null }>(MATERIAL_NAMES_BY_JOB_SQL, [cutJobIds]);
  for (const row of rows.rows) {
    const names = Array.isArray(row.material_names)
      ? row.material_names.filter((name): name is string => typeof name === 'string' && name.trim() !== '')
      : [];
    out.set(toNum(row.cut_job_id), names);
  }
  return out;
}

function normalizeCutTextureDirection(value: string | null | undefined): CutTextureDirection {
  return value === 'vertical' || value === 'horizontal' ? value : 'none';
}

function cutTextureDirectionLabel(value: string | null | undefined): string {
  switch (normalizeCutTextureDirection(value)) {
    case 'vertical':
      return 'вдоль полотна';
    case 'horizontal':
      return 'поперёк полотна';
    default:
      return 'отсутствует';
  }
}

async function loadJob(
  client: DatabaseClient,
  cutJobId: number,
  includeItemDetails = true,
  totals?: CutJobTotals,
  materialNames?: string[],
  frozenItems = false,
): Promise<CutJobDto> {
  const jobResult = await client.query<JobRow>(
    `SELECT j.cut_job_id, j.name, j.status, j.source, j.version, j.pdf_prewarm_state, j.failure_code, j.failure_reason,
            j.source_display_number,
            j.param_profile_id, j.sheet_material_type_id, j.pdf_template_code, j.combine_films, j.split_by_material,
            j.rotation_allowed, j.texture_direction, j.created_at, j.last_calc_params,
            cpp.params AS profile_params
       FROM cut_job j
       LEFT JOIN cut_param_profiles cpp ON cpp.cut_param_profile_id = j.param_profile_id
       WHERE j.cut_job_id = $1`,
    [cutJobId],
  );
  const jobRow = jobResult.rows[0];
  if (!jobRow) {
    throw new CutJobNotFoundError(cutJobId);
  }
  const baseTotals = normalizeCutJobTotals(totals ?? (await computeTotals(client, [cutJobId], frozenItems)).get(cutJobId)!);

  // The list view only needs item counts, so it opts out of the dictionary joins
  // (it loads up to 200 jobs); single-job reads enrich each item with full detail.
  const itemsResult = await client.query<ItemRow>(
    includeItemDetails
      ? (frozenItems ? ENRICHED_FROZEN_ITEMS_QUERY : ENRICHED_ITEMS_QUERY)
      : (frozenItems ? LIGHT_FROZEN_ITEMS_QUERY : LIGHT_ITEMS_QUERY),
    [cutJobId],
  );
  const groupsResult = await client.query<GroupRow>(
    `SELECT cg.cut_group_id,
            cg.sheet_material_type_id,
            cg.film_id,
            cg.status,
            cg.pdf_template_code,
            cg.summary,
            cg.group_key,
            smt.name AS sheet_material_name,
            smt.width_mm AS sheet_material_width_mm,
            smt.height_mm AS sheet_material_height_mm,
            f.film_name AS group_film_name
       FROM cut_group cg
       LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = cg.sheet_material_type_id
       LEFT JOIN films f ON f.film_id = cg.film_id
       WHERE cg.cut_job_id = $1
       ORDER BY cg.cut_group_id`,
    [cutJobId],
  );
  const groupIds = groupsResult.rows.map((row) => toNum(row.cut_group_id));
  const sheetsResult = groupIds.length
    ? await client.query<SheetRow>(
        `SELECT cut_group_sheet_id, cut_group_id, sheet_index, png_cache_key, placements FROM cut_group_sheet WHERE cut_group_id = ANY($1::bigint[]) ORDER BY cut_group_id, sheet_index`,
        [groupIds],
      )
    : { rows: [] as SheetRow[] };
  const itemDtos = itemsResult.rows.map((row) => ({
    cutJobItemId: toNum(row.cut_job_item_id),
    orderDetailId: toNum(row.order_detail_id),
    orderId: toNum(row.order_id),
    qty: toNum(row.qty),
    cutGroupId: row.cut_group_id === null ? null : toNum(row.cut_group_id),
    detail: includeItemDetails ? mapItemDetail(row) : null,
    // orderName/orderDeleted are present on both list and enriched paths so
    // list/card order references can show names and stale deleted markers.
    ...(row.order_name !== undefined || row.order_delete_flag !== undefined
      ? { orderName: row.order_name ?? null, orderDeleted: row.order_delete_flag === true }
      : {}),
  }));
  const resolvedMaterialNames = materialNames ?? uniqueSorted(
    itemDtos.map((item) => item.detail?.materialName ?? null),
  );
  const detailInfoById = await loadFilmUsageDetailInfo(
    client,
    itemDtos.map((item) => item.orderDetailId),
  );

  const groups: CutGroupDto[] = groupsResult.rows.map((row) => {
    const cutGroupId = toNum(row.cut_group_id);
    return {
      cutGroupId,
      sheetMaterialTypeId: row.sheet_material_type_id === null ? null : toNum(row.sheet_material_type_id),
      sheetMaterialName: row.sheet_material_name ?? null,
      sheetMaterialWidthMm: row.sheet_material_width_mm === null ? null : toNum(row.sheet_material_width_mm),
      sheetMaterialHeightMm: row.sheet_material_height_mm === null ? null : toNum(row.sheet_material_height_mm),
      filmId: row.film_id === null ? null : toNum(row.film_id),
      status: row.status,
      pdfTemplate: row.pdf_template_code ?? 'standard',
      summary: row.summary,
      sheets: sheetsResult.rows
        .filter((sheet) => toNum(sheet.cut_group_id) === cutGroupId)
        .map((sheet) => ({
          cutGroupSheetId: toNum(sheet.cut_group_sheet_id),
          sheetIndex: sheet.sheet_index,
          pngCacheKey: sheet.png_cache_key,
          placements: sheet.placements,
        })),
    };
  });
  const groupRowsById = new Map(groupsResult.rows.map((row) => [toNum(row.cut_group_id), row]));
  const manualLayouts = groups.length > 0 ? await loadManualLayouts(client, cutJobId) : [];
  const resolvedTotals: CutJobTotals = {
    ...baseTotals,
    filmUsage: computeBathFilmUsageTotals({
      layoutMode: jobRow.last_calc_params?.layout_mode,
      groups,
      groupRowsById,
      manualLayoutsByKey: new Map(manualLayouts.map((layout) => [layout.groupKey, layout])),
      detailInfoById,
    }),
  };

  const jobId = toNum(jobRow.cut_job_id);
  const isVacuum = cutParamsUseVacuumTable(jobRow.profile_params) || cutParamsUseVacuumTable(jobRow.last_calc_params);

  return {
    cutJobId: jobId,
    displayNumber: formatCutJobNumber(jobId, isVacuum, jobRow.source_display_number),
    isVacuum,
    name: jobRow.name,
    status: jobRow.status,
    source: jobRow.source,
    createdAt: jobRow.created_at instanceof Date ? jobRow.created_at.toISOString() : String(jobRow.created_at),
    version: toNum(jobRow.version),
    pdfPrewarmState: jobRow.pdf_prewarm_state,
    failureCode: jobRow.failure_code,
    failureReason: jobRow.failure_reason,
    paramProfileId: jobRow.param_profile_id === null || jobRow.param_profile_id === undefined ? null : toNum(jobRow.param_profile_id),
    sheetMaterialTypeId: jobRow.sheet_material_type_id === null || jobRow.sheet_material_type_id === undefined ? null : toNum(jobRow.sheet_material_type_id),
    pdfTemplate: jobRow.pdf_template_code ?? 'standard',
    combineFilms: jobRow.combine_films === true,
    splitByMaterial: jobRow.split_by_material !== false,
    rotationAllowed: jobRow.rotation_allowed !== false,
    textureDirection: normalizeCutTextureDirection(jobRow.texture_direction),
    materialNames: resolvedMaterialNames,
    totals: resolvedTotals,
    items: itemDtos,
    groups,
  };
}

async function loadFrozenJobSnapshot(client: DatabaseClient, cutJobId: number): Promise<CutJobDto> {
  const base = await loadJob(client, cutJobId, true, undefined, undefined, true);
  const calc = await client.query<{ last_calc_params: FreecutParams | null }>(
    `SELECT last_calc_params FROM cut_job WHERE cut_job_id = $1`,
    [cutJobId],
  );
  const groupKeys = await client.query<{ cut_group_id: string | number; group_key: string | null }>(
    `SELECT cut_group_id, group_key FROM cut_group WHERE cut_job_id = $1`,
    [cutJobId],
  );
  const manual = await client.query<{
    group_key: string;
    sheets: CutManualSheetDto[];
    is_active: boolean;
    is_stale: boolean;
    version: string | number;
  }>(
    `SELECT group_key, sheets, is_active, is_stale, version
     FROM cut_group_manual_layout WHERE cut_job_id = $1`,
    [cutJobId],
  );
  const keyByGroup = new Map(groupKeys.rows.map((row) => [toNum(row.cut_group_id), row.group_key]));
  const manualByKey = new Map(manual.rows.map((row) => [row.group_key, row]));
  const params = calc.rows[0]?.last_calc_params ?? null;
  const editorParams = params ? { kerfMm: params.kerf_mm, spacingMm: params.spacing_mm } : null;
  const groups = base.groups.map((group) => {
    const groupKey = keyByGroup.get(group.cutGroupId) ?? null;
    const manualRow = groupKey ? manualByKey.get(groupKey) : undefined;
    const manualLayout: CutManualLayoutDto | null = groupKey && manualRow
      ? {
          groupKey,
          sheets: manualRow.sheets,
          isActive: manualRow.is_active,
          isStale: manualRow.is_stale,
          version: toNum(manualRow.version),
        }
      : null;
    const effective = manualLayout !== null && manualLayout.isActive && !manualLayout.isStale;
    return {
      ...group,
      groupKey,
      manualLayout,
      renderToken: `snapshot:g${group.cutGroupId}:m${manualLayout?.version ?? 0}:a${effective ? 1 : 0}`,
    };
  });
  return {
    ...base,
    items: base.items.map((item) => ({
      ...item,
      detail: item.detail ? { ...item.detail, detailFields: null } : null,
    })),
    groups,
    editorParams,
    requiresRecalc: false,
    autoLayoutValidation: { valid: true },
    renderToken: `snapshot:j${base.version}`,
  };
}

function validateFrozenJobSnapshot(snapshot: CutJobDto): void {
  if (snapshot.groups.length === 0 || snapshot.items.length === 0) {
    throw new ApiError(500, 'CUT_RESULT_SNAPSHOT_INCOMPLETE', 'Версия раскроя не содержит групп или деталей');
  }
  const expected = new Map(snapshot.items.map((item) => [
    freecutItemId(item.orderDetailId),
    { qty: item.qty, cutGroupId: item.cutGroupId },
  ]));
  const actual = new Map<string, Set<number>>();
  const snapshotGroupIds = new Set(snapshot.groups.map((group) => group.cutGroupId));
  if ([...expected.values()].some((item) => item.cutGroupId === null || !snapshotGroupIds.has(item.cutGroupId))) {
    throw new ApiError(500, 'CUT_RESULT_SNAPSHOT_INCOMPLETE', 'Деталь ссылается на отсутствующую группу');
  }
  for (const group of snapshot.groups) {
    if (group.sheets.length === 0) {
      throw new ApiError(500, 'CUT_RESULT_SNAPSHOT_INCOMPLETE', `Группа ${group.cutGroupId} не содержит автоматических листов`);
    }
    if (![...expected.values()].some((item) => item.cutGroupId === group.cutGroupId)) {
      throw new ApiError(500, 'CUT_RESULT_SNAPSHOT_INCOMPLETE', `Группа ${group.cutGroupId} не содержит деталей`);
    }
    const autoVariantInstances = new Set<string>();
    for (const sheet of group.sheets) {
      if (
        sheet.renderSnapshot?.contractVersion !== 'cut_sheet_render_v1'
        || Object.keys(sheet.renderSnapshot.views).length !== FROZEN_RENDER_VIEW_COUNT
      ) {
        throw new ApiError(500, 'CUT_RESULT_SNAPSHOT_INCOMPLETE', `Лист ${sheet.sheetIndex} не содержит frozen render`);
      }
      for (const piece of sheet.placements.pieces) {
        if (!expected.has(piece.item_id) || expected.get(piece.item_id)?.cutGroupId !== group.cutGroupId) {
          throw new ApiError(500, 'CUT_RESULT_SNAPSHOT_INCOMPLETE', `Неизвестная деталь ${piece.item_id}`);
        }
        const instances = actual.get(piece.item_id) ?? new Set<number>();
        if (instances.has(piece.instance)) {
          throw new ApiError(500, 'CUT_RESULT_SNAPSHOT_INCOMPLETE', `Дубликат ${piece.item_id}#${piece.instance}`);
        }
        autoVariantInstances.add(`${piece.item_id}#${piece.instance}`);
        instances.add(piece.instance);
        actual.set(piece.item_id, instances);
      }
    }
    const manual = group.manualLayout;
    if (manual?.isActive && manual.isStale) {
      throw new ApiError(500, 'CUT_RESULT_SNAPSHOT_INCOMPLETE', 'Устаревший ручной вариант не может быть активным');
    }
    if (manual && manual.sheets.length === 0) {
      throw new ApiError(500, 'CUT_RESULT_SNAPSHOT_INCOMPLETE', 'Ручной вариант не содержит листов');
    }
    if (manual) {
      const manualVariantInstances = new Set<string>();
      for (const sheet of manual.sheets) {
        if (
          sheet.renderSnapshot?.contractVersion !== 'cut_sheet_render_v1'
          || Object.keys(sheet.renderSnapshot.views).length !== FROZEN_RENDER_VIEW_COUNT
        ) {
          throw new ApiError(500, 'CUT_RESULT_SNAPSHOT_INCOMPLETE', 'Ручной вариант не содержит frozen render');
        }
        for (const piece of sheet.placements.pieces) {
          const key = `${piece.item_id}#${piece.instance}`;
          if (!expected.has(piece.item_id) || manualVariantInstances.has(key)) {
            throw new ApiError(500, 'CUT_RESULT_SNAPSHOT_INCOMPLETE', `Некорректная ручная деталь ${key}`);
          }
          manualVariantInstances.add(key);
        }
      }
      if (
        manualVariantInstances.size !== autoVariantInstances.size
        || [...autoVariantInstances].some((key) => !manualVariantInstances.has(key))
      ) {
        throw new ApiError(500, 'CUT_RESULT_SNAPSHOT_INCOMPLETE', 'Ручной вариант содержит другой набор деталей');
      }
    }
  }
  for (const item of snapshot.unplaced ?? []) {
    if (!expected.has(item.itemId)) {
      throw new ApiError(500, 'CUT_RESULT_SNAPSHOT_INCOMPLETE', `Неизвестная неразмещённая деталь ${item.itemId}`);
    }
    const instances = actual.get(item.itemId) ?? new Set<number>();
    if (instances.has(item.instance)) {
      throw new ApiError(500, 'CUT_RESULT_SNAPSHOT_INCOMPLETE', `Дубликат ${item.itemId}#${item.instance}`);
    }
    instances.add(item.instance);
    actual.set(item.itemId, instances);
  }
  for (const [itemId, item] of expected) {
    if ((actual.get(itemId)?.size ?? 0) !== item.qty) {
      throw new ApiError(500, 'CUT_RESULT_SNAPSHOT_INCOMPLETE', `Количество экземпляров ${itemId} не совпадает`);
    }
  }
}

function synthesizeLegacyUnplaced(snapshot: CutJobDto): CutJobDto {
  const placed = new Map<string, Set<number>>();
  for (const group of snapshot.groups) {
    for (const sheet of group.sheets) {
      for (const piece of sheet.placements.pieces) {
        const instances = placed.get(piece.item_id) ?? new Set<number>();
        instances.add(piece.instance);
        placed.set(piece.item_id, instances);
      }
    }
  }
  const unplaced = snapshot.items.flatMap((item) => {
    const itemId = freecutItemId(item.orderDetailId);
    const present = placed.get(itemId) ?? new Set<number>();
    return Array.from({ length: item.qty }, (_, index) => index + 1)
      .filter((instance) => !present.has(instance))
      .map((instance) => ({ itemId, instance, reason: 'legacy_unplaced' }));
  });
  return { ...snapshot, unplaced };
}

function buildCutResultManifest(snapshot: CutJobDto): Record<string, unknown> {
  return {
    groups: snapshot.groups.length,
    items: snapshot.items.length,
    instances: snapshot.items.reduce((sum, item) => sum + item.qty, 0),
    unplaced: snapshot.unplaced?.length ?? 0,
    variants: snapshot.groups.map((group) => ({
      groupKey: group.groupKey ?? `group:${group.cutGroupId}`,
      autoSheets: group.sheets.map((sheet) => sheet.sheetIndex),
      manualSheets: group.manualLayout?.sheets.map((sheet) => sheet.sheetIndex) ?? [],
      renderContract: 'cut_sheet_render_v1',
      autoRenderViews: group.sheets.map((sheet) => Object.keys(sheet.renderSnapshot?.views ?? {}).length),
      manualRenderViews: group.manualLayout?.sheets.map((sheet) => Object.keys(sheet.renderSnapshot?.views ?? {}).length) ?? [],
      manualState: group.manualLayout
        ? group.manualLayout.isStale
          ? 'stale'
          : group.manualLayout.isActive
            ? 'active'
            : 'inactive'
        : 'none',
    })),
  };
}

function mapCutResultSummary(row: CutResultRow): CutResultSummaryDto {
  const cutJobId = toNum(row.cut_job_id);
  const resultNo = toNum(row.result_no);
  return {
    cutResultId: toNum(row.cut_result_id),
    cutJobId,
    resultNo,
    cutNumber: formatCutNumber(cutJobId, resultNo, cutJobSnapshotUsesVacuumTable(row.snapshot_job), row.source_display_number),
    resultKind: row.result_kind,
    sourceJobVersion: toNum(row.source_job_version),
    basedOnResultId: numOrNull(row.based_on_result_id),
    createdBy: numOrNull(row.created_by),
    createdByName: row.created_by_name_snapshot,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    totals: normalizeCutJobTotals(row.totals_snapshot),
    isCurrent: row.is_current === true,
    isArchived: row.archived_at != null,
    archivedAt: row.archived_at instanceof Date ? row.archived_at.toISOString() : row.archived_at == null ? null : String(row.archived_at),
    archivedBy: numOrNull(row.archived_by),
  };
}

function hashCutResultCommand(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function uniqueSorted(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))].sort((a, b) =>
    a.localeCompare(b, 'ru'),
  );
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function normalizeCutJobNumberFilter(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/^[№#]\s*/, '');
  return normalized ? normalized : null;
}

async function setSessionUser(tx: TransactionClient, userId: string | number): Promise<void> {
  await tx.query('SELECT set_session_user($1)', [String(userId)]);
}

async function hasMdfBoardHiddenColumns(client: DatabaseClient): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `
    SELECT
      to_regclass('cnc_telegram_packets') IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'cnc_telegram_packets'
          AND column_name IN (
            'mdf_board_hidden_at',
            'mdf_board_hidden_by',
            'mdf_board_hidden_reason',
            'mdf_board_hidden_cut_job_id'
          )
        GROUP BY table_name
        HAVING COUNT(DISTINCT column_name) = 4
      ) AS exists
    `,
  );
  return result.rows[0]?.exists === true;
}

async function loadCutJobDeleteImpact(client: DatabaseClient, cutJobId: number): Promise<CutJobDeleteImpactDto> {
  const released = await client.query<DeleteImpactItemRow>(
    `
    SELECT DISTINCT cji.order_id, cji.order_detail_id
    FROM cut_job_item cji
    WHERE cji.cut_job_id = $1
      AND cji.is_active = true
    ORDER BY cji.order_id, cji.order_detail_id
    `,
    [cutJobId],
  );
  const releasedRows = released.rows as DeleteImpactItemRow[];

  let linkedMdfPackets: CutJobLinkedMdfPacketDto[] = [];
  if (await hasMdfBoardHiddenColumns(client)) {
    const packets = await client.query<DeleteImpactPacketRow>(
      `
      SELECT
        p.packet_id::text AS packet_id,
        p.external_packet_key,
        p.workday,
        p.machine,
        p.program_name,
        COUNT(i.packet_item_id)::integer AS item_count
      FROM cnc_telegram_packets p
      LEFT JOIN cnc_telegram_packet_items i ON i.packet_id = p.packet_id
      WHERE p.svg_cut_job_id = $1
        AND p.mdf_board_hidden_at IS NULL
      GROUP BY p.packet_id, p.external_packet_key, p.workday, p.machine, p.program_name, p.updated_at
      ORDER BY p.workday DESC, p.updated_at DESC, p.external_packet_key
      `,
      [cutJobId],
    );
    const packetRows = packets.rows as DeleteImpactPacketRow[];
    linkedMdfPackets = packetRows.map((row) => ({
      packetId: row.packet_id,
      externalPacketKey: row.external_packet_key,
      workday: dateOnly(row.workday) ?? String(row.workday),
      machine: row.machine,
      programName: row.program_name,
      itemCount: toNum(row.item_count),
    }));
  }

  return {
    linkedMdfPackets,
    orderIds: [...new Set(releasedRows.map((row) => toNum(row.order_id)))],
    orderDetailIds: [...new Set(releasedRows.map((row) => toNum(row.order_detail_id)))],
  };
}

async function hideLinkedMdfPacketsForCutJob(
  client: DatabaseClient,
  cutJobId: number,
  userId: string | number,
): Promise<string[]> {
  if (!(await hasMdfBoardHiddenColumns(client))) {
    return [];
  }
  const result = await client.query<{ packet_id: string }>(
    `
    UPDATE cnc_telegram_packets
    SET mdf_board_hidden_at = COALESCE(mdf_board_hidden_at, now()),
        mdf_board_hidden_by = $2,
        mdf_board_hidden_reason = 'cut_job_deleted',
        mdf_board_hidden_cut_job_id = $1,
        updated_at = now()
    WHERE svg_cut_job_id = $1
      AND mdf_board_hidden_at IS NULL
    RETURNING packet_id::text AS packet_id
    `,
    [cutJobId, numOrNull(userId) ?? null],
  );
  const rows = result.rows as Array<{ packet_id: string }>;
  return rows.map((row) => row.packet_id);
}

function cleanIds(values: Array<number | null> | undefined): number[] {
  if (!values) return [];
  return values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function toNum(value: string | number): number {
  return Number(value);
}

function numOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function dateTimeIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function dateOnly(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim();
  return text ? text.slice(0, 10) : null;
}
