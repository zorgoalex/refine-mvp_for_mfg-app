import { Body, Controller, Get, Headers, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RequestWithCurrentUser } from '../../permissions/current-user';
import { CatalogService } from './catalog.service';
import { parseCatalogId, requireCatalogPermission } from './catalog.validation';

@ApiTags('Catalog')
@ApiBearerAuth()
@Controller('catalog-items')
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly service: CatalogService) {}

  @ApiOperation({ operationId: 'listCatalogItems', summary: 'Товары и услуги: список' })
  @Get()
  list(@Req() req: RequestWithCurrentUser, @Query() query: unknown) {
    return this.service.list(requireCatalogPermission(req.user), query);
  }

  @ApiOperation({ operationId: 'listCatalogUnits', summary: 'Все единицы измерения каталога' })
  @Get('units')
  units(@Req() req: RequestWithCurrentUser) { return this.service.units(requireCatalogPermission(req.user)); }

  @ApiOperation({ operationId: 'getCatalogItem', summary: 'Карточка товара или услуги' })
  @Get(':id')
  get(@Req() req: RequestWithCurrentUser, @Param('id') id: string) {
    return this.service.get(requireCatalogPermission(req.user), parseCatalogId(id));
  }

  @ApiOperation({ operationId: 'createCatalogItem', summary: 'Создать товар или услугу' })
  @Post()
  create(@Req() req: RequestWithCurrentUser, @Body() body: unknown, @Headers('idempotency-key') key: unknown) {
    return this.service.save(requireCatalogPermission(req.user, true), body, key, req.requestId ?? 'unknown');
  }

  @ApiOperation({ operationId: 'updateCatalogItem', summary: 'Изменить, архивировать или восстановить позицию' })
  @Put(':id')
  update(@Req() req: RequestWithCurrentUser, @Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key: unknown) {
    return this.service.save(requireCatalogPermission(req.user, true), body, key, req.requestId ?? 'unknown', parseCatalogId(id));
  }
}
