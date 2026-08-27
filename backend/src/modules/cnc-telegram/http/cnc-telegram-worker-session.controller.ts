import { Body, Controller, Headers, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { ApiError } from '../../../common/errors/api-error';
import { CncTelegramWorkerSessionService } from '../application/cnc-telegram-worker-session.service';
import type { CncTelegramWorkerSessionLeaseResponse } from '../application/cnc-telegram-worker-session.types';
import { parseWorkerSessionHeartbeat, parseWorkerSessionLease, parseWorkerSessionLeaseHeaders } from '../dto/cnc-telegram-worker-session.dto';
import { CncTelegramRuntimeConfigService } from './cnc-telegram-runtime-config.service';

@ApiTags('CncTelegramWorkerSession')
@ApiBearerAuth()
@Controller('cnc-telegram/worker-session')
export class CncTelegramWorkerSessionController {
  constructor(
    @Inject(CncTelegramWorkerSessionService)
    private readonly session: CncTelegramWorkerSessionService,
    @Inject(CncTelegramRuntimeConfigService)
    private readonly runtimeConfig: CncTelegramRuntimeConfigService,
  ) {}

  @ApiOperation({ operationId: 'claimCncTelegramWorkerSession', summary: 'Claim the global Telegram worker session lease' })
  @ApiResponse({ status: 200, description: 'Session lease claimed' })
  @ApiResponse({ status: 409, description: 'Another worker owns a live session lease' })
  @Post('claim')
  @HttpCode(200)
  claim(@Req() request: RequestWithCurrentUser, @Body() body: unknown): Promise<CncTelegramWorkerSessionLeaseResponse> {
    this.assertEnabled();
    return this.session.claim(this.requireCurrentUser(request), parseWorkerSessionLease(body));
  }

  @ApiOperation({ operationId: 'heartbeatCncTelegramWorkerSession', summary: 'Renew the current Telegram worker session lease' })
  @ApiHeader({ name: 'X-CNC-Telegram-Session-Token', required: true })
  @ApiHeader({ name: 'X-CNC-Telegram-Session-Generation', required: true })
  @ApiHeader({ name: 'X-CNC-Telegram-Chat-Id', required: false })
  @ApiHeader({ name: 'X-CNC-Telegram-Worker-Instance', required: true })
  @ApiResponse({ status: 200, description: 'Session lease renewed' })
  @ApiResponse({ status: 409, description: 'Session lease is stale or expired' })
  @Post('heartbeat')
  @HttpCode(200)
  heartbeat(
    @Req() request: RequestWithCurrentUser,
    @Headers('x-cnc-telegram-session-token') token: string | string[] | undefined,
    @Headers('x-cnc-telegram-session-generation') generation: string | string[] | undefined,
    @Headers('x-cnc-telegram-chat-id') sourceChatId: string | string[] | undefined,
    @Headers('x-cnc-telegram-worker-instance') workerInstanceId: string | string[] | undefined,
    @Body() body: unknown,
  ): Promise<CncTelegramWorkerSessionLeaseResponse> {
    this.assertEnabled();
    return this.session.heartbeat(
      this.requireCurrentUser(request),
      parseWorkerSessionHeartbeat(body),
      parseWorkerSessionLeaseHeaders(token, generation, sourceChatId, workerInstanceId),
    );
  }

  @ApiOperation({ operationId: 'releaseCncTelegramWorkerSession', summary: 'Release the current Telegram worker session lease' })
  @ApiHeader({ name: 'X-CNC-Telegram-Session-Token', required: true })
  @ApiHeader({ name: 'X-CNC-Telegram-Session-Generation', required: true })
  @ApiHeader({ name: 'X-CNC-Telegram-Chat-Id', required: false })
  @ApiHeader({ name: 'X-CNC-Telegram-Worker-Instance', required: true })
  @ApiResponse({ status: 200, description: 'Session lease released' })
  @ApiResponse({ status: 409, description: 'Session lease is stale or expired' })
  @Post('release')
  @HttpCode(200)
  async release(
    @Req() request: RequestWithCurrentUser,
    @Headers('x-cnc-telegram-session-token') token: string | string[] | undefined,
    @Headers('x-cnc-telegram-session-generation') generation: string | string[] | undefined,
    @Headers('x-cnc-telegram-chat-id') sourceChatId: string | string[] | undefined,
    @Headers('x-cnc-telegram-worker-instance') workerInstanceId: string | string[] | undefined,
    @Body() body: unknown,
  ): Promise<{ released: true }> {
    this.assertEnabled();
    await this.session.release(
      this.requireCurrentUser(request),
      parseWorkerSessionHeartbeat(body),
      parseWorkerSessionLeaseHeaders(token, generation, sourceChatId, workerInstanceId),
    );
    return { released: true };
  }

  private assertEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().cncTelegramEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'CNC Telegram API is disabled', {
        feature: 'cnc_telegram',
      });
    }
  }

  private requireCurrentUser(request: RequestWithCurrentUser) {
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    return request.user;
  }
}
