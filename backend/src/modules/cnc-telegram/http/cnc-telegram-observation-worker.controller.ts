import { randomUUID } from 'node:crypto';
import { Body, Controller, Headers, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { ApiError } from '../../../common/errors/api-error';
import type { CncTelegramWorkerSessionLeaseContext } from '../application/cnc-telegram-worker-session.types';
import { CncTelegramMdfObservationService } from '../application/mdf-cnc-observations.service';
import {
  parseMdfCncObservationClaimId,
  parseMdfCncObservationFailure,
  parseMdfCncObservationReport,
} from '../dto/mdf-cnc-observations.dto';
import { parseWorkerSessionLeaseHeaders } from '../dto/cnc-telegram-worker-session.dto';
import { CncTelegramRuntimeConfigService } from './cnc-telegram-runtime-config.service';

@ApiTags('CncTelegramObservationWorker')
@ApiBearerAuth()
@Controller('cnc-telegram/observation-worker')
export class CncTelegramObservationWorkerController {
  constructor(
    @Inject(CncTelegramMdfObservationService)
    private readonly observations: CncTelegramMdfObservationService,
    @Inject(CncTelegramRuntimeConfigService)
    private readonly runtimeConfig: CncTelegramRuntimeConfigService,
  ) {}

  @ApiOperation({ operationId: 'claimCncTelegramMdfObservation', summary: 'Claim one server-selected CNC source for a bounded fresh observation' })
  @ApiHeader({ name: 'X-CNC-Telegram-Session-Token', required: true })
  @ApiHeader({ name: 'X-CNC-Telegram-Session-Generation', required: true })
  @ApiHeader({ name: 'X-CNC-Telegram-Chat-Id', required: false })
  @ApiHeader({ name: 'X-CNC-Telegram-Worker-Instance', required: true })
  @ApiResponse({ status: 200, description: 'Claim or no currently eligible source' })
  @ApiResponse({ status: 403, description: 'Worker permission, identity, or chat denied' })
  @ApiResponse({ status: 409, description: 'Worker session lease is stale' })
  @ApiResponse({ status: 503, description: 'CNC Telegram API is disabled' })
  @Post('claim')
  @HttpCode(200)
  claim(
    @Req() request: RequestWithCurrentUser,
    @Headers('x-cnc-telegram-session-token') token: string | string[] | undefined,
    @Headers('x-cnc-telegram-session-generation') generation: string | string[] | undefined,
    @Headers('x-cnc-telegram-chat-id') sourceChatId: string | string[] | undefined,
    @Headers('x-cnc-telegram-worker-instance') workerInstanceId: string | string[] | undefined,
  ) {
    this.assertEnabled();
    return this.observations.claim(this.user(request), this.lease(token, generation, sourceChatId, workerInstanceId));
  }

  @ApiOperation({ operationId: 'completeCncTelegramMdfObservation', summary: 'Report a post-claim fetch of the exact registered CNC message group' })
  @ApiHeader({ name: 'X-CNC-Telegram-Session-Token', required: true })
  @ApiHeader({ name: 'X-CNC-Telegram-Session-Generation', required: true })
  @ApiHeader({ name: 'X-CNC-Telegram-Chat-Id', required: false })
  @ApiHeader({ name: 'X-CNC-Telegram-Worker-Instance', required: true })
  @ApiResponse({ status: 200, description: 'Immutable observation accepted or exact replay' })
  @ApiResponse({ status: 403, description: 'Worker permission, identity, or chat denied' })
  @ApiResponse({ status: 409, description: 'Claim, source head, or worker lease is stale' })
  @ApiResponse({ status: 422, description: 'Malformed or incomplete fetched group' })
  @ApiResponse({ status: 503, description: 'CNC Telegram API is disabled' })
  @Post('claims/:claimId/complete')
  @HttpCode(200)
  complete(
    @Req() request: RequestWithCurrentUser,
    @Param('claimId') claimIdValue: string,
    @Headers('x-cnc-telegram-session-token') token: string | string[] | undefined,
    @Headers('x-cnc-telegram-session-generation') generation: string | string[] | undefined,
    @Headers('x-cnc-telegram-chat-id') sourceChatId: string | string[] | undefined,
    @Headers('x-cnc-telegram-worker-instance') workerInstanceId: string | string[] | undefined,
    @Body() body: unknown,
  ) {
    this.assertEnabled();
    const claimId = parseMdfCncObservationClaimId(claimIdValue);
    const report = parseMdfCncObservationReport(body);
    if (report.claimId !== claimId) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Observation claim id does not match route');
    }
    return this.observations.complete({
      currentUser: this.user(request),
      lease: this.lease(token, generation, sourceChatId, workerInstanceId),
      report,
      requestId: request.requestId ?? randomUUID(),
    });
  }

  @ApiOperation({ operationId: 'failCncTelegramMdfObservation', summary: 'Fail a bounded observation after fetch or media validation failure' })
  @ApiHeader({ name: 'X-CNC-Telegram-Session-Token', required: true })
  @ApiHeader({ name: 'X-CNC-Telegram-Session-Generation', required: true })
  @ApiHeader({ name: 'X-CNC-Telegram-Chat-Id', required: false })
  @ApiHeader({ name: 'X-CNC-Telegram-Worker-Instance', required: true })
  @ApiResponse({ status: 200, description: 'Claim failure accepted' })
  @ApiResponse({ status: 403, description: 'Worker permission, identity, or chat denied' })
  @ApiResponse({ status: 409, description: 'Claim or worker lease is stale' })
  @ApiResponse({ status: 422, description: 'Malformed failure report' })
  @ApiResponse({ status: 503, description: 'CNC Telegram API is disabled' })
  @Post('claims/:claimId/fail')
  @HttpCode(200)
  fail(
    @Req() request: RequestWithCurrentUser,
    @Param('claimId') claimIdValue: string,
    @Headers('x-cnc-telegram-session-token') token: string | string[] | undefined,
    @Headers('x-cnc-telegram-session-generation') generation: string | string[] | undefined,
    @Headers('x-cnc-telegram-chat-id') sourceChatId: string | string[] | undefined,
    @Headers('x-cnc-telegram-worker-instance') workerInstanceId: string | string[] | undefined,
    @Body() body: unknown,
  ) {
    this.assertEnabled();
    const claimId = parseMdfCncObservationClaimId(claimIdValue);
    const failure = parseMdfCncObservationFailure(body);
    return this.observations.fail({
      currentUser: this.user(request),
      lease: this.lease(token, generation, sourceChatId, workerInstanceId),
      claimId,
      ...failure,
      requestId: request.requestId ?? randomUUID(),
    });
  }

  private assertEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().cncTelegramEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'CNC Telegram API is disabled', { feature: 'cnc_telegram' });
    }
  }

  private user(request: RequestWithCurrentUser) {
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    return request.user;
  }

  private lease(
    token: string | string[] | undefined,
    generation: string | string[] | undefined,
    sourceChatId: string | string[] | undefined,
    workerInstanceId: string | string[] | undefined,
  ): CncTelegramWorkerSessionLeaseContext {
    return parseWorkerSessionLeaseHeaders(token, generation, sourceChatId, workerInstanceId);
  }
}
