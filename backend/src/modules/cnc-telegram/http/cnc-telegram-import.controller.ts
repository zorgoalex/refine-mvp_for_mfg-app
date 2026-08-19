import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { CncTelegramImportService } from '../application/cnc-telegram-import.service';
import { parseImportCandidateBatch, parseImportComplete, parseImportConfirm, parseImportFailure, parseImportPrepare, parseImportScanCreate, parseImportScanFailure, parseImportScanComplete, parseImportListQuery } from '../dto/cnc-telegram-import.dto';
import { parseWorkerSessionLeaseHeaders } from '../dto/cnc-telegram-worker-session.dto';
import type { CncTelegramWorkerSessionLeaseContext } from '../application/cnc-telegram-worker-session.types';
import { CncTelegramRuntimeConfigService } from './cnc-telegram-runtime-config.service';

@ApiTags('CncTelegramImport')
@ApiBearerAuth()
@Controller('cnc-telegram')
export class CncTelegramImportController {
  constructor(@Inject(CncTelegramImportService) private readonly imports: CncTelegramImportService, @Inject(CncTelegramRuntimeConfigService) private readonly runtime: CncTelegramRuntimeConfigService) {}
  @ApiOperation({ operationId: 'createCncTelegramImportScan', summary: 'Queue an explicit bounded Telegram history scan' })
  @Post('import-scans') @HttpCode(202) create(@Req() req: RequestWithCurrentUser, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown) { this.enabled(); return this.imports.createScan({ currentUser: this.user(req), ...parseImportScanCreate(body), idempotencyKey: requiredHeader(key, 'Idempotency-Key'), requestId: req.requestId }); }
  @ApiOperation({ operationId: 'getCncTelegramImportScan', summary: 'Get explicit Telegram scan progress' })
  @Get('import-scans/:scanId') getScan(@Req() req: RequestWithCurrentUser, @Param('scanId') scanId: string) { this.enabled(); return this.imports.getScan(this.user(req), scanId); }
  @ApiOperation({ operationId: 'listCncTelegramImportCandidates', summary: 'List candidates discovered by an explicit scan' })
  @Get('import-scans/:scanId/candidates') candidates(@Req() req: RequestWithCurrentUser, @Param('scanId') scanId: string, @Query() query: Record<string, unknown>) { this.enabled(); const p = parseImportListQuery(query); return this.imports.listCandidates({ currentUser: this.user(req), scanId, ...p }); }
  @ApiOperation({ operationId: 'prepareCncTelegramImport', summary: 'Prepare an explicit candidate selection' })
  @Post('import-scans/:scanId/imports/prepare') prepare(@Req() req: RequestWithCurrentUser, @Param('scanId') scanId: string, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown) { this.enabled(); return this.imports.prepare({ currentUser: this.user(req), scanId, ...parseImportPrepare(body), idempotencyKey: requiredHeader(key, 'Idempotency-Key'), requestId: req.requestId }); }
  @ApiOperation({ operationId: 'confirmCncTelegramImport', summary: 'Confirm creation, including acknowledged duplicates' })
  @Post('imports/:importRequestId/confirm') @HttpCode(202) confirm(@Req() req: RequestWithCurrentUser, @Param('importRequestId') importRequestId: string, @Body() body: unknown) { this.enabled(); return this.imports.confirm({ currentUser: this.user(req), importRequestId, ...parseImportConfirm(body), requestId: req.requestId }); }
  @ApiOperation({ operationId: 'prepareRepeatedCncTelegramImport', summary: 'Prepare an intentional repeat of a terminal import' })
  @Post('imports/:importRequestId/repeat/prepare') repeat(@Req() req: RequestWithCurrentUser, @Param('importRequestId') importRequestId: string, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown) { this.enabled(); const parsed = parseImportPrepare(body); return this.imports.repeatPrepare({ currentUser: this.user(req), importRequestId, candidateIds: parsed.candidateIds, idempotencyKey: requiredHeader(key, 'Idempotency-Key'), requestId: req.requestId }); }
  @ApiOperation({ operationId: 'getCncTelegramImport', summary: 'Get explicit import progress and results' })
  @Get('imports/:importRequestId') getImport(@Req() req: RequestWithCurrentUser, @Param('importRequestId') importRequestId: string) { this.enabled(); return this.imports.getImport(this.user(req), importRequestId); }

  @ApiOperation({ operationId: 'claimCncTelegramImportScans', summary: 'Claim one fenced explicit scan task' })
  @Post('import-worker/scans/claim') claimScans(@Req() req: RequestWithCurrentUser, @Headers() h: Record<string, string | string[] | undefined>) { this.enabled(); return this.imports.claimScans(this.user(req), lease(h)).then((tasks) => ({ tasks })); }
  @ApiOperation({ operationId: 'writeCncTelegramImportCandidates', summary: 'Persist a fenced bounded discovery batch' })
  @Post('import-worker/scans/:scanId/candidates/batch') batch(@Req() req: RequestWithCurrentUser, @Param('scanId') scanId: string, @Headers() h: Record<string, string | string[] | undefined>, @Body() body: unknown) { this.enabled(); return this.imports.writeCandidateBatch({ currentUser: this.user(req), scanId, lease: lease(h), batch: parseImportCandidateBatch(body), requestId: req.requestId }); }
  @ApiOperation({ operationId: 'completeCncTelegramImportScan', summary: 'Complete a fenced explicit scan task' })
  @Post('import-worker/scans/:scanId/complete') @HttpCode(200) completeScan(@Req() req: RequestWithCurrentUser, @Param('scanId') scanId: string, @Headers() h: Record<string, string | string[] | undefined>, @Body() body: unknown) { this.enabled(); return this.imports.completeScan({ currentUser: this.user(req), scanId, lease: lease(h), scanTaskLease: parseImportScanComplete(body), requestId: req.requestId }); }
  @ApiOperation({ operationId: 'failCncTelegramImportScan', summary: 'Fail a fenced explicit scan task' })
  @Post('import-worker/scans/:scanId/fail') failScan(@Req() req: RequestWithCurrentUser, @Param('scanId') scanId: string, @Headers() h: Record<string, string | string[] | undefined>, @Body() body: unknown) { this.enabled(); return this.imports.failScan({ currentUser: this.user(req), scanId, lease: lease(h), failure: parseImportScanFailure(body), requestId: req.requestId }); }
  @ApiOperation({ operationId: 'claimCncTelegramImportItems', summary: 'Claim one fenced explicit import item' })
  @Post('import-worker/imports/claim') claimImports(@Req() req: RequestWithCurrentUser, @Headers() h: Record<string, string | string[] | undefined>) { this.enabled(); return this.imports.claimImports(this.user(req), lease(h)).then((tasks) => ({ tasks })); }
  @ApiOperation({ operationId: 'completeCncTelegramImportItem', summary: 'Atomically persist one verified explicit import' })
  @Post('import-worker/imports/:itemId/complete') completeImport(@Req() req: RequestWithCurrentUser, @Param('itemId') importItemId: string, @Headers() h: Record<string, string | string[] | undefined>, @Body() body: unknown) { this.enabled(); return this.imports.completeImport({ currentUser: this.user(req), importItemId, lease: lease(h), completion: parseImportComplete(body), requestId: req.requestId }); }
  @ApiOperation({ operationId: 'failCncTelegramImportItem', summary: 'Fail one fenced explicit import item' })
  @Post('import-worker/imports/:itemId/fail') failImport(@Req() req: RequestWithCurrentUser, @Param('itemId') importItemId: string, @Headers() h: Record<string, string | string[] | undefined>, @Body() body: unknown) { this.enabled(); return this.imports.failImport({ currentUser: this.user(req), importItemId, lease: lease(h), failure: parseImportFailure(body), requestId: req.requestId }); }
  private enabled() { if (!this.runtime.getFeatureFlags().cncTelegramEnabled) throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'CNC Telegram API is disabled', { feature: 'cnc_telegram' }); }
  private user(req: RequestWithCurrentUser) { if (!req.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required'); return req.user; }
}
function requiredHeader(value: string | undefined, name: string): string { if (!value?.trim()) throw new ApiError(422, 'VALIDATION_ERROR', `${name} is required`); return value.trim(); }
function lease(h: Record<string, string | string[] | undefined>): CncTelegramWorkerSessionLeaseContext { return parseWorkerSessionLeaseHeaders(h['x-cnc-telegram-session-token'], h['x-cnc-telegram-session-generation'], h['x-cnc-telegram-chat-id'], h['x-cnc-telegram-worker-instance']); }
