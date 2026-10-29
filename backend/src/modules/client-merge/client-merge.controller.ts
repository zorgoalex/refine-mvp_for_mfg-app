import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from '../../permissions/current-user';
import { PermissionsGuard } from '../../permissions/permissions.guard';
import { RequirePermissions } from '../../permissions/require-permissions.decorator';
import { CLIENT_MERGE } from './client-merge';
import { ClientMergeService } from './client-merge.service';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const key = z.string().trim().min(8).max(200);
const token = z.string().regex(/^[0-9a-f]{64}$/);
const previewSchema = z.object({ survivorId: id, mergedId: id }).strict();
const mergeSchema = z.object({ survivorId: id, mergedId: id, expectedCaseVersion: z.number().int().min(0), previewToken: token, idempotencyKey: key }).strict();
const undoSchema = z.object({ previewToken: token, idempotencyKey: key }).strict();

/** Merge of duplicate clients from the journal of duplicates (D1) and its undo. */
@ApiTags('Client merges')
@ApiBearerAuth('bearerAuth')
@Controller()
@UseGuards(PermissionsGuard)
export class ClientMergeController {
  constructor(@Inject(ClientMergeService) private readonly merges: ClientMergeService) {}

  @ApiOperation({ summary: 'What a merge of two clients of a case would move, drop and refuse; the preview token' })
  @Post('integration-duplicates/:caseId/merge-preview') @HttpCode(200) @RequirePermissions(['integrations.duplicates.view', 'clients.view', CLIENT_MERGE])
  async preview(@Param('caseId') caseId: string, @Body() body: unknown, @Req() request: RequestWithCurrentUser) {
    const dto = parse(previewSchema, body);
    return this.merges.preview(actor(request).user, parseId(caseId, 'DUPLICATE_CASE_NOT_FOUND'), dto.survivorId, dto.mergedId);
  }

  @ApiOperation({ summary: 'Merge the merged client into the survivor (one transaction; the preview token must still match)' })
  @Post('integration-duplicates/:caseId/merge') @HttpCode(200) @RequirePermissions(['integrations.duplicates.view', 'clients.view', CLIENT_MERGE])
  async merge(@Param('caseId') caseId: string, @Body() body: unknown, @Req() request: RequestWithCurrentUser) {
    const dto = parse(mergeSchema, body);
    const { user, requestId } = actor(request);
    return this.merges.merge(user, parseId(caseId, 'DUPLICATE_CASE_NOT_FOUND'), dto, requestId);
  }

  @ApiOperation({ summary: 'Merges of a client (as the survivor or the merged one) and where a merged client lives on' })
  @Get('client-merges') @RequirePermissions(['clients.view'])
  async history(@Query('clientId') clientId: unknown, @Req() request: RequestWithCurrentUser) {
    return this.merges.history(actor(request).user, parseId(String(clientId ?? ''), 'CLIENT_NOT_FOUND'));
  }

  @ApiOperation({ summary: 'One merge' })
  @Get('client-merges/:mergeId') @RequirePermissions(['clients.view'])
  async get(@Param('mergeId') mergeId: string, @Req() request: RequestWithCurrentUser) {
    return this.merges.get(actor(request).user, parseId(mergeId, 'CLIENT_MERGE_NOT_FOUND'));
  }

  @ApiOperation({ summary: 'What an undo of a merge would return now and what it would leave (with reasons)' })
  @Post('client-merges/:mergeId/undo-preview') @HttpCode(200) @RequirePermissions(['clients.view', CLIENT_MERGE])
  async undoPreview(@Param('mergeId') mergeId: string, @Req() request: RequestWithCurrentUser) {
    return this.merges.undoPreview(actor(request).user, parseId(mergeId, 'CLIENT_MERGE_NOT_FOUND'));
  }

  @ApiOperation({ summary: 'Undo a merge (within its term; the preview token must still match)' })
  @Post('client-merges/:mergeId/undo') @HttpCode(200) @RequirePermissions(['clients.view', CLIENT_MERGE])
  async undo(@Param('mergeId') mergeId: string, @Body() body: unknown, @Req() request: RequestWithCurrentUser) {
    const dto = parse(undoSchema, body);
    const { user, requestId } = actor(request);
    return this.merges.undo(user, parseId(mergeId, 'CLIENT_MERGE_NOT_FOUND'), dto, requestId);
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError(422, 'VALIDATION_FAILED', 'Неверный запрос', { issues: parsed.error.issues });
  return parsed.data;
}

function parseId(value: string, notFound: string): number {
  if (!/^\d{1,15}$/.test(value)) throw new ApiError(404, notFound, 'Не найдено');
  return Number(value);
}

function actor(request: RequestWithCurrentUser): { user: CurrentUser; requestId: string } {
  if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  if (!request.requestId) throw new ApiError(500, 'INTERNAL_ERROR', 'Missing request id');
  return { user: request.user, requestId: request.requestId };
}
