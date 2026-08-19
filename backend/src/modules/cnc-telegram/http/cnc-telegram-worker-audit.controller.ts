import { Body, Controller, Get, Headers, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { CncTelegramWorkerAuditService } from '../application/cnc-telegram-worker-audit.service';
import { parseWorkerSessionLeaseHeaders } from '../dto/cnc-telegram-worker-session.dto';
import {
  parseTechnicalLogExportQuery,
  parseTechnicalLogListQuery,
  parseWorkerAuditExportQuery,
  parseWorkerAuditListQuery,
} from '../dto/cnc-telegram-worker-audit.dto';
import { CncTelegramRuntimeConfigService } from './cnc-telegram-runtime-config.service';

@ApiTags('CncTelegramWorkerAudit')
@ApiBearerAuth()
@Controller('cnc-telegram/worker-logs')
export class CncTelegramWorkerAuditController {
  constructor(
    @Inject(CncTelegramWorkerAuditService)
    private readonly audit: CncTelegramWorkerAuditService,
    @Inject(CncTelegramRuntimeConfigService)
    private readonly runtimeConfig: CncTelegramRuntimeConfigService,
  ) {}

  @ApiOperation({ operationId: 'getCncTelegramWorkerAuditCapabilities', summary: 'Verify complete worker-audit storage capability' })
  @ApiResponse({ status: 200, description: 'Worker audit capability is ready' })
  @ApiResponse({ status: 503, description: 'Migration or writer policy is incomplete' })
  @Get('capabilities')
  capabilities(@Req() request: RequestWithCurrentUser): Promise<{ capability: string }> {
    return this.audit.capabilities(this.requireCurrentUser(request), request.requestId);
  }

  @ApiOperation({ operationId: 'writeCncTelegramWorkerAuditBatch', summary: 'Persist one durable worker audit batch' })
  @ApiResponse({ status: 201, description: 'Audit batch persisted atomically' })
  @ApiResponse({ status: 422, description: 'Invalid bounded audit payload' })
  @Post('batch')
  async writeBatch(
    @Req() request: RequestWithCurrentUser,
    @Headers('x-cnc-telegram-session-token') token: string | string[] | undefined,
    @Headers('x-cnc-telegram-session-generation') generation: string | string[] | undefined,
    @Headers('x-cnc-telegram-chat-id') sourceChatId: string | string[] | undefined,
    @Headers('x-cnc-telegram-worker-instance') workerInstanceId: string | string[] | undefined,
    @Body() body: unknown,
  ): Promise<{ accepted: number }> {
    this.assertEnabled();
    const lease = parseWorkerSessionLeaseHeaders(token, generation, sourceChatId, workerInstanceId);
    return this.audit.writeRawBatch(this.requireCurrentUser(request), body, request.requestId, lease);
  }

  @ApiOperation({ operationId: 'writeCncTelegramWorkerTechnicalLogBatch', summary: 'Persist raw stdout/stderr worker lines' })
  @ApiResponse({ status: 201, description: 'Technical log lines persisted idempotently' })
  @Post('technical/batch')
  async writeTechnicalBatch(
    @Req() request: RequestWithCurrentUser,
    @Headers('x-cnc-telegram-session-token') token: string | string[] | undefined,
    @Headers('x-cnc-telegram-session-generation') generation: string | string[] | undefined,
    @Headers('x-cnc-telegram-chat-id') sourceChatId: string | string[] | undefined,
    @Headers('x-cnc-telegram-worker-instance') workerInstanceId: string | string[] | undefined,
    @Body() body: unknown,
  ): Promise<{ accepted: number }> {
    this.assertEnabled();
    const lease = parseWorkerSessionLeaseHeaders(token, generation, sourceChatId, workerInstanceId);
    return this.audit.writeTechnicalRawBatch(this.requireCurrentUser(request), body, request.requestId, lease);
  }

  @ApiOperation({ operationId: 'exportCncTelegramWorkerTechnicalLogs', summary: 'Export raw worker technical logs' })
  @ApiProduces('text/plain')
  @Get('technical/export')
  async exportTechnical(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.audit.exportTechnical(
      this.requireCurrentUser(request),
      parseTechnicalLogExportQuery(query),
    );
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    response.setHeader('Cache-Control', 'private, no-store');
    response.send(file.content);
  }

  @ApiOperation({ operationId: 'listCncTelegramWorkerTechnicalLogs', summary: 'List raw stdout/stderr worker lines' })
  @Get('technical')
  listTechnical(@Req() request: RequestWithCurrentUser, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.audit.listTechnical(this.requireCurrentUser(request), parseTechnicalLogListQuery(query));
  }

  @ApiOperation({ operationId: 'exportCncTelegramWorkerAudit', summary: 'Export full Telegram worker audit evidence as JSON' })
  @ApiProduces('application/json')
  @ApiResponse({ status: 200, description: 'Detailed JSON audit export', schema: { type: 'string', format: 'binary' } })
  @ApiResponse({ status: 413, description: 'Selected period contains too many audit rows' })
  @ApiResponse({ status: 422, description: 'Invalid export filters or date range' })
  @Get('export')
  async exportDetailed(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.audit.exportDetailed(
      this.requireCurrentUser(request),
      parseWorkerAuditExportQuery(query),
    );
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    response.setHeader('Cache-Control', 'private, no-store');
    response.send(file.content);
  }

  @ApiOperation({ operationId: 'listCncTelegramWorkerAudit', summary: 'List readable Telegram worker evidence' })
  @ApiResponse({ status: 200, description: 'Paginated messages, scans, observations and operations' })
  @Get()
  list(@Req() request: RequestWithCurrentUser, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.audit.list(this.requireCurrentUser(request), parseWorkerAuditListQuery(query));
  }

  private assertEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().cncTelegramEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'CNC Telegram API is disabled', {
        feature: 'cnc_telegram',
      });
    }
  }

  private requireCurrentUser(request: RequestWithCurrentUser) {
    if (!request.user) throw new ApiError(401, 'UNAUTHENTICATED', 'Требуется авторизация');
    return request.user;
  }
}
