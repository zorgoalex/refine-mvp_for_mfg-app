import { Body, Controller, Get, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { CncTelegramWorkerAuditService } from '../application/cnc-telegram-worker-audit.service';
import {
  parseWorkerAuditExportQuery,
  parseWorkerAuditListQuery,
} from '../dto/cnc-telegram-worker-audit.dto';

@ApiTags('CncTelegramWorkerAudit')
@ApiBearerAuth()
@Controller('cnc-telegram/worker-logs')
export class CncTelegramWorkerAuditController {
  constructor(
    @Inject(CncTelegramWorkerAuditService)
    private readonly audit: CncTelegramWorkerAuditService,
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
  writeBatch(@Req() request: RequestWithCurrentUser, @Body() body: unknown): Promise<{ accepted: number }> {
    return this.audit.writeRawBatch(this.requireCurrentUser(request), body, request.requestId);
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

  private requireCurrentUser(request: RequestWithCurrentUser) {
    if (!request.user) throw new ApiError(401, 'UNAUTHENTICATED', 'Требуется авторизация');
    return request.user;
  }
}
