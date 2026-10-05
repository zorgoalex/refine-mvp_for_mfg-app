import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { DECISIONS_FORMAT, DECISIONS_MAX_ROWS } from '../domain/catalog-decisions';
import { CATALOG_MAX_ROWS } from '../../../shared/film-catalog';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { PermissionsGuard } from '../../../permissions/permissions.guard';
import { RequirePermissions } from '../../../permissions/require-permissions.decorator';
import { CatalogImportService } from '../application/catalog-import.service';
import { CatalogImportRuntimeConfigService } from '../application/catalog-import-runtime-config.service';

const catalogRowSchema = z
  .object({
    rowNo: z.number().int().positive().max(1_000_000),
    nameOriginal: z.string().max(500),
    nameFull: z.string().max(500),
    supplier: z.string().max(500),
    nomenclatureType: z.string().max(500).nullable(),
    unit: z.string().max(500).nullable(),
    nomenclatureCategory: z.string().max(500).nullable(),
  })
  .strict();
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const decisionsSchema = z
  .object({
    format: z.literal(DECISIONS_FORMAT),
    version: z.number().int(),
    fingerprintVersion: z.number().int(),
    sourceBatchId: z.number().int().positive(),
    exportedAt: z.string().max(40),
    sha256: hex64,
    rows: z
      .array(
        z
          .object({
            catalogKey: z.string().min(1).max(500),
            onecRefKey: z.string().uuid().nullable(),
            rowNo: z.number().int().positive().max(1_000_000),
            nameOriginal: z.string().max(500),
            nameFull: z.string().max(500),
            supplier: z.string().max(500),
            nomenclatureType: z.string().max(500).nullable(),
            unit: z.string().max(500).nullable(),
            nomenclatureCategory: z.string().max(500).nullable(),
            targetName: z.string().min(1).max(500),
            supplierNorm: z.string().max(500),
            canonicalFilmTexture: z.boolean().nullable(),
            canonicalFilmTypeId: z.number().int().positive().max(32767).nullable(),
            outcome: z.enum(['existing', 'create']),
            films: z
              .array(
                z
                  .object({
                    filmId: z.number().int().positive(),
                    fingerprint: hex64,
                    role: z.enum(['canonical', 'duplicate']),
                  })
                  .strict()
              )
              .max(500),
          })
          .strict()
      )
      .min(1)
      .max(DECISIONS_MAX_ROWS),
    vendors: z
      .array(
        z
          .object({
            supplierNorm: z.string().max(500),
            vendorId: z.number().int().positive().max(32767),
            vendorName: z.string().min(1).max(250),
            materialTypeId: z.number().int().positive().max(32767).nullable(),
            created: z.boolean(),
          })
          .strict()
      )
      .max(1000),
  })
  .strict();
const createSchema = z.discriminatedUnion('source', [
  z
    .object({
      kind: z.literal('films'),
      source: z.literal('decisions'),
      decisions: decisionsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('films'),
      source: z.literal('file'),
      fileName: z.string().min(1).max(255),
      fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
      sheetName: z.string().min(1).max(255),
      rows: z.array(catalogRowSchema).min(1).max(CATALOG_MAX_ROWS),
    })
    .strict(),
  z
    .object({
      kind: z.literal('films'),
      source: z.literal('onec_mirror'),
      onecSourceId: z.number().int().positive(),
      categoryKey: z.string().uuid(),
    })
    .strict(),
]);
const patchSchema = z
  .object({
    version: z.number().int().positive(),
    actions: z
      .array(
        z.discriminatedUnion('type', [
          z.object({
            type: z.literal('setVendor'),
            supplierNorm: z.string(),
            vendorId: z.number().int().positive(),
          }),
          z.object({
            type: z.literal('createVendor'),
            supplierNorm: z.string(),
          }),
          z.object({
            type: z.literal('setOption'),
            createMissing: z.boolean(),
          }),
          z.object({ type: z.literal('acceptAllAuto') }),
          z.object({
            type: z.literal('setMatch'),
            filmId: z.number().int().positive(),
            rowId: z.number().int().positive().nullable(),
          }),
          z.object({
            type: z.literal('confirmMatch'),
            filmId: z.number().int().positive(),
          }),
          z.object({
            type: z.literal('setCanonical'),
            rowId: z.number().int().positive(),
            filmId: z.number().int().positive(),
          }),
          z.object({
            type: z.literal('setCanonicalProperties'),
            rowId: z.number().int().positive(),
            filmTexture: z.boolean(),
            filmTypeId: z.number().int().positive(),
          }),
        ])
      )
      .min(1)
      .max(500),
  })
  .strict();
const versionSchema = z
  .object({ version: z.number().int().positive() })
  .strict();

@ApiTags('Reference catalog import')
@ApiBearerAuth()
@Controller('catalog-imports')
// Без guard декоратор RequirePermissions — только метаданные: права проверяет PermissionsGuard.
@UseGuards(PermissionsGuard)
@RequirePermissions('references.manage')
export class CatalogImportController {
  constructor(
    private readonly service: CatalogImportService,
    private readonly runtime: CatalogImportRuntimeConfigService
  ) {}
  @Post()
  @ApiOperation({
    operationId: 'createCatalogImport',
    summary: 'Create film catalog import draft',
  })
  async create(
    @Req() req: RequestWithCurrentUser,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown
  ) {
    const user = this.user(req);
    this.enabled();
    const parsed = this.parse(createSchema, body);
    if (
      parsed.source === 'onec_mirror' &&
      !user.permissions.includes('onec.view')
    )
      throw this.notFound();
    return this.service.create(
      parsed,
      userId(user.id),
      req.requestId ?? 'unknown',
      this.idempotency(key)
    );
  }
  @Get('onec-sources')
  @RequirePermissions(['references.manage', 'onec.view'])
  @ApiOperation({
    operationId: 'listCatalogImportOnecSources',
    summary: 'List 1C sources',
  })
  async sources(@Req() req: RequestWithCurrentUser) {
    this.user(req);
    this.enabled();
    return this.service.sources();
  }
  @Get('onec-categories')
  @RequirePermissions(['references.manage', 'onec.view'])
  @ApiOperation({
    operationId: 'listCatalogImportOnecCategories',
    summary: 'List 1C catalog categories',
  })
  async categories(
    @Req() req: RequestWithCurrentUser,
    @Query('onecSourceId') source: string
  ) {
    this.user(req);
    this.enabled();
    return this.service.categories(this.positive(source));
  }
  @Get()
  @ApiOperation({
    operationId: 'listCatalogImports',
    summary: 'List film catalog imports',
  })
  async list(
    @Req() req: RequestWithCurrentUser,
    @Query('kind') kind?: string,
    @Query('status') status?: string
  ) {
    const user = this.user(req);
    this.enabled();
    if (kind && kind !== 'films') throw this.invalid('kind');
    return this.service.list(user, status);
  }
  @Get(':id')
  @ApiOperation({
    operationId: 'getCatalogImport',
    summary: 'Get film catalog import',
  })
  async get(@Req() req: RequestWithCurrentUser, @Param('id') id: string) {
    const user = this.user(req);
    this.enabled();
    return this.service.getBatch(this.positive(id), user.permissions);
  }
  @Get(':id/rows')
  @ApiOperation({
    operationId: 'listCatalogImportRows',
    summary: 'List catalog import rows',
  })
  async rows(
    @Req() req: RequestWithCurrentUser,
    @Param('id') id: string,
    @Query() query: Record<string, string | undefined>
  ) {
    const user = this.user(req);
    this.enabled();
    return this.service.rows(this.positive(id), user.permissions, query);
  }
  @Get(':id/matches')
  @ApiOperation({
    operationId: 'listCatalogImportMatches',
    summary: 'List catalog import matches',
  })
  async matches(
    @Req() req: RequestWithCurrentUser,
    @Param('id') id: string,
    @Query() query: Record<string, string | undefined>
  ) {
    const user = this.user(req);
    this.enabled();
    return this.service.matches(this.positive(id), user.permissions, query);
  }
  @Patch(':id')
  @ApiOperation({
    operationId: 'patchCatalogImport',
    summary: 'Edit film catalog import draft',
  })
  async patch(
    @Req() req: RequestWithCurrentUser,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown
  ) {
    const user = this.user(req);
    this.enabled();
    const parsed = this.parse(patchSchema, body);
    return this.service.patch(
      this.positive(id),
      user.permissions,
      parsed,
      userId(user.id),
      req.requestId ?? 'unknown',
      this.idempotency(key)
    );
  }
  @Post(':id/apply')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'applyCatalogImport',
    summary: 'Apply film catalog import',
  })
  async apply(
    @Req() req: RequestWithCurrentUser,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown
  ) {
    const user = this.user(req);
    this.enabled();
    const parsed = this.parse(versionSchema, body);
    return this.service.apply(
      this.positive(id),
      user.permissions,
      parsed.version,
      userId(user.id),
      req.requestId ?? 'unknown',
      this.idempotency(key)
    );
  }
  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'cancelCatalogImport',
    summary: 'Cancel film catalog import draft',
  })
  async cancel(
    @Req() req: RequestWithCurrentUser,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown
  ) {
    const user = this.user(req);
    this.enabled();
    const parsed = this.parse(versionSchema, body);
    return this.service.cancel(
      this.positive(id),
      user.permissions,
      parsed.version,
      userId(user.id),
      req.requestId ?? 'unknown',
      this.idempotency(key)
    );
  }
  @Post(':id/revert')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'revertCatalogImport',
    summary: 'Revert film catalog import',
  })
  async revert(
    @Req() req: RequestWithCurrentUser,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined
  ) {
    const user = this.user(req);
    this.enabled();
    return this.service.revert(
      this.positive(id),
      user.permissions,
      userId(user.id),
      req.requestId ?? 'unknown',
      this.idempotency(key)
    );
  }
  @Get(':id/decisions')
  @ApiOperation({
    operationId: 'exportCatalogImportDecisions',
    summary: 'Export the decisions file of an applied film catalog import (strict replay on another database)',
  })
  async decisions(@Req() req: RequestWithCurrentUser, @Param('id') id: string) {
    const user = this.user(req);
    this.enabled();
    return this.service.exportDecisions(this.positive(id), user.permissions);
  }
    @Get(':id/export.xlsx')
  @ApiOperation({
    operationId: 'exportCatalogImport',
    summary: 'Export film catalog import workbook',
  })
  async export(
    @Req() req: RequestWithCurrentUser,
    @Param('id') id: string,
    @Res() res: Response
  ) {
    const user = this.user(req);
    this.enabled();
    const bytes = await this.service.export(
      this.positive(id),
      user.permissions
    );
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="catalog-import-${id}.xlsx"`
    );
    res.send(bytes);
  }
  private enabled() {
    if (!this.runtime.enabled()) throw this.notFound();
  }
  private user(req: RequestWithCurrentUser) {
    if (!req.user)
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    return req.user;
  }
  private parse<T>(schema: z.ZodType<T>, body: unknown): T {
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw this.invalid(
        parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')
      );
    return parsed.data;
  }
  private invalid(message: string) {
    return new ApiError(400, 'VALIDATION_FAILED', message);
  }
  private notFound() {
    return new ApiError(
      404,
      'CATALOG_IMPORT_NOT_FOUND',
      'Пакет импорта не найден'
    );
  }
  private positive(raw: string) {
    if (!/^[1-9]\d{0,15}$/.test(raw) || !Number.isSafeInteger(Number(raw)))
      throw this.invalid('id must be positive integer');
    return Number(raw);
  }
  private idempotency(raw: string | undefined) {
    if (!raw || raw.length < 1 || raw.length > 200)
      throw this.invalid('Idempotency-Key required (1..200)');
    return raw;
  }
}

@ApiTags('Films')
@ApiBearerAuth()
@Controller('films')
@UseGuards(PermissionsGuard)
@RequirePermissions('references.view')
export class FilmReferenceController {
  constructor(private readonly service: CatalogImportService) {}
  @Get('name-index')
  @ApiOperation({
    operationId: 'listFilmNameIndex',
    summary: 'List current and historical film names',
  })
  async nameIndex(@Req() req: RequestWithCurrentUser) {
    if (!req.user)
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    return this.service.nameIndex();
  }
  @Get(':id/name-history')
  @ApiOperation({
    operationId: 'getFilmNameHistory',
    summary: 'Get film previous names',
  })
  async history(@Req() req: RequestWithCurrentUser, @Param('id') raw: string) {
    if (!req.user)
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    return this.service.nameHistory(this.positive(raw));
  }
  @Get('similar')
  @ApiOperation({
    operationId: 'findSimilarFilms',
    summary: 'Find similar films by current and former names',
  })
  async similar(
    @Req() req: RequestWithCurrentUser,
    @Query('name') name: string,
    @Query('vendorId') vendorId?: string,
    @Query('limit') limit?: string
  ) {
    if (!req.user)
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    if (!name || name.length > 500)
      throw new ApiError(
        400,
        'VALIDATION_FAILED',
        'name required, maximum 500 characters'
      );
    const count = limit === undefined ? 10 : Number(limit);
    if (!Number.isInteger(count) || count < 1 || count > 10)
      throw new ApiError(400, 'VALIDATION_FAILED', 'limit must be 1..10');
    return this.service.similar(
      name,
      vendorId ? this.positive(vendorId) : null,
      count
    );
  }
  private positive(raw: string) {
    if (!/^[1-9]\d{0,15}$/.test(raw) || !Number.isSafeInteger(Number(raw)))
      throw new ApiError(
        400,
        'VALIDATION_FAILED',
        'id must be positive integer'
      );
    return Number(raw);
  }
}

function userId(value: string): number {
  if (!/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new ApiError(401, 'AUTH_REQUIRED', 'Invalid authenticated user');
  return Number(value);
}
