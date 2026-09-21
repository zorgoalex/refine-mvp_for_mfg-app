import { createHash } from 'node:crypto';
import { Controller, Get, Headers, Inject, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from '../../../permissions/current-user';
import type { MdfPublishedQuery } from '../adapters/mdf-published-snapshot';
import { MdfPublishedBoardService } from '../application/mdf-published-board.service';

@ApiTags('Orders')
@ApiBearerAuth()
@Controller('orders/status-board/mdf')
export class MdfPublishedBoardController {
  constructor(@Inject(MdfPublishedBoardService) private readonly board: MdfPublishedBoardService) {}
  @Get()
  @ApiOperation({ operationId: 'getPublishedMdfBoard',summary: 'Read one coherent MDF publication and queue snapshot' })
  @ApiResponse({ status: 200,description: 'schemaVersion=1; compact cards, positions, pending jobs and verification issues' })
  @ApiResponse({ status: 304,description: 'Unchanged authorized snapshot' })
  @ApiResponse({ status: 401,description: 'Authentication required' })
  @ApiResponse({ status: 403,description: 'Insufficient order visibility' })
  @ApiResponse({ status: 422,description: 'Invalid date/focus or scope limit' })
  @ApiResponse({ status: 503,description: 'Published MDF reads disabled' })
  async get(@Req() request: RequestWithCurrentUser,@Query() raw: Record<string,unknown>,
    @Headers('if-none-match') previous: string|undefined,@Res({ passthrough: true }) response: Response) {
    if (!request.user) throw new ApiError(401,'AUTH_REQUIRED','Authentication required');
    const query = parseMdfPublishedQuery(raw);
    // Authorization happens inside get even when the caller has a matching tag.
    const snapshot = await this.board.get(request.user,query);
    const etag = mdfPublishedEtag(request.user,query,snapshot);
    response.setHeader('Cache-Control','private, no-cache'); response.setHeader('ETag',etag);
    if (previous===etag) { response.status(304).end(); return; }
    return snapshot;
  }
}

export function parseMdfPublishedQuery(raw: Record<string,unknown>): MdfPublishedQuery {
  const invalid = (): never => { throw new ApiError(422,'MDF_QUERY_INVALID','Неверный период или идентификатор карточки'); };
  if (Object.keys(raw).some(k => !['dateTo','focusKind','focusId','orderIds'].includes(k))) invalid();
  const query: MdfPublishedQuery = {};
  if (raw.orderIds!==undefined) {
    if (typeof raw.orderIds!=='string' || !/^[1-9]\d*(,[1-9]\d*)*$/.test(raw.orderIds)) invalid();
    const ids=String(raw.orderIds).split(',').map(Number);
    if (ids.length>100 || ids.some(id => !Number.isSafeInteger(id))) invalid();
    query.orderIds=[...new Set(ids)].sort((a,b) => a-b);
  }
  if (raw.dateTo!==undefined) {
    if (typeof raw.dateTo!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.dateTo)) invalid();
    const value = String(raw.dateTo), parsed = new Date(`${value}T00:00:00.000Z`);
    if (value.startsWith('0000-') || !Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0,10)!==value) invalid();
    query.dateTo=value;
  }
  if (raw.focusKind!==undefined || raw.focusId!==undefined) {
    const kind=raw.focusKind,id=raw.focusId;
    if (typeof id!=='string' || !['packet','bazisCutSet','bath'].includes(String(kind))) invalid();
    if (kind==='packet' && typeof id==='string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) query.focus={ kind,id };
    else if (kind==='bazisCutSet' && typeof id==='string' && /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id))) query.focus={ kind,id };
    else if (kind==='bath' && typeof id==='string' && /^cut-result:[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id.slice(11)))) query.focus={ kind,id };
    else invalid();
  }
  return query;
}

export function mdfPublishedEtag(user: CurrentUser,query: MdfPublishedQuery,
  snapshot: Awaited<ReturnType<MdfPublishedBoardService['get']>>): string {
  const { generatedAt: _generatedAt,...stable }=snapshot;
  return `"${createHash('sha256').update(JSON.stringify([user.id,user.permissionsVersion ?? null,
    user.role,user.policyScopes ?? null,[...user.permissions].sort(),query,stable])).digest('hex')}"`;
}
