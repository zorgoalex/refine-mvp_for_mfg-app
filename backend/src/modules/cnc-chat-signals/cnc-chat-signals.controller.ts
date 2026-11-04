import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Headers, HttpCode, Inject, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiError } from '../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../permissions/current-user';
import { CncTelegramRuntimeConfigService } from '../cnc-telegram/http/cnc-telegram-runtime-config.service';
import { parseWorkerSessionLeaseHeaders } from '../cnc-telegram/dto/cnc-telegram-worker-session.dto';
import { CncChatSignalsService } from './cnc-chat-signals.service';
import {
  parseSawnSignalConfirm, parseSawnSignalListQuery, parseSawnSignalPreview, parseSawnSignalReport,
  parseSawnSignalSettingsUpdate,
  type SawnSignalClaimResponse, type SawnSignalConfirmResult, type SawnSignalListResponse, type SawnSignalPreviewItem,
  type SawnSignalSettingsDto,
} from './cnc-chat-signals.dto';

type HeaderValue = string | string[] | undefined;

@ApiTags('CncChatSignals')
@ApiBearerAuth()
@Controller('cnc-telegram/sawn-signals')
export class CncChatSignalsController {
  constructor(
    @Inject(CncChatSignalsService) private readonly signals: CncChatSignalsService,
    @Inject(CncTelegramRuntimeConfigService) private readonly runtimeConfig: CncTelegramRuntimeConfigService,
  ) {}

  @ApiOperation({ operationId: 'claimCncSawnSignals', summary: 'Claim bot-sent CNC chat messages to re-read their 👍' })
  @Post('worker/claim')
  @HttpCode(200)
  claim(
    @Req() request: RequestWithCurrentUser,
    @Headers('x-cnc-telegram-session-token') token: HeaderValue,
    @Headers('x-cnc-telegram-session-generation') generation: HeaderValue,
    @Headers('x-cnc-telegram-chat-id') sourceChatId: HeaderValue,
    @Headers('x-cnc-telegram-worker-instance') workerInstanceId: HeaderValue,
  ): Promise<SawnSignalClaimResponse> {
    this.assertEnabled();
    return this.signals.claim(this.user(request), this.requestId(request),
      parseWorkerSessionLeaseHeaders(token, generation, sourceChatId, workerInstanceId));
  }

  @ApiOperation({ operationId: 'reportCncSawnSignals', summary: 'Report observed 👍 of the claimed CNC chat messages' })
  @Post('worker/report')
  @HttpCode(200)
  report(
    @Req() request: RequestWithCurrentUser,
    @Headers('x-cnc-telegram-session-token') token: HeaderValue,
    @Headers('x-cnc-telegram-session-generation') generation: HeaderValue,
    @Headers('x-cnc-telegram-chat-id') sourceChatId: HeaderValue,
    @Headers('x-cnc-telegram-worker-instance') workerInstanceId: HeaderValue,
    @Body() body: unknown,
  ): Promise<{ accepted: true; replay: boolean }> {
    this.assertEnabled();
    return this.signals.report({
      currentUser: this.user(request), requestId: this.requestId(request),
      lease: parseWorkerSessionLeaseHeaders(token, generation, sourceChatId, workerInstanceId),
      report: parseSawnSignalReport(body),
    });
  }

  @ApiOperation({ operationId: 'listCncSawnSignals', summary: 'Journal of «Распилено» signals from the CNC chat' })
  @Get()
  list(@Req() request: RequestWithCurrentUser, @Query() query: unknown): Promise<SawnSignalListResponse> {
    this.assertEnabled();
    return this.signals.list(this.user(request), parseSawnSignalListQuery(query));
  }

  @ApiOperation({ operationId: 'getCncSawnSignalSettings', summary: 'Read the «Распилено» by 👍 switch' })
  @Get('settings')
  getSettings(@Req() request: RequestWithCurrentUser): Promise<SawnSignalSettingsDto> {
    this.assertEnabled();
    return this.signals.getSettings(this.user(request));
  }

  @ApiOperation({ operationId: 'updateCncSawnSignalSettings', summary: 'Switch the automatic move to «Распилено» by 👍' })
  @Put('settings')
  @HttpCode(200)
  settings(@Req() request: RequestWithCurrentUser, @Body() body: unknown): Promise<SawnSignalSettingsDto> {
    this.assertEnabled();
    return this.signals.setSettings(this.user(request), parseSawnSignalSettingsUpdate(body), this.requestId(request));
  }

  @ApiOperation({ operationId: 'previewCncSawnSignalsApply', summary: 'Preview applying accumulated «Распилено» signals' })
  @Post('apply-pending/preview')
  @HttpCode(200)
  preview(@Req() request: RequestWithCurrentUser, @Body() body: unknown): Promise<{ items: SawnSignalPreviewItem[] }> {
    this.assertEnabled();
    return this.signals.preview(this.user(request), parseSawnSignalPreview(body), this.requestId(request));
  }

  @ApiOperation({ operationId: 'confirmCncSawnSignalsApply', summary: 'Apply accumulated «Распилено» signals as previewed' })
  @Post('apply-pending/confirm')
  @HttpCode(200)
  confirm(@Req() request: RequestWithCurrentUser, @Body() body: unknown): Promise<{ results: SawnSignalConfirmResult[] }> {
    this.assertEnabled();
    return this.signals.confirm(this.user(request), parseSawnSignalConfirm(body), this.requestId(request));
  }

  private assertEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().cncTelegramEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'CNC Telegram API is disabled', { feature: 'cnc_telegram' });
    }
  }

  private requestId(request: RequestWithCurrentUser): string {
    return request.requestId ?? `cnc-chat-signal:${randomUUID()}`;
  }

  private user(request: RequestWithCurrentUser) {
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    return request.user;
  }
}
