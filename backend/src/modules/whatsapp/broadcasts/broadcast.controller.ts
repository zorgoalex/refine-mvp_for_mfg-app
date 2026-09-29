import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { RequirePermissions } from '../../../permissions/require-permissions.decorator';
import { WhatsAppPermissionsGuard } from '../whatsapp-permissions.guard';
import {
  parseBroadcastControl, parseBroadcastCreate, parseBroadcastId, parseBroadcastReplan, parseBroadcastRetry, parseBroadcastRun,
  parseBroadcastUpdate, parseBroadcastVersion, parseDeliverySeq, parseRunId,
} from './broadcast.dto';
import { BroadcastService } from './broadcast.service';
import { BROADCAST_BASE_PERMISSIONS } from './broadcast.types';

// Stage A content needs exactly the digest bundle (plan §4.3); every read and command checks it.
const GATES = BROADCAST_BASE_PERMISSIONS;

@ApiTags('WhatsApp')
@ApiBearerAuth('bearerAuth')
@Controller('whatsapp')
@UseGuards(WhatsAppPermissionsGuard)
export class BroadcastController {
  constructor(@Inject(BroadcastService) private readonly service: BroadcastService) {}

  @ApiOperation({ summary: 'List WhatsApp broadcasts with the send barrier and runtime state' })
  @Get('broadcasts') @RequirePermissions(GATES)
  list() { return this.service.list(); }

  @ApiOperation({ summary: 'Create a WhatsApp broadcast' })
  @Post('broadcasts') @HttpCode(201) @RequirePermissions(GATES)
  create(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    return this.service.create(parseBroadcastCreate(body), user(request), requestId(request));
  }

  @ApiOperation({ summary: 'Read the global broadcast send barrier' })
  @Get('broadcasts/control') @RequirePermissions(GATES)
  control() { return this.service.control(); }

  @ApiOperation({ summary: 'Pause or resume all broadcasts' })
  @Post('broadcasts/control') @HttpCode(200) @RequirePermissions(GATES)
  setControl(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    const input = parseBroadcastControl(body);
    return this.service.setControl(input.version, input.paused, user(request), requestId(request));
  }

  @ApiOperation({ summary: 'Variables available in broadcast captions' })
  @Get('broadcasts/catalog') @RequirePermissions(GATES)
  catalog() { return this.service.catalog(); }

  @ApiOperation({ summary: 'Read-only history of the daily digest before the broadcasts cutover' })
  @Get('broadcasts/legacy-digest-runs') @RequirePermissions(GATES)
  legacyRuns() { return this.service.legacyRuns(); }

  @ApiOperation({ summary: 'Read one broadcast with today\'s frozen schedule' })
  @Get('broadcasts/:id') @RequirePermissions(GATES)
  get(@Param('id') id: string) { return this.service.get(parseBroadcastId(id)); }

  @ApiOperation({ summary: 'Update a broadcast (version compare-and-swap)' })
  @Patch('broadcasts/:id') @RequirePermissions(GATES)
  update(@Param('id') id: string, @Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    return this.service.update(parseBroadcastId(id), parseBroadcastUpdate(body), user(request), requestId(request));
  }

  @ApiOperation({ summary: 'Archive a broadcast (history is kept)' })
  @Post('broadcasts/:id/archive') @HttpCode(200) @RequirePermissions(GATES)
  archive(@Param('id') id: string, @Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    return this.service.archive(parseBroadcastId(id), parseBroadcastVersion(body).version, user(request), requestId(request));
  }

  @ApiOperation({ summary: 'Render a private in-memory preview of the broadcast' })
  @Post('broadcasts/:id/preview') @HttpCode(200) @RequirePermissions(GATES)
  preview(@Param('id') id: string, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'private, no-store');
    return this.service.preview(parseBroadcastId(id));
  }

  @ApiOperation({ summary: 'Queue a confirmed manual broadcast run' })
  @Post('broadcasts/:id/runs') @HttpCode(202) @RequirePermissions(GATES)
  createRun(@Param('id') id: string, @Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    return this.service.createManual(parseBroadcastId(id), parseBroadcastRun(body), user(request), requestId(request)).then((detail) => ({ run: detail.run }));
  }

  @ApiOperation({ summary: 'List the latest runs of one broadcast' })
  @Get('broadcasts/:id/runs') @RequirePermissions(GATES)
  runs(@Param('id') id: string) { return this.service.runs(parseBroadcastId(id)); }

  @ApiOperation({ summary: 'Replan today\'s automatic send of a broadcast' })
  @Post('broadcasts/:id/schedule/today/replan') @HttpCode(200) @RequirePermissions(GATES)
  replan(@Param('id') id: string, @Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    return this.service.replan(parseBroadcastId(id), parseBroadcastReplan(body), user(request), requestId(request));
  }

  @ApiOperation({ summary: 'Read one broadcast run with per-message delivery state' })
  @Get('broadcast-runs/:runId') @RequirePermissions(GATES)
  run(@Param('runId') runId: string) { return this.service.run(parseRunId(runId)); }

  @ApiOperation({ summary: 'Read one unexpired private PNG of a broadcast run' })
  @Get('broadcast-runs/:runId/messages/:seq/image') @RequirePermissions(GATES)
  async image(@Param('runId') runId: string, @Param('seq') seq: string, @Res() response: Response) {
    const image = await this.service.image(parseRunId(runId), parseDeliverySeq(seq));
    response.type('image/png').setHeader('Cache-Control', 'private, no-store').send(image.bytes);
  }

  @ApiOperation({ summary: 'Queue an explicitly confirmed retry of a broadcast run' })
  @Post('broadcast-runs/:runId/retry') @HttpCode(202) @RequirePermissions(GATES)
  retry(@Param('runId') runId: string, @Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    return this.service.retry(parseRunId(runId), parseBroadcastRetry(body), user(request), requestId(request)).then((detail) => ({ run: detail.run }));
  }
}

function user(request: RequestWithCurrentUser) {
  if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  return request.user;
}

function requestId(request: RequestWithCurrentUser) {
  if (!request.requestId) throw new ApiError(500, 'INTERNAL_ERROR', 'Missing request id');
  return request.requestId;
}
