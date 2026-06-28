import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { CutService } from '../application/cut.service';
import type {
  CutDetailLastReadyResponseDto,
  CutDetailPlacementsResponseDto,
  CutJobDto,
  CutSelectionCriteriaDto,
  EligibleDetailsResponseDto,
} from '../dto/cut.dto';
import type { CutSheetTypeOption, ManualMove } from '../application/cut-command.types';
import { CutPdfCache, type PdfEnsureResult } from '../application/cut-pdf-cache';
import { CutRuntimeConfigService } from './cut-runtime-config.service';

/** Cold-cache PDF retry hint (seconds). */
const PDF_RETRY_AFTER_SECONDS = 2;

const idArray = z.array(z.number().int().positive()).max(5000);

const criteriaSchema = z
  .object({
    /** Variant B: filter by sheet_material_type_id (replaces materialIds post-034). */
    sheetMaterialTypeIds: idArray.optional(),
    orderIds: idArray.optional(),
    filmIds: idArray.optional(),
    productionStatusIds: idArray.optional(),
  })
  .strict();

const createCutJobRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    criteria: criteriaSchema.optional(),
    detailIds: idArray.optional(),
  })
  .strict();

const addItemsRequestSchema = z
  .object({
    detailIds: idArray.min(1),
    version: z.number().int().min(0),
  })
  .strict();

const versionBodySchema = z.object({ version: z.number().int().min(0) }).strict();

const setProfileBodySchema = z
  .object({
    paramProfileId: z.number().int().positive().nullable(),
    version: z.number().int().nonnegative(),
  })
  .strict();

const setSheetMaterialBodySchema = z
  .object({
    sheetMaterialTypeId: z.number().int().positive().nullable(),
    version: z.number().int().nonnegative(),
  })
  .strict();

const setCombineFilmsBodySchema = z
  .object({
    combineFilms: z.boolean(),
    version: z.number().int().nonnegative(),
  })
  .strict();

const setSplitByMaterialBodySchema = z
  .object({
    splitByMaterial: z.boolean(),
    version: z.number().int().nonnegative(),
  })
  .strict();

const manualMoveSchema = z
  .object({
    itemId: z.string().min(1),
    instance: z.number().int().min(1),
    sheetIndex: z.number().int().min(0),
    xMm: z.number(),
    yMm: z.number(),
    rotated: z.boolean(),
  })
  .strict();

const saveManualLayoutBodySchema = z
  .object({
    jobVersion: z.number().int().nonnegative(),
    active: z.boolean(),
    placements: z.array(manualMoveSchema),
  })
  .strict();

@ApiTags('CutJobs')
@ApiBearerAuth()
@Controller('cut-jobs')
export class CutController {
  constructor(
    @Inject(CutService) private readonly cut: CutService,
    @Inject(CutRuntimeConfigService) private readonly runtimeConfig: CutRuntimeConfigService,
    @Inject(CutPdfCache) private readonly pdfCache: CutPdfCache,
  ) {}

  @ApiOperation({ operationId: 'createCutJob', summary: 'Create a cut job (criteria or explicit detail ids)' })
  @Post()
  async create(@Req() request: RequestWithCurrentUser, @Body() body: unknown): Promise<CutJobDto> {
    const currentUser = this.requireMutation(request);
    return this.cut.createJob({
      currentUser,
      dto: parseCreateCutJobRequest(body),
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'listCutJobs', summary: 'List active cut jobs' })
  @Get()
  async list(@Req() request: RequestWithCurrentUser): Promise<CutJobDto[]> {
    const currentUser = this.requireRead(request);
    return this.cut.listJobs({ currentUser, requestId: request.requestId });
  }

  @ApiOperation({
    operationId: 'cutDetailPlacements',
    summary: 'List active jobs (and an archived flag) a detail/order set is already placed in',
  })
  @Get('placements')
  async detailPlacements(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string>,
  ): Promise<CutDetailPlacementsResponseDto> {
    // Registered BEFORE ':cutJobId' so the literal path is not captured as an id.
    const currentUser = this.requireRead(request);
    return this.cut.listDetailPlacements({
      currentUser,
      detailIds: parseCsvIds(query.detailIds),
      orderIds: parseCsvIds(query.orderIds),
      requestId: request.requestId,
    });
  }

  @ApiOperation({
    operationId: 'cutDetailLastReady',
    summary: 'Per-detail latest-created ready (calculated) cut job, for the order-detail Раскрой column',
  })
  @Get('detail-last-ready')
  async detailLastReady(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string>,
  ): Promise<CutDetailLastReadyResponseDto> {
    // Registered BEFORE ':cutJobId' so the literal path is not captured as an id.
    const currentUser = this.requireRead(request);
    return this.cut.listDetailLastReady({
      currentUser,
      detailIds: parseCsvIds(query.detailIds),
      requestId: request.requestId,
    });
  }

  @ApiOperation({
    operationId: 'listCutSheetTypes',
    summary: 'List active sheet material types for the cut filter (cut.view only — no sheet_materials.view required)',
  })
  @Get('sheet-types')
  async listSheetTypes(@Req() request: RequestWithCurrentUser): Promise<CutSheetTypeOption[]> {
    // Registered BEFORE ':cutJobId' so the literal 'sheet-types' path is not captured as an id.
    // Gated on cut.view: worker can populate the cut filter without sheet_materials.view (Variant B Task 11).
    const currentUser = this.requireRead(request);
    return this.cut.listSheetTypesForCut({ currentUser, requestId: request.requestId });
  }

  @ApiOperation({ operationId: 'getCutJob', summary: 'Get a cut job manifest' })
  @Get(':cutJobId')
  async get(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
  ): Promise<CutJobDto> {
    const currentUser = this.requireRead(request);
    return this.cut.getJob({ currentUser, cutJobId: parseCutJobId(cutJobId), requestId: request.requestId });
  }

  @ApiOperation({ operationId: 'listEligibleDetails', summary: 'List criteria-driven eligible details (backend read)' })
  @Get(':cutJobId/eligible-details')
  async eligibleDetails(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Query() query: Record<string, string>,
  ): Promise<EligibleDetailsResponseDto> {
    const currentUser = this.requireRead(request);
    parseCutJobId(cutJobId);
    return this.cut.listEligibleDetails({
      currentUser,
      criteria: parseEligibleCriteria(query),
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'addCutItems', summary: 'Add eligible details to a cut job (reserve)' })
  @Post(':cutJobId/items')
  async addItems(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Body() body: unknown,
  ): Promise<CutJobDto> {
    const currentUser = this.requireMutation(request);
    const parsed = parseAddItemsRequest(body);
    return this.cut.addItems({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      version: parsed.version,
      dto: { detailIds: parsed.detailIds },
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'removeCutItem', summary: 'Remove a cut job item (release reservation)' })
  @Delete(':cutJobId/items/:itemId')
  async removeItem(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Param('itemId') itemId: string,
    @Body() body: unknown,
  ): Promise<CutJobDto> {
    const currentUser = this.requireMutation(request);
    return this.cut.removeItem({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      cutJobItemId: parseCutJobId(itemId),
      version: parseVersionBody(body),
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'calculateCutJob', summary: 'Calculate a cut job via freecut' })
  @Post(':cutJobId/calculate')
  async calculate(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Body() body: unknown,
  ): Promise<CutJobDto> {
    const currentUser = this.requireMutation(request);
    const job = await this.cut.calculate({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      version: parseVersionBody(body),
      requestId: request.requestId,
    });
    // Pre-warm the whole-job PDF (plan §7): cache-warming optimization, not
    // persistence (DB placements stay the source of truth, PDF re-derivable).
    // Fire-and-forget; the export.pdf endpoint also renders on a cold cache.
    if (job.status === 'ready') {
      this.prewarmJobPdf(currentUser, job.cutJobId, job.version, request.requestId);
    }
    return job;
  }

  @ApiOperation({ operationId: 'archiveCutJob', summary: 'Archive a cut job (release reservations)' })
  @Delete(':cutJobId')
  async archive(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Body() body: unknown,
  ): Promise<CutJobDto> {
    const currentUser = this.requireMutation(request);
    return this.cut.archive({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      version: parseVersionBody(body),
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'setCutJobProfile', summary: 'Set the cut profile for a job' })
  @Patch(':cutJobId/profile')
  async setProfile(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Body() body: unknown,
  ): Promise<CutJobDto> {
    const currentUser = this.requireMutation(request);
    const { paramProfileId, version } = parseSetProfileBody(body);
    return this.cut.setProfile({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      paramProfileId,
      version,
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'setCutJobSheetMaterial', summary: 'Set the sheet variant for a job' })
  @Patch(':cutJobId/sheet-material')
  async setSheetMaterial(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Body() body: unknown,
  ): Promise<CutJobDto> {
    const currentUser = this.requireMutation(request);
    const { sheetMaterialTypeId, version } = parseSetSheetMaterialBody(body);
    return this.cut.setSheetMaterial({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      sheetMaterialTypeId,
      version,
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'setCutJobCombineFilms', summary: 'Toggle combine-different-films for a job' })
  @Patch(':cutJobId/combine-films')
  async setCombineFilms(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Body() body: unknown,
  ): Promise<CutJobDto> {
    const currentUser = this.requireMutation(request);
    const { combineFilms, version } = parseSetCombineFilmsBody(body);
    return this.cut.setCombineFilms({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      combineFilms,
      version,
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'setCutJobSplitByMaterial', summary: 'Toggle split-by-material for a job' })
  @Patch(':cutJobId/split-by-material')
  async setSplitByMaterial(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Body() body: unknown,
  ): Promise<CutJobDto> {
    const currentUser = this.requireMutation(request);
    const { splitByMaterial, version } = parseSetSplitByMaterialBody(body);
    return this.cut.setSplitByMaterial({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      splitByMaterial,
      version,
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'saveManualLayout', summary: 'Save manual layout moves for a cut group' })
  @Patch(':cutJobId/groups/:groupId/manual-layout')
  async saveManualLayout(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Param('groupId') groupId: string,
    @Body() body: unknown,
  ): Promise<CutJobDto> {
    const currentUser = this.requireMutation(request);
    const { jobVersion, active, placements } = parseSaveManualLayoutBody(body);
    const job = await this.cut.saveManualLayout({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      cutGroupId: parseCutJobId(groupId),
      jobVersion,
      active,
      placements,
      requestId: request.requestId,
    });
    if (job.status === 'ready' && job.pdfPrewarmState === 'pending') {
      this.prewarmJobPdf(currentUser, job.cutJobId, job.version, request.requestId);
    }
    return job;
  }

  @ApiOperation({ operationId: 'renderCutSheetPng', summary: 'Render a per-sheet PNG' })
  @Get(':cutJobId/groups/:groupId/sheets/:sheetIndex.png')
  async renderPng(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Param('groupId') groupId: string,
    @Param('sheetIndex') sheetIndex: string,
    @Query() query: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    const currentUser = this.requireRead(request);
    const parsedJobId = parseCutJobId(cutJobId);
    const png = await this.cut.renderSheetPng({
      currentUser,
      cutJobId: parsedJobId,
      cutGroupId: parseCutJobId(groupId),
      sheetIndex: parseSheetIndex(sheetIndex),
      preset: parsePreset(query.preset),
      rotate90: parseOrientation(query.orientation),
      variant: parseVariant(query.variant),
      requestId: request.requestId,
    });
    response.setHeader('Content-Type', 'image/png');
    response.setHeader('Cache-Control', 'private, max-age=60');
    response.send(png);
  }

  @ApiOperation({ operationId: 'renderCutSheetSvg', summary: 'Render a per-sheet SVG' })
  @Get(':cutJobId/groups/:groupId/sheets/:sheetIndex.svg')
  async renderSvg(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Param('groupId') groupId: string,
    @Param('sheetIndex') sheetIndex: string,
    @Query() query: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    const currentUser = this.requireRead(request);
    const parsedJobId = parseCutJobId(cutJobId);
    const svg = await this.cut.renderSheetSvg({
      currentUser,
      cutJobId: parsedJobId,
      cutGroupId: parseCutJobId(groupId),
      sheetIndex: parseSheetIndex(sheetIndex),
      rotate90: parseOrientation(query.orientation),
      variant: parseVariant(query.variant),
      requestId: request.requestId,
    });
    response.setHeader('Content-Type', 'image/svg+xml');
    response.setHeader('Cache-Control', 'private, max-age=60');
    response.send(svg);
  }

  @ApiOperation({ operationId: 'exportCutGroupPdf', summary: 'Export a per-group multi-page PDF (on-demand, cached)' })
  @Get(':cutJobId/groups/:groupId/export.pdf')
  async exportGroupPdf(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Param('groupId') groupId: string,
    @Query() query: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    const currentUser = this.requireRead(request);
    const parsedJobId = parseCutJobId(cutJobId);
    const cutGroupId = parseCutJobId(groupId);
    const rotate90 = parseOrientation(query.orientation);
    const variant = parseVariant(query.variant);
    // Task 7 Rule 9: cache key includes the server-owned render token (layout state)
    // so a manual save or active-selector flip busts the in-process cache. FIX 2:
    // the requested `variant` is a SEPARATE key dimension — `auto` and `active` can
    // render different bytes for the same layout state and must not share a slot.
    const renderToken = await this.cut.getRenderCacheToken({ cutGroupId });
    const result = this.pdfCache.ensure(
      `group:${cutGroupId}:${variant}:${renderToken}:${rotate90 ? 'L' : 'P'}`,
      () => this.cut.renderGroupPdf({ currentUser, cutGroupId, cutJobId: parsedJobId, rotate90, variant, requestId: request.requestId }),
    );
    this.sendPdf(response, result, `cut-group-${cutGroupId}.pdf`);
  }

  @ApiOperation({ operationId: 'exportCutJobPdf', summary: 'Export a whole-job PDF (all groups; on-demand, cached, pre-warmed)' })
  @Get(':cutJobId/export.pdf')
  async exportJobPdf(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Query() query: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    const currentUser = this.requireRead(request);
    const id = parseCutJobId(cutJobId);
    const rotate90 = parseOrientation(query.orientation);
    const variant = parseVariant(query.variant);
    // getJob gives the current version + renderToken (cache discriminator for manual layouts).
    const job = await this.cut.getJob({ currentUser, cutJobId: id, requestId: request.requestId });
    // Task 7 Rule 10: renderToken aggregates job version + all per-group manual tokens;
    // any manual save or active-selector flip changes the token → busts the cache.
    const renderToken = job.renderToken ?? `v${job.version}`;
    const result = this.ensureJobPdf(currentUser, id, renderToken, job.version, request.requestId, rotate90, variant);
    this.sendPdf(response, result, `cut-job-${id}.pdf`);
  }

  private ensureJobPdf(
    currentUser: RequestWithCurrentUser['user'],
    cutJobId: number,
    renderToken: string,
    version: number,
    requestId: string | undefined,
    rotate90 = false,
    variant: 'auto' | 'manual' | 'active' = 'auto',
  ) {
    // Task 7: cache key uses renderToken (job version + per-group manual tokens)
    // so a manual save or active-selector flip always busts the in-process cache.
    // FIX 2: `variant` is a separate key dimension (auto vs active can differ).
    // Orientation discriminates the cache. pdf_prewarm_state tracks only the
    // default (portrait) job PDF surfaced in the UI — the landscape variant is
    // on-demand and must not write the prewarm state.
    return this.pdfCache.ensure(
      `job:${cutJobId}:${variant}:${renderToken}:${rotate90 ? 'L' : 'P'}`,
      () => this.cut.renderJobPdf({ currentUser: currentUser!, cutJobId, rotate90, variant, requestId }),
      (state, reason) => {
        if (rotate90) return;
        void this.cut.setPdfPrewarmState({ cutJobId, version, state, reason }).catch(() => undefined);
      },
    );
  }

  /** Fire-and-forget whole-job PDF pre-warm (kicked after a successful calculate
   *  or manual save). FIX 3: the prewarm MUST key on the same render token the
   *  default export reads (`getRenderCacheToken({cutJobId})` === `job.renderToken`),
   *  otherwise the prewarm warms a key the export never looks up and the first
   *  export is a cold synchronous miss. Uses the default `auto` variant (the
   *  surfaced whole-job PDF), matching exportJobPdf's default key dimension.
   */
  private prewarmJobPdf(
    currentUser: RequestWithCurrentUser['user'],
    cutJobId: number,
    version: number,
    requestId: string | undefined,
  ): void {
    void this.cut
      .getRenderCacheToken({ cutJobId })
      .then((renderToken) => {
        this.ensureJobPdf(currentUser, cutJobId, renderToken, version, requestId);
      })
      .catch(() => undefined);
  }

  private sendPdf(response: Response, result: PdfEnsureResult, filename: string): void {
    if (result.status === 'ready') {
      response.setHeader('Content-Type', 'application/pdf');
      response.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      response.setHeader('Cache-Control', 'private, max-age=60');
      response.send(result.buffer);
      return;
    }
    if (result.status === 'failed') {
      // Surface a deterministic render failure (e.g. empty group/job) instead of
      // looping 202 forever. Re-throw the original ApiError; wrap anything else.
      throw result.error instanceof ApiError
        ? result.error
        : new ApiError(500, 'CUT_PDF_RENDER_FAILED', 'Не удалось сформировать PDF раскроя');
    }
    // Cold cache: render is in-flight; ask the client to retry (plan §7/§8).
    response.setHeader('Retry-After', String(PDF_RETRY_AFTER_SECONDS));
    response.status(202).json({ status: 'pending', retryAfterSeconds: PDF_RETRY_AFTER_SECONDS });
  }

  private requireRead(request: RequestWithCurrentUser) {
    this.assertCutEnabled();
    return this.requireCurrentUser(request);
  }

  private requireMutation(request: RequestWithCurrentUser) {
    this.assertCutEnabled();
    this.assertNotReadOnly();
    return this.requireCurrentUser(request);
  }

  private assertCutEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().cutEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Cut jobs API is disabled', { feature: 'cut' });
    }
  }

  private assertNotReadOnly(): void {
    if (this.runtimeConfig.getFeatureFlags().cutReadOnly) {
      throw new ApiError(503, 'SERVICE_READ_ONLY', 'Cut jobs API is read-only', { feature: 'cut' });
    }
  }

  private requireCurrentUser(request: RequestWithCurrentUser) {
    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }
    return request.user;
  }
}

export function parseCutJobId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Invalid id', { field: 'cutJobId', value });
  }
  return id;
}

export function parseSheetIndex(value: string): number {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Invalid sheet index', { field: 'sheetIndex', value });
  }
  return index;
}

/** Preset NAME (resolved to px from cut_render_presets config at render time).
 *  Sanitized to a short safe token; defaults to the standard `screen` preset. */
export function parsePreset(value: string | undefined): string {
  const name = (value ?? 'screen').trim();
  if (name.length === 0 || name.length > 64 || !/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid preset', { field: 'preset' });
  }
  return name;
}

/** Landscape orientation flag for sheet renders: `?orientation=landscape` rotates
 *  the layout 90° (long side horizontal). Default (absent / 'portrait') → false. */
export function parseOrientation(value: string | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'landscape';
}

/**
 * Task 7: parse the ?variant query parameter.
 *
 * - Absent / unknown → 'auto' (default preserves behaviour for all existing callers).
 * - 'manual'         → use the group's stored manual layout sheets (hard-fails if unavailable).
 * - 'active'         → use manual when effectiveActive (is_active && !is_stale); else auto.
 */
export function parseVariant(value: string | undefined): 'auto' | 'manual' | 'active' {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'manual') return 'manual';
  if (v === 'active') return 'active';
  return 'auto';
}

export function parseCreateCutJobRequest(body: unknown) {
  return parse(createCutJobRequestSchema, body);
}

export function parseAddItemsRequest(body: unknown) {
  return parse(addItemsRequestSchema, body);
}

export function parseVersionBody(body: unknown): number {
  return parse(versionBodySchema, body).version;
}

export function parseSetProfileBody(body: unknown): { paramProfileId: number | null; version: number } {
  return parse(setProfileBodySchema, body);
}

export function parseSetSheetMaterialBody(body: unknown): { sheetMaterialTypeId: number | null; version: number } {
  return parse(setSheetMaterialBodySchema, body);
}

export function parseSetCombineFilmsBody(body: unknown): { combineFilms: boolean; version: number } {
  return parse(setCombineFilmsBodySchema, body);
}

export function parseSetSplitByMaterialBody(body: unknown): { splitByMaterial: boolean; version: number } {
  return parse(setSplitByMaterialBodySchema, body);
}

export function parseSaveManualLayoutBody(body: unknown): { jobVersion: number; active: boolean; placements: ManualMove[] } {
  return parse(saveManualLayoutBodySchema, body);
}

/** Query CSV (`orderIds=9,10`) → number arrays. */
export function parseEligibleCriteria(query: Record<string, string>): CutSelectionCriteriaDto {
  return {
    sheetMaterialTypeIds: parseCsvIds(query.sheetMaterialTypeIds),
    orderIds: parseCsvIds(query.orderIds),
    filmIds: parseCsvIds(query.filmIds),
    productionStatusIds: parseCsvIds(query.productionStatusIds),
  };
}

function parseCsvIds(value: string | undefined): number[] | undefined {
  if (!value) return undefined;
  const ids = value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length ? ids : undefined;
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Cut job payload validation failed', {
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'body',
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}
