import { Body, Controller, Delete, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { CutService } from '../application/cut.service';
import type {
  CutDetailPlacementsResponseDto,
  CutJobDto,
  CutSelectionCriteriaDto,
  EligibleDetailsResponseDto,
} from '../dto/cut.dto';
import type { CutSheetTypeOption } from '../application/cut-command.types';
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
    parseCutJobId(cutJobId);
    const png = await this.cut.renderSheetPng({
      currentUser,
      cutGroupId: parseCutJobId(groupId),
      sheetIndex: parseSheetIndex(sheetIndex),
      preset: parsePreset(query.preset),
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
    @Res() response: Response,
  ): Promise<void> {
    const currentUser = this.requireRead(request);
    parseCutJobId(cutJobId);
    const svg = await this.cut.renderSheetSvg({
      currentUser,
      cutGroupId: parseCutJobId(groupId),
      sheetIndex: parseSheetIndex(sheetIndex),
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
    @Res() response: Response,
  ): Promise<void> {
    const currentUser = this.requireRead(request);
    parseCutJobId(cutJobId);
    const cutGroupId = parseCutJobId(groupId);
    const result = this.pdfCache.ensure(`group:${cutGroupId}`, () =>
      this.cut.renderGroupPdf({ currentUser, cutGroupId, requestId: request.requestId }),
    );
    this.sendPdf(response, result, `cut-group-${cutGroupId}.pdf`);
  }

  @ApiOperation({ operationId: 'exportCutJobPdf', summary: 'Export a whole-job PDF (all groups; on-demand, cached, pre-warmed)' })
  @Get(':cutJobId/export.pdf')
  async exportJobPdf(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Res() response: Response,
  ): Promise<void> {
    const currentUser = this.requireRead(request);
    const id = parseCutJobId(cutJobId);
    // getJob gives the current version (cache discriminator) + enforces cut.view.
    const job = await this.cut.getJob({ currentUser, cutJobId: id, requestId: request.requestId });
    const result = this.ensureJobPdf(currentUser, id, job.version, request.requestId);
    this.sendPdf(response, result, `cut-job-${id}.pdf`);
  }

  private ensureJobPdf(
    currentUser: RequestWithCurrentUser['user'],
    cutJobId: number,
    version: number,
    requestId: string | undefined,
  ) {
    return this.pdfCache.ensure(
      `job:${cutJobId}:v${version}`,
      () => this.cut.renderJobPdf({ currentUser: currentUser!, cutJobId, requestId }),
      (state, reason) => {
        void this.cut.setPdfPrewarmState({ cutJobId, version, state, reason }).catch(() => undefined);
      },
    );
  }

  /** Fire-and-forget whole-job PDF pre-warm (kicked after a successful calculate). */
  private prewarmJobPdf(
    currentUser: RequestWithCurrentUser['user'],
    cutJobId: number,
    version: number,
    requestId: string | undefined,
  ): void {
    this.ensureJobPdf(currentUser, cutJobId, version, requestId);
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

export function parseCreateCutJobRequest(body: unknown) {
  return parse(createCutJobRequestSchema, body);
}

export function parseAddItemsRequest(body: unknown) {
  return parse(addItemsRequestSchema, body);
}

export function parseVersionBody(body: unknown): number {
  return parse(versionBodySchema, body).version;
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
