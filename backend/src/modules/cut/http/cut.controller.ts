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
  CutFilmOptionDto,
  CutJobDeleteImpactDto,
  CutJobDto,
  CutTextureDirection,
  CutResultDto,
  CutResultSummaryDto,
  CutSelectionCriteriaDto,
  EligibleDetailsResponseDto,
} from '../dto/cut.dto';
import type { CutSheetTypeOption, ManualMove, SheetViewTransform } from '../application/cut-command.types';
import { CutPdfCache } from '../application/cut-pdf-cache';
import { CutRuntimeConfigService } from './cut-runtime-config.service';
import {
  normalizeCutRenderStyleName,
  type CutRenderStyleName,
} from '../../../shared/cut-render-style';

const idArray = z.array(z.number().int().positive()).max(5000);

const criteriaSchema = z
  .object({
    /** Variant B: filter by sheet_material_type_id (replaces materialIds post-034). */
    sheetMaterialTypeIds: idArray.optional(),
    orderIds: idArray.optional(),
    filmIds: idArray.optional(),
    productionStatusIds: idArray.optional(),
    dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();

const createCutJobRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    criteria: criteriaSchema.optional(),
    detailIds: idArray.optional(),
    hdfDetailIds: idArray.optional(),
  })
  .strict();

const addItemsRequestSchema = z
  .object({
    detailIds: idArray.optional(),
    hdfDetailIds: idArray.optional(),
    version: z.number().int().min(0),
  })
  .superRefine((value, context) => {
    if ((value.detailIds?.length ?? 0) === 0 && (value.hdfDetailIds?.length ?? 0) === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['detailIds'],
        message: 'At least one detail id is required',
      });
    }
  })
  .strict();

const versionBodySchema = z.object({ version: z.number().int().min(0) }).strict();
const deleteCutJobBodySchema = z.object({
  version: z.number().int().min(0),
  deleteLinkedMdfPackets: z.boolean().optional().default(false),
}).strict();
const calculateBodySchema = z.object({
  version: z.number().int().min(0),
  commandId: z.string().uuid(),
}).strict();

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

const setRotationAllowedBodySchema = z
  .object({
    rotationAllowed: z.boolean(),
    version: z.number().int().nonnegative(),
  })
  .strict();

const setTextureDirectionBodySchema = z
  .object({
    textureDirection: z.enum(['vertical', 'horizontal', 'none']),
    version: z.number().int().nonnegative(),
  })
  .strict();

const setPdfTemplateBodySchema = z
  .object({
    pdfTemplate: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

const setNameBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
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

const sheetViewTransformSchema = z.object({
  sheetIndex: z.number().int().min(0),
  rotationDeg: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  mirrorHorizontal: z.boolean(),
  mirrorVertical: z.boolean(),
}).strict();

const saveManualLayoutBodySchema = z
  .object({
    jobVersion: z.number().int().nonnegative(),
    active: z.boolean(),
    placements: z.array(manualMoveSchema),
    sheetTransforms: z.array(sheetViewTransformSchema).default([]),
    commandId: z.string().uuid(),
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

  @ApiOperation({ operationId: 'listCutJobs', summary: 'List cut jobs' })
  @Get()
  async list(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string | undefined> = {},
  ): Promise<CutJobDto[]> {
    const currentUser = this.requireRead(request);
    return this.cut.listJobs({
      currentUser,
      filters: parseListCutJobsQuery(query),
      requestId: request.requestId,
    });
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

  @ApiOperation({
    operationId: 'listCutFilmOptions',
    summary: 'List distinct films for the cut filter under current criteria',
  })
  @Get('film-options')
  async listFilmOptions(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string>,
  ): Promise<CutFilmOptionDto[]> {
    // Registered BEFORE ':cutJobId' so the literal 'film-options' path is not captured as an id.
    const currentUser = this.requireRead(request);
    return this.cut.listFilmOptionsForCut({
      currentUser,
      criteria: parseEligibleCriteria(query),
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'previewCutEligibleDetails', summary: 'Preview criteria-driven details before creating a cut job' })
  @Get('eligible-details')
  async previewEligibleDetails(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string>,
  ): Promise<EligibleDetailsResponseDto> {
    const currentUser = this.requireRead(request);
    return this.cut.listEligibleDetails({
      currentUser,
      criteria: parseEligibleCriteria(query),
      includeAllStatuses: true,
      requestId: request.requestId,
    });
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

  @ApiOperation({
    operationId: 'createCutJobMdfBoardCard',
    summary: 'Create a visible MDF board machine-file card for a linked SVG cut job',
  })
  @Post(':cutJobId/mdf-board-card')
  async createMdfBoardCard(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
  ): Promise<CutJobDto> {
    const currentUser = this.requireMutation(request);
    return this.cut.createMdfBoardCard({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      requestId: request.requestId,
    });
  }

  @ApiOperation({
    operationId: 'getCutJobDeleteImpact',
    summary: 'Preview linked records affected by deleting a cut job',
  })
  @Get(':cutJobId/delete-impact')
  async deleteImpact(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
  ): Promise<CutJobDeleteImpactDto> {
    const currentUser = this.requireMutation(request);
    return this.cut.getDeleteImpact({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'listCutResults', summary: 'List immutable completed results for a cut job' })
  @Get(':cutJobId/results')
  async listResults(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
  ): Promise<CutResultSummaryDto[]> {
    const currentUser = this.requireRead(request);
    return this.cut.listResults({ currentUser, cutJobId: parseCutJobId(cutJobId), requestId: request.requestId });
  }

  @ApiOperation({ operationId: 'getCutResult', summary: 'Get one immutable completed cut result' })
  @Get(':cutJobId/results/:resultNo')
  async getResult(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Param('resultNo') resultNo: string,
  ): Promise<CutResultDto> {
    const currentUser = this.requireRead(request);
    return this.cut.getResult({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      resultNo: parseCutJobId(resultNo),
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'setCutResultCurrent', summary: 'Mark a completed cut result as active/current for a cut job' })
  @Post(':cutJobId/results/:resultNo/current')
  async setResultCurrent(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Param('resultNo') resultNo: string,
  ): Promise<CutJobDto> {
    const currentUser = this.requireMutation(request);
    return this.cut.setCurrentResult({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      resultNo: parseCutJobId(resultNo),
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'archiveCutResult', summary: 'Archive a completed cut result for external selections' })
  @Post(':cutJobId/results/:resultNo/archive')
  async archiveResult(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Param('resultNo') resultNo: string,
  ): Promise<CutJobDto> {
    const currentUser = this.requireMutation(request);
    return this.cut.archiveResult({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      resultNo: parseCutJobId(resultNo),
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'unarchiveCutResult', summary: 'Return a completed cut result from archive' })
  @Delete(':cutJobId/results/:resultNo/archive')
  async unarchiveResult(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Param('resultNo') resultNo: string,
  ): Promise<CutJobDto> {
    const currentUser = this.requireMutation(request);
    return this.cut.unarchiveResult({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      resultNo: parseCutJobId(resultNo),
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'renderCutResultSheetPng', summary: 'Render a frozen result sheet PNG' })
  @Get(':cutJobId/results/:resultNo/groups/:groupId/sheets/:sheetIndex.png')
  async renderResultPng(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Param('resultNo') resultNo: string,
    @Param('groupId') groupId: string,
    @Param('sheetIndex') sheetIndex: string,
    @Query() query: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    const currentUser = this.requireRead(request);
    const axisOrigin = parseAxisOrigin(query.axisOrigin);
    const png = await this.cut.renderSheetPng({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      resultNo: parseCutJobId(resultNo),
      cutGroupId: parseCutJobId(groupId),
      sheetIndex: parseSheetIndex(sheetIndex),
      preset: parsePreset(query.preset),
      rotate90: parseOrientation(query.orientation),
      originTopLeft: canonicalOriginTopLeft(parseOriginTopLeft(query.origin), axisOrigin),
      axisOrigin,
      variant: parseVariant(query.variant),
      showLabels: query.labels !== 'off',
      renderStyle: parseRenderStyle(query.renderStyle),
      requestId: request.requestId,
    });
    response.setHeader('Content-Type', 'image/png');
    response.setHeader('Cache-Control', 'private, no-store');
    response.send(png);
  }

  @ApiOperation({ operationId: 'renderCutResultSheetSvg', summary: 'Render a frozen result sheet SVG' })
  @Get(':cutJobId/results/:resultNo/groups/:groupId/sheets/:sheetIndex.svg')
  async renderResultSvg(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Param('resultNo') resultNo: string,
    @Param('groupId') groupId: string,
    @Param('sheetIndex') sheetIndex: string,
    @Query() query: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    const currentUser = this.requireRead(request);
    const axisOrigin = parseAxisOrigin(query.axisOrigin);
    const svg = await this.cut.renderSheetSvg({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      resultNo: parseCutJobId(resultNo),
      cutGroupId: parseCutJobId(groupId),
      sheetIndex: parseSheetIndex(sheetIndex),
      rotate90: parseOrientation(query.orientation),
      originTopLeft: canonicalOriginTopLeft(parseOriginTopLeft(query.origin), axisOrigin),
      axisOrigin,
      variant: parseVariant(query.variant),
      pieceMetadata: query.pieceMetadata === 'on',
      renderStyle: parseRenderStyle(query.renderStyle),
      requestId: request.requestId,
    });
    response.setHeader('Content-Type', 'image/svg+xml');
    response.setHeader('Cache-Control', 'private, no-store');
    response.send(svg);
  }

  @ApiOperation({ operationId: 'exportCutResultGroupPdf', summary: 'Export a frozen result group PDF' })
  @Get(':cutJobId/results/:resultNo/groups/:groupId/export.pdf')
  async exportResultGroupPdf(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Param('resultNo') resultNo: string,
    @Param('groupId') groupId: string,
    @Query() query: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    const currentUser = this.requireRead(request);
    const axisOrigin = parseAxisOrigin(query.axisOrigin);
    const pdf = await this.cut.renderGroupPdf({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      resultNo: parseCutJobId(resultNo),
      cutGroupId: parseCutJobId(groupId),
      rotate90: parseOrientation(query.orientation),
      originTopLeft: canonicalOriginTopLeft(parseOriginTopLeft(query.origin), axisOrigin),
      axisOrigin,
      variant: parseVariant(query.variant),
      pdfTemplate: query.template === undefined ? undefined : parsePdfTemplate(query.template),
      requestId: request.requestId,
    });
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Cache-Control', 'private, no-store');
    response.send(pdf);
  }

  @ApiOperation({ operationId: 'exportCutResultJobPdf', summary: 'Export a frozen whole-result PDF' })
  @Get(':cutJobId/results/:resultNo/export.pdf')
  async exportResultJobPdf(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Param('resultNo') resultNo: string,
    @Query() query: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    const currentUser = this.requireRead(request);
    const axisOrigin = parseAxisOrigin(query.axisOrigin);
    const pdf = await this.cut.renderJobPdf({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      resultNo: parseCutJobId(resultNo),
      rotate90: parseOrientation(query.orientation),
      originTopLeft: canonicalOriginTopLeft(parseOriginTopLeft(query.origin), axisOrigin),
      axisOrigin,
      variant: parseVariant(query.variant),
      pdfTemplate: query.template === undefined ? undefined : parsePdfTemplate(query.template),
      requestId: request.requestId,
    });
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Cache-Control', 'private, no-store');
    response.send(pdf);
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
      dto: { detailIds: parsed.detailIds, hdfDetailIds: parsed.hdfDetailIds },
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
    const parsed = parseCalculateBody(body);
    const job = await this.cut.calculate({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      version: parsed.version,
      commandId: parsed.commandId,
      requestId: request.requestId,
    });
    // Fire-and-forget readiness render. User-facing PDF exports render fresh on
    // every request so volatile dynamic fields/CNC relations never come from cache.
    if (job.status === 'ready') {
      this.prewarmJobPdf(currentUser, job.cutJobId, job.version, request.requestId);
    }
    return job;
  }

  @ApiOperation({ operationId: 'deleteCutJob', summary: 'Delete a cut job (release reservations)' })
  @Delete(':cutJobId')
  async archive(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Body() body: unknown,
  ): Promise<CutJobDto> {
    const currentUser = this.requireMutation(request);
    const parsed = parseDeleteCutJobBody(body);
    return this.cut.archive({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      version: parsed.version,
      deleteLinkedMdfPackets: parsed.deleteLinkedMdfPackets,
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

  @ApiOperation({ operationId: 'setCutJobRotationAllowed', summary: 'Toggle 90-degree detail rotation for a job calculation' })
  @Patch(':cutJobId/rotation-allowed')
  async setRotationAllowed(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Body() body: unknown,
  ): Promise<CutJobDto> {
    const currentUser = this.requireMutation(request);
    const { rotationAllowed, version } = parseSetRotationAllowedBody(body);
    return this.cut.setRotationAllowed({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      rotationAllowed,
      version,
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'setCutJobTextureDirection', summary: 'Set informational material/film texture direction for PDF maps' })
  @Patch(':cutJobId/texture-direction')
  async setTextureDirection(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Body() body: unknown,
  ): Promise<CutJobDto> {
    const currentUser = this.requireMutation(request);
    const { textureDirection, version } = parseSetTextureDirectionBody(body);
    return this.cut.setTextureDirection({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      textureDirection,
      version,
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'setCutJobPdfTemplate', summary: 'Set the PDF template for a whole cut job export' })
  @Patch(':cutJobId/pdf-template')
  async setJobPdfTemplate(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Body() body: unknown,
  ): Promise<CutJobDto> {
    const currentUser = this.requireMutation(request);
    const { pdfTemplate } = parseSetPdfTemplateBody(body);
    return this.cut.setJobPdfTemplate({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      pdfTemplate,
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'setCutJobName', summary: 'Rename a cut job' })
  @Patch(':cutJobId/name')
  async setName(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Body() body: unknown,
  ): Promise<CutJobDto> {
    const currentUser = this.requireMutation(request);
    const { name, version } = parseSetNameBody(body);
    return this.cut.setName({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      name,
      version,
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'setCutGroupPdfTemplate', summary: 'Set the PDF template for a cut group export' })
  @Patch(':cutJobId/groups/:groupId/pdf-template')
  async setGroupPdfTemplate(
    @Req() request: RequestWithCurrentUser,
    @Param('cutJobId') cutJobId: string,
    @Param('groupId') groupId: string,
    @Body() body: unknown,
  ): Promise<CutJobDto> {
    const currentUser = this.requireMutation(request);
    const { pdfTemplate } = parseSetPdfTemplateBody(body);
    return this.cut.setGroupPdfTemplate({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      cutGroupId: parseCutJobId(groupId),
      pdfTemplate,
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
    const { jobVersion, active, placements, sheetTransforms, commandId } = parseSaveManualLayoutBody(body);
    const job = await this.cut.saveManualLayout({
      currentUser,
      cutJobId: parseCutJobId(cutJobId),
      cutGroupId: parseCutJobId(groupId),
      jobVersion,
      active,
      placements,
      sheetTransforms,
      commandId,
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
    const axisOrigin = parseAxisOrigin(query.axisOrigin);
    const png = await this.cut.renderSheetPng({
      currentUser,
      cutJobId: parsedJobId,
      cutGroupId: parseCutJobId(groupId),
      sheetIndex: parseSheetIndex(sheetIndex),
      preset: parsePreset(query.preset),
      rotate90: parseOrientation(query.orientation),
      originTopLeft: canonicalOriginTopLeft(parseOriginTopLeft(query.origin), axisOrigin),
      axisOrigin,
      variant: parseVariant(query.variant),
      showLabels: query.labels !== 'off',
      renderStyle: parseRenderStyle(query.renderStyle),
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
    const axisOrigin = parseAxisOrigin(query.axisOrigin);
    const svg = await this.cut.renderSheetSvg({
      currentUser,
      cutJobId: parsedJobId,
      cutGroupId: parseCutJobId(groupId),
      sheetIndex: parseSheetIndex(sheetIndex),
      rotate90: parseOrientation(query.orientation),
      originTopLeft: canonicalOriginTopLeft(parseOriginTopLeft(query.origin), axisOrigin),
      axisOrigin,
      variant: parseVariant(query.variant),
      pieceMetadata: query.pieceMetadata === 'on',
      renderStyle: parseRenderStyle(query.renderStyle),
      requestId: request.requestId,
    });
    response.setHeader('Content-Type', 'image/svg+xml');
    response.setHeader('Cache-Control', 'private, max-age=60');
    response.send(svg);
  }

  @ApiOperation({ operationId: 'exportCutGroupPdf', summary: 'Export a per-group multi-page PDF (fresh on-demand render)' })
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
    const axisOrigin = parseAxisOrigin(query.axisOrigin);
    const originTopLeft = canonicalOriginTopLeft(parseOriginTopLeft(query.origin), axisOrigin);
    const variant = parseVariant(query.variant);
    const pdfTemplate = parsePdfTemplate(query.template);
    const pdf = await this.cut.renderGroupPdf({
      currentUser,
      cutGroupId,
      cutJobId: parsedJobId,
      rotate90,
      originTopLeft,
      axisOrigin,
      variant,
      pdfTemplate,
      requestId: request.requestId,
    });
    this.sendPdfBuffer(response, pdf, `cut-group-${cutGroupId}.pdf`);
  }

  @ApiOperation({ operationId: 'exportCutJobPdf', summary: 'Export a whole-job PDF (all groups; fresh on-demand render)' })
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
    const axisOrigin = parseAxisOrigin(query.axisOrigin);
    const originTopLeft = canonicalOriginTopLeft(parseOriginTopLeft(query.origin), axisOrigin);
    const variant = parseVariant(query.variant);
    const pdfTemplate = parsePdfTemplate(query.template);
    const pdf = await this.cut.renderJobPdf({
      currentUser,
      cutJobId: id,
      rotate90,
      originTopLeft,
      axisOrigin,
      variant,
      pdfTemplate,
      requestId: request.requestId,
    });
    this.sendPdfBuffer(response, pdf, `cut-job-${id}.pdf`);
  }

  /** Fire-and-forget whole-job readiness render (kicked after a successful
   *  calculate or manual save). It updates pdf_prewarm_state only; current
   *  user-facing exports ignore warmed bytes and render fresh so dynamic fields
   *  and CNC file-card relations are recalculated on every preview/download.
   *  The active variant and bottom-left axis match the surfaced whole-job PDF.
   */
  private prewarmJobPdf(
    currentUser: RequestWithCurrentUser['user'],
    cutJobId: number,
    version: number,
    requestId: string | undefined,
  ): void {
    void this.cut
      .renderJobPdf({
        currentUser: currentUser!,
        cutJobId,
        rotate90: false,
        originTopLeft: false,
        axisOrigin: 'bottom-left',
        variant: 'active',
        requestId,
      })
      .then(() => this.cut.setPdfPrewarmState({ cutJobId, version, state: 'ready' }))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        void this.cut.setPdfPrewarmState({ cutJobId, version, state: 'failed', reason }).catch(() => undefined);
      });
  }

  private sendPdfBuffer(response: Response, buffer: Buffer, filename: string): void {
    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    response.send(buffer);
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

/** Origin flag for rotated sheet renders: `?origin=raw` keeps the legacy 90° CW
 *  layout (dense cluster top-right); anything else (absent / 'tl') → true =
 *  transpose so the dense cluster anchors at the rotated view's top-left. Default
 *  ON matches the operator-facing checkbox default. Ignored when not rotated. */
export function parseOriginTopLeft(value: string | undefined): boolean {
  return (value ?? '').trim().toLowerCase() !== 'raw';
}

/** Final-view Y-axis origin. Absent stays top-left for old clients. */
export function parseAxisOrigin(value: string | undefined): 'top-left' | 'bottom-left' {
  return (value ?? '').trim().toLowerCase() === 'bottom-left' ? 'bottom-left' : 'top-left';
}

/** Bottom-left uses the RAW/CW orientation path so portrait → landscape turns right. */
export function canonicalOriginTopLeft(
  originTopLeft: boolean,
  axisOrigin: 'top-left' | 'bottom-left',
): boolean {
  return axisOrigin === 'bottom-left' ? false : originTopLeft;
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

export function parseRenderStyle(value: string | undefined): CutRenderStyleName {
  return normalizeCutRenderStyleName(value);
}

export function parsePdfTemplate(value: string | undefined): string {
  const template = (value ?? 'standard').trim();
  if (template.length === 0 || template.length > 64 || !/^[A-Za-z0-9_-]+$/.test(template)) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid PDF template', { field: 'template' });
  }
  return template;
}

export function parseCreateCutJobRequest(body: unknown) {
  return parse(createCutJobRequestSchema, body);
}

export function parseListCutJobsQuery(query: Record<string, string | undefined>) {
  const orderSearch = parseOptionalSearch(query.orderSearch, 'orderSearch');
  const jobNumber = parseOptionalSearch(query.jobNumber, 'jobNumber');
  const includeArchived = parseOptionalBoolean(query.includeArchived, 'includeArchived');
  return {
    ...(query.status ? { status: query.status.trim() } : {}),
    ...(query.createdBy && Number.isInteger(Number(query.createdBy)) && Number(query.createdBy) > 0
      ? { createdBy: Number(query.createdBy) }
      : {}),
    ...(includeArchived === true ? { includeArchived } : {}),
    ...(orderSearch ? { orderSearch } : {}),
    ...(jobNumber ? { jobNumber } : {}),
    ...(parseOptionalDateOnly(query.createdFrom, 'createdFrom') ? { createdFrom: parseOptionalDateOnly(query.createdFrom, 'createdFrom') } : {}),
    ...(parseOptionalDateOnly(query.createdTo, 'createdTo') ? { createdTo: parseOptionalDateOnly(query.createdTo, 'createdTo') } : {}),
  };
}

export function parseAddItemsRequest(body: unknown) {
  return parse(addItemsRequestSchema, body);
}

export function parseVersionBody(body: unknown): number {
  return parse(versionBodySchema, body).version;
}

export function parseDeleteCutJobBody(body: unknown): { version: number; deleteLinkedMdfPackets: boolean } {
  return parse(deleteCutJobBodySchema, body);
}

export function parseCalculateBody(body: unknown): { version: number; commandId: string } {
  return parse(calculateBodySchema, body);
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

export function parseSetRotationAllowedBody(body: unknown): { rotationAllowed: boolean; version: number } {
  return parse(setRotationAllowedBodySchema, body);
}

export function parseSetTextureDirectionBody(body: unknown): { textureDirection: CutTextureDirection; version: number } {
  return parse(setTextureDirectionBodySchema, body);
}

export function parseSetPdfTemplateBody(body: unknown): { pdfTemplate: string } {
  return parse(setPdfTemplateBodySchema, body);
}

export function parseSetNameBody(body: unknown): { name: string; version: number } {
  return parse(setNameBodySchema, body);
}

export function parseSaveManualLayoutBody(body: unknown): { jobVersion: number; active: boolean; placements: ManualMove[]; sheetTransforms: SheetViewTransform[]; commandId: string } {
  return parse(saveManualLayoutBodySchema, body);
}

/** Query CSV (`orderIds=9,10`) → number arrays. */
export function parseEligibleCriteria(query: Record<string, string>): CutSelectionCriteriaDto {
  return {
    sheetMaterialTypeIds: parseCsvIds(query.sheetMaterialTypeIds),
    orderIds: parseCsvIds(query.orderIds),
    filmIds: parseCsvIds(query.filmIds),
    productionStatusIds: parseCsvIds(query.productionStatusIds),
    dateFrom: parseOptionalDateOnly(query.dateFrom, 'dateFrom'),
    dateTo: parseOptionalDateOnly(query.dateTo, 'dateTo'),
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

function parseOptionalDateOnly(value: string | undefined, field: string): string | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Cut job payload validation failed', {
      errors: [{ field, message: `${field} must use YYYY-MM-DD format` }],
    });
  }
  return value;
}

function parseOptionalSearch(value: string | undefined, field: string): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (text.length > 100) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Cut job payload validation failed', {
      errors: [{ field, message: `${field} must be at most 100 characters` }],
    });
  }
  return text;
}

function parseOptionalBoolean(value: string | undefined, field: string): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new ApiError(422, 'VALIDATION_ERROR', 'Cut job query validation failed', {
    errors: [{ field, message: `${field} must be boolean` }],
  });
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
