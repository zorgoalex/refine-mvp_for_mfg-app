import { Body, Controller, Get, Inject, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { PermissionsGuard } from '../../../permissions/permissions.guard';
import { RequirePermissions } from '../../../permissions/require-permissions.decorator';
import { MAX_MATERIAL_SUPPLIERS } from '../application/material-suppliers';
import { FilmSuppliersService, type FilmSuppliersDto } from '../application/film-suppliers.service';

const supplierIdsSchema = z.array(z.number().int().positive().max(32_767)).max(MAX_MATERIAL_SUPPLIERS)
  .refine((ids) => new Set(ids).size === ids.length, 'Поставщик указан дважды');
const replaceSchema = z.object({ supplierIds: supplierIdsSchema, expectedSupplierIds: supplierIdsSchema }).strict();

/** Поставщики плёнок (migr 280): чтение — references.view, правка — references.manage (как плёнки в Hasura). */
@ApiTags('Material suppliers')
@ApiBearerAuth('bearerAuth')
@Controller()
@UseGuards(PermissionsGuard)
export class FilmSuppliersController {
  constructor(@Inject(FilmSuppliersService) private readonly service: FilmSuppliersService) {}

  @ApiOperation({ summary: 'Suppliers of films: chosen list and suppliers seen in 1C receipts (ids=1,2,3, at most 500)' })
  @Get('films/suppliers') @RequirePermissions(['references.view'])
  list(@Query('ids') ids: unknown): Promise<FilmSuppliersDto[]> {
    return this.service.list(parseIds(ids));
  }

  @ApiOperation({ summary: 'Replace the chosen suppliers of a film (compare-and-swap on the list the user saw)' })
  @Put('films/:id/suppliers') @RequirePermissions(['references.manage'])
  replace(@Param('id') id: string, @Body() body: unknown, @Req() request: RequestWithCurrentUser): Promise<FilmSuppliersDto> {
    const parsed = replaceSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный список поставщиков');
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    if (!request.requestId) throw new ApiError(500, 'INTERNAL_ERROR', 'Missing request id');
    return this.service.replace({
      currentUser: request.user,
      requestId: request.requestId,
      filmId: parseId(id),
      supplierIds: parsed.data.supplierIds,
      expectedSupplierIds: parsed.data.expectedSupplierIds,
    });
  }
}

function parseId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный идентификатор');
  return id;
}

/** `ids=1,2,3` — не больше 500. */
function parseIds(value: unknown): number[] {
  if (value === undefined || value === '') return [];
  if (typeof value !== 'string') throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный список');
  const ids = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean).map(Number))];
  if (ids.length > 500 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный список');
  return ids;
}
