import { Body, Controller, Get, Inject, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { CncTelegramWorkerAuditService } from '../application/cnc-telegram-worker-audit.service';
import { parseWorkerAuditListQuery } from '../dto/cnc-telegram-worker-audit.dto';

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
