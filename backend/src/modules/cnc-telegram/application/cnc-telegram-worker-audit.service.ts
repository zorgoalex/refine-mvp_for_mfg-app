import { ConfigService } from '@nestjs/config';
import { ApiError } from '../../../common/errors/api-error';
import type { BackendEnv } from '../../../config/env.validation';
import type { CurrentUser } from '../../../permissions/current-user';
import { PermissionsService } from '../../../permissions/permissions.service';
import { PgCncTelegramWorkerAuditRepository } from '../adapters/pg-cnc-telegram-worker-audit-repository';
import type { CncTelegramDeniedAuditPort } from './cnc-telegram.types';
import type { CncTelegramWorkerSessionLeaseContext } from './cnc-telegram-worker-session.types';
import type { CncTelegramWorkerSessionService } from './cnc-telegram-worker-session.service';
import {
  parseTechnicalLogBatch,
  parseWorkerAuditBatch,
  type TechnicalLogBatchDto,
  type TechnicalLogExportQueryDto,
  type TechnicalLogQueryDto,
  type WorkerAuditBatchDto,
  type WorkerAuditExportQueryDto,
  type WorkerAuditListQueryDto,
} from '../dto/cnc-telegram-worker-audit.dto';

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\bAuthorization\s*:\s*[^\r\n]+/gi, 'Authorization: [REDACTED]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[JWT_REDACTED]'],
  [/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, '[BOT_TOKEN_REDACTED]'],
  [/\b(password|secret|api[_-]?hash|token|cookie)\b["']?\s*[:=]\s*["']?[^\s"',;}]+/gi, '$1=[REDACTED]'],
  [/(?:https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, 'https://[CREDENTIALS_REDACTED]@'],
  [/\/data\/session\/[A-Za-z0-9._/-]+/gi, '/data/session/[REDACTED]'],
  [/(?<!\d)\+?\d[\d ()-]{8,17}\d(?!\d)/g, '[PHONE_REDACTED]'],
];

const TECHNICAL_SECRET_PATTERNS: readonly [string, RegExp, string][] = [
  ['authorization', /\bAuthorization\s*:\s*[^\r\n]+/gi, 'Authorization: [REDACTED]'],
  ['authorization', /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],
  ['jwt', /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[JWT_REDACTED]'],
  ['bot_token', /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, '[BOT_TOKEN_REDACTED]'],
  ['credential', /\b(password|secret|api[_-]?hash|token|cookie)\b["']?\s*[:=]\s*["']?[^\s"',;}]+/gi, '$1=[REDACTED]'],
  ['url_userinfo', /(?:https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, 'https://[CREDENTIALS_REDACTED]@'],
  ['session_path', /\/data\/session\/[A-Za-z0-9._/-]+/gi, '/data/session/[REDACTED]'],
  ['phone', /(?<!\d)\+?\d[\d ()-]{8,17}\d(?!\d)/g, '[PHONE_REDACTED]'],
];
const TECHNICAL_FORBIDDEN_PATTERN = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\b\d{6,12}:[A-Za-z0-9_-]{20,})\b/i;

export class CncTelegramWorkerAuditService {
  private readonly permissions = new PermissionsService();

  constructor(
    private readonly repository: PgCncTelegramWorkerAuditRepository,
    private readonly config: ConfigService<BackendEnv, true>,
    private readonly deniedAudit?: CncTelegramDeniedAuditPort,
    private readonly session?: CncTelegramWorkerSessionService,
  ) {}

  async capabilities(currentUser: CurrentUser, requestId?: string): Promise<{ capability: string }> {
    await this.assertWriter(currentUser, requestId);
    if (!await this.repository.capabilities()) {
      throw new ApiError(503, 'CNC_TELEGRAM_WORKER_AUDIT_UNAVAILABLE', 'Схема журнала Telegram-бота не готова');
    }
    return { capability: 'cnc_telegram_worker_audit_v1' };
  }

  async writeBatch(currentUser: CurrentUser, dto: WorkerAuditBatchDto, requestId?: string, lease?: CncTelegramWorkerSessionLeaseContext): Promise<{ accepted: number }> {
    await this.assertWriter(currentUser, requestId);
    const currentLease = await this.normalizeAndAssertSession(currentUser, lease);
    await this.assertChats(currentUser, dto, requestId, currentLease);
    return this.writeAuthorizedBatch(currentUser, dto, currentLease);
  }

  async writeRawBatch(currentUser: CurrentUser, raw: unknown, requestId?: string, lease?: CncTelegramWorkerSessionLeaseContext): Promise<{ accepted: number }> {
    await this.assertWriter(currentUser, requestId);
    const currentLease = await this.normalizeAndAssertSession(currentUser, lease);
    await this.assertRawChats(currentUser, raw, requestId, currentLease);
    const dto = parseWorkerAuditBatch(raw);
    await this.assertChats(currentUser, dto, requestId, currentLease);
    return this.writeAuthorizedBatch(currentUser, dto, currentLease);
  }

  private async writeAuthorizedBatch(currentUser: CurrentUser, dto: WorkerAuditBatchDto, lease?: CncTelegramWorkerSessionLeaseContext): Promise<{ accepted: number }> {
    this.assertBatchReferences(dto);
    if (!await this.repository.capabilities()) {
      throw new ApiError(503, 'CNC_TELEGRAM_WORKER_AUDIT_UNAVAILABLE', 'Схема журнала Telegram-бота не готова');
    }
    if (!lease) throw new ApiError(401, 'CNC_TELEGRAM_SESSION_LEASE_REQUIRED', 'Требуется текущая сессия Telegram worker');
    return this.repository.writeBatch(sanitizeWorkerAuditBatch(dto), { id: currentUser.id }, lease);
  }

  list(currentUser: CurrentUser, query: WorkerAuditListQueryDto): Promise<Record<string, unknown>> {
    this.assertViewer(currentUser);
    return this.repository.list(query);
  }

  technicalHealth(currentUser: CurrentUser): Promise<{
    latestLineAt: string | null;
    latestHeartbeatAt: string | null;
    droppedLines: number;
  }> {
    this.assertHealthViewer(currentUser);
    return this.repository.technicalHealth();
  }

  async exportDetailed(
    currentUser: CurrentUser,
    query: WorkerAuditExportQueryDto,
  ): Promise<{ fileName: string; content: string }> {
    this.assertViewer(currentUser);
    const data = await this.repository.exportDetailed(query);
    const operations = data.messages.flatMap((message) => arrayField(message, 'operations'));
    const exportedAt = new Date();
    const backendBuildSha = this.config.get('BACKEND_BUILD_SHA', { infer: true }) ?? null;
    const runtimeSessions = (data.runtimeSessions ?? []).map((session) => ({
      ...session,
      runtimeEvidenceComplete: hasCompleteRuntimeEvidence(session),
      revisionMatchesBackend: backendBuildSha
        ? stringField(session, 'workerImageRevision') === backendBuildSha
        : null,
    }));
    const manualSvgTelegramSends = (data.manualSvgTelegramSends ?? []).map((request) => (
      enrichManualSvgTelegramSend(request, runtimeSessions, exportedAt)
    ));
    const findings = manualSendFindings(manualSvgTelegramSends);
    const payload = {
      format: 'erp.cnc-telegram-worker-audit',
      schemaVersion: 2,
      detailLevel: 'full',
      exportedAt: exportedAt.toISOString(),
      exportedBy: {
        userId: currentUser.id,
        username: currentUser.username,
        role: currentUser.role,
      },
      period: {
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        messageDateField: 'sourceCreatedAt',
        messageTimezone: 'Asia/Almaty',
        scanDateField: 'workday',
        inclusive: true,
      },
      filters: {
        status: query.status ?? null,
        messageType: query.messageType ?? null,
        reasonCode: query.reasonCode ?? null,
        search: query.search ?? null,
      },
      totals: {
        scans: data.scans.length,
        messages: data.messages.length,
        observations: data.messages.reduce(
          (total, message) => total + arrayField(message, 'observations').length,
          0,
        ),
        operations: operations.length,
        steps: operations.reduce((total, operation) => total + arrayField(operation, 'steps').length, 0),
        responses: operations.reduce((total, operation) => total + arrayField(operation, 'responses').length, 0),
        runtimeSessions: runtimeSessions.length,
        manualSvgTelegramSends: manualSvgTelegramSends.length,
        activeManualSvgTelegramSends: manualSvgTelegramSends.filter((request) => (
          request.status === 'pending' || request.status === 'processing'
        )).length,
      },
      includes: [
        'all_stored_scan_fields',
        'all_stored_message_fields',
        'all_stored_observation_fields',
        'all_stored_operation_fields',
        'operation_steps',
        'operation_responses',
        'current_worker_runtime_snapshot',
        'manual_svg_telegram_send_queue',
        'manual_svg_telegram_send_lifecycle',
        'manual_svg_telegram_send_eligibility',
      ],
      runtimeSnapshot: {
        backendBuildSha,
        sessions: runtimeSessions,
      },
      findings,
      manualSvgTelegramSends,
      scans: data.scans,
      messages: data.messages,
    };
    return {
      fileName: `telegram-worker-audit_${query.dateFrom}_${query.dateTo}.json`,
      content: `${JSON.stringify(payload, null, 2)}\n`,
    };
  }

  async writeTechnicalRawBatch(currentUser: CurrentUser, raw: unknown, requestId?: string, lease?: CncTelegramWorkerSessionLeaseContext): Promise<{ accepted: number }> {
    await this.assertWriter(currentUser, requestId);
    const currentLease = await this.normalizeAndAssertSession(currentUser, lease);
    const dto = sanitizeTechnicalLogBatch(parseTechnicalLogBatch(raw));
    if (!await this.repository.technicalCapabilities()) {
      throw new ApiError(503, 'CNC_TELEGRAM_TECHNICAL_LOGS_UNAVAILABLE', 'Схема технических логов worker не готова');
    }
    if (!currentLease) throw new ApiError(401, 'CNC_TELEGRAM_SESSION_LEASE_REQUIRED', 'Требуется текущая сессия Telegram worker');
    return this.repository.writeTechnicalBatch(dto, { id: currentUser.id }, currentLease);
  }

  listTechnical(currentUser: CurrentUser, query: TechnicalLogQueryDto): Promise<Record<string, unknown>> {
    this.assertTechnicalViewer(currentUser);
    return this.repository.listTechnical(query);
  }

  async exportTechnical(
    currentUser: CurrentUser,
    query: TechnicalLogExportQueryDto,
  ): Promise<{ fileName: string; content: string }> {
    this.assertTechnicalViewer(currentUser);
    const lines = await this.repository.exportTechnical(query);
    const header = `# CNC Telegram worker raw technical logs\n# exportedAt=${new Date().toISOString()} exportedBy=${currentUser.username}\n`;
    return {
      fileName: `telegram-worker-technical_${query.dateFrom}_${query.dateTo}.log`,
      content: `${header}${lines.map(formatTechnicalExportLine).join('\n')}\n`,
    };
  }

  private assertViewer(currentUser: CurrentUser): void {
    if (!this.permissions.canUser(currentUser, 'audit.view')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для журнала Telegram-бота', {
        requiredPermissions: ['audit.view'],
      });
    }
  }

  private assertTechnicalViewer(currentUser: CurrentUser): void {
    if (!this.permissions.canUser(currentUser, 'audit.technical.view')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для технических логов worker', {
        requiredPermissions: ['audit.technical.view'],
      });
    }
  }

  private assertHealthViewer(currentUser: CurrentUser): void {
    if (
      !this.permissions.canUser(currentUser, 'cut.manage')
      || !this.permissions.canUser(currentUser, 'org.view')
    ) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для статуса Telegram Worker', {
        requiredPermissions: ['cut.manage', 'org.view'],
      });
    }
  }

  private async assertWriter(currentUser: CurrentUser, requestId?: string): Promise<void> {
    const configuredUsername = this.config.get('CNC_TELEGRAM_WORKER_USERNAME', { infer: true });
    const allowedChats = this.allowedChats();
    if (!configuredUsername || allowedChats.size === 0) {
      throw new ApiError(503, 'CNC_TELEGRAM_WORKER_POLICY_UNCONFIGURED', 'Политика worker-аудита не настроена');
    }
    if (!this.permissions.canUser(currentUser, 'cut.manage') || currentUser.username !== configuredUsername) {
      await this.recordDenied(currentUser, requestId, 'PERMISSION_DENIED');
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для записи журнала Telegram-бота', {
        requiredPermissions: ['cut.manage'],
      });
    }
  }

  private async normalizeAndAssertSession(
    currentUser: CurrentUser,
    lease: CncTelegramWorkerSessionLeaseContext | undefined,
  ): Promise<CncTelegramWorkerSessionLeaseContext | undefined> {
    // The module injects a verifier for every HTTP instance. The optional
    // dependency preserves the small application-service unit-test contract.
    if (!this.session) return lease;
    if (!lease) {
      throw new ApiError(401, 'CNC_TELEGRAM_SESSION_LEASE_REQUIRED', 'Требуется текущая сессия Telegram worker');
    }
    const currentLease = { ...lease, sourceChatId: this.session.resolveChatId(lease.sourceChatId) };
    await this.session.assertCurrent(currentUser, currentLease);
    return currentLease;
  }

  private async assertChats(currentUser: CurrentUser, dto: WorkerAuditBatchDto, requestId?: string, lease?: CncTelegramWorkerSessionLeaseContext): Promise<void> {
    const allowed = this.allowedChats();
    const supplied = new Set([dto.scan.sourceChatId, ...dto.messages.map((message) => message.sourceChatId), ...dto.observations.map((observation) => observation.sourceChatId)]);
    for (const chatId of supplied) {
      if (!allowed.has(chatId) || (lease && chatId !== this.resolvedLeaseChat(lease))) {
        await this.recordDenied(currentUser, requestId, 'CNC_TELEGRAM_CHAT_DENIED');
        throw new ApiError(403, 'CNC_TELEGRAM_CHAT_DENIED', 'Telegram-чат не разрешён политикой worker-аудита');
      }
    }
  }

  private async assertRawChats(currentUser: CurrentUser, raw: unknown, requestId?: string, lease?: CncTelegramWorkerSessionLeaseContext): Promise<void> {
    if (!isRecord(raw)) return;
    const supplied = new Set<string>();
    const scan = raw.scan;
    if (isRecord(scan)) addRawChatCandidate(supplied, scan.sourceChatId);
    for (const field of ['messages', 'observations'] as const) {
      const values = raw[field];
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        if (isRecord(value)) addRawChatCandidate(supplied, value.sourceChatId);
      }
    }
    const allowed = this.allowedChats();
    if ([...supplied].some((chatId) => !allowed.has(chatId) || (lease && chatId !== this.resolvedLeaseChat(lease)))) {
      await this.recordDenied(currentUser, requestId, 'CNC_TELEGRAM_CHAT_DENIED');
      throw new ApiError(403, 'CNC_TELEGRAM_CHAT_DENIED', 'Telegram-чат не разрешён политикой worker-аудита');
    }
  }

  private resolvedLeaseChat(lease: CncTelegramWorkerSessionLeaseContext): string {
    return this.session?.resolveChatId(lease.sourceChatId) ?? lease.sourceChatId;
  }

  private assertBatchReferences(dto: WorkerAuditBatchDto): void {
    const messages = new Map(dto.messages.map((message) => [message.logKey, message]));
    const operations = new Map(dto.operations.map((operation) => [operation.operationKey, operation]));
    if (dto.operations.some((operation) => operation.scanId !== dto.scan.scanId || !messages.has(operation.logKey))) {
      throw new ApiError(422, 'CNC_TELEGRAM_AUDIT_REFERENCE_DENIED', 'Операция должна ссылаться на сообщение и скан этого же пакета');
    }
    if (dto.observations.some((observation) => {
      const message = messages.get(observation.logKey);
      const operation = observation.operationKey ? operations.get(observation.operationKey) : undefined;
      return observation.scanId !== dto.scan.scanId
        || !message
        || message.sourceChatId !== observation.sourceChatId
        || message.sourceMessageId !== observation.sourceMessageId
        || (observation.operationKey ? !operation || operation.logKey !== observation.logKey : false);
    })) {
      throw new ApiError(422, 'CNC_TELEGRAM_AUDIT_REFERENCE_DENIED', 'Наблюдение должно ссылаться на сообщение и операцию этого же пакета');
    }
  }

  private async recordDenied(
    currentUser: CurrentUser,
    requestId: string | undefined,
    reason: 'PERMISSION_DENIED' | 'CNC_TELEGRAM_CHAT_DENIED',
  ): Promise<void> {
    try {
      await this.deniedAudit?.recordWorkerAuditWriteDenied?.({
        currentUser,
        event: 'cnc.telegram_worker.audit_write_denied',
        requestId,
        reason,
        requiredPermissions: ['cut.manage'],
      });
    } catch {
      // Deny response must not depend on the audit sink.
    }
  }

  private allowedChats(): Set<string> {
    const configured = this.config.get('CNC_TELEGRAM_ALLOWED_CHAT_IDS', { infer: true }) ?? '';
    return new Set(configured.split(',').map((value) => value.trim()).filter(Boolean));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addRawChatCandidate(supplied: Set<string>, value: unknown): void {
  if (value === undefined) return;
  if (typeof value === 'string') {
    supplied.add(value);
    return;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    supplied.add(String(value));
    return;
  }
  supplied.add('__invalid_raw_chat_id__');
}

export function sanitizeWorkerAuditBatch(dto: WorkerAuditBatchDto): WorkerAuditBatchDto {
  const copy = structuredClone(dto);
  copy.scan.errorMessage = sanitizeOptional(copy.scan.errorMessage);
  copy.messages = copy.messages.map((message) => ({
    ...message,
    filename: sanitizeOptional(message.filename),
    mimeType: sanitizeOptional(message.mimeType),
    messageText: sanitizeOptional(message.messageText),
    reasonMessage: sanitizeOptional(message.reasonMessage),
    errorMessage: sanitizeOptional(message.errorMessage),
  }));
  copy.operations = copy.operations.map((operation) => ({
    ...operation,
    reasonMessage: sanitizeOptional(operation.reasonMessage),
    errorMessage: sanitizeOptional(operation.errorMessage),
    replyText: sanitizeOptional(operation.replyText),
    steps: operation.steps.map((step) => ({ ...step, message: sanitizeString(step.message) })),
    responses: operation.responses.map((response) => ({
      ...response,
      text: sanitizeOptional(response.text),
      errorMessage: sanitizeOptional(response.errorMessage),
    })),
  }));
  return copy;
}

function sanitizeString(value: string): string {
  return SECRET_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function sanitizeOptional(value: string | null | undefined): string | null | undefined {
  return typeof value === 'string' ? sanitizeString(value) : value;
}

export function sanitizeTechnicalLogBatch(dto: TechnicalLogBatchDto): TechnicalLogBatchDto {
  return {
    batchId: dto.batchId,
    lines: dto.lines.map((line) => {
      const sanitized = sanitizeTechnicalMessage(line.message);
      return {
        ...line,
        message: sanitized.message,
        redacted: line.redacted || sanitized.categories.length > 0,
        truncated: line.truncated || sanitized.truncated,
        redactionCategories: [...new Set([...line.redactionCategories, ...sanitized.categories])].slice(0, 16),
      };
    }),
  };
}

function sanitizeTechnicalMessage(value: string): { message: string; categories: string[]; truncated: boolean } {
  let message = value;
  const categories: string[] = [];
  for (const [category, pattern, replacement] of TECHNICAL_SECRET_PATTERNS) {
    const next = message.replace(pattern, replacement);
    if (next !== message) categories.push(category);
    message = next;
  }
  if (TECHNICAL_FORBIDDEN_PATTERN.test(message)) {
    message = '[QUARANTINED: possible credential remained after backend redaction]';
    categories.push('quarantined');
  }
  const truncated = message.length > 8192;
  return { message: message.slice(0, 8192), categories, truncated };
}

function formatTechnicalExportLine(line: Record<string, unknown>): string {
  const markers = [line.redacted ? 'redacted' : null, line.truncated ? 'truncated' : null, Number(line.droppedBefore) > 0 ? `dropped=${line.droppedBefore}` : null]
    .filter(Boolean).join(',');
  return `${String(line.observedAt)} ${String(line.stream).toUpperCase()} ${String(line.workerInstanceId)}#${String(line.sequence)}${markers ? ` [${markers}]` : ''} ${String(line.message)}`;
}

function arrayField(value: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const field = value[key];
  return Array.isArray(field)
    ? field.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
}

function enrichManualSvgTelegramSend(
  request: Record<string, unknown>,
  runtimeSessions: Record<string, unknown>[],
  exportedAt: Date,
): Record<string, unknown> {
  const status = stringField(request, 'status');
  const destinationChatId = stringField(request, 'destinationChatId');
  const activeSessions = runtimeSessions.filter((session) => session.active === true);
  const matchingSession = activeSessions.find((session) => (
    stringField(session, 'sourceChatId') === destinationChatId
  ));
  const blockingReasonCodes: string[] = [];

  if (status !== 'pending') blockingReasonCodes.push('STATUS_NOT_PENDING');
  if (numberField(request, 'attemptCount') >= 5) blockingReasonCodes.push('ATTEMPT_LIMIT_REACHED');
  if (!destinationChatId) blockingReasonCodes.push('DESTINATION_CHAT_MISSING');
  if (destinationChatId && !matchingSession) {
    blockingReasonCodes.push(activeSessions.length > 0 ? 'DESTINATION_CHAT_MISMATCH' : 'NO_ACTIVE_WORKER');
  }
  if (matchingSession && !hasCompleteRuntimeEvidence(matchingSession)) {
    blockingReasonCodes.push('WORKER_RUNTIME_EVIDENCE_INCOMPLETE');
  } else if (matchingSession?.canSendManualSvgUploads !== true) {
    if (matchingSession) blockingReasonCodes.push('WORKER_MANUAL_SEND_DISABLED');
  }
  if (stringField(request, 'svgCutImportStatus') !== 'imported') {
    blockingReasonCodes.push('SVG_IMPORT_NOT_READY');
  }
  if (!stringField(request, 'cutJobId')) blockingReasonCodes.push('CUT_JOB_MISSING');
  if (!String(request.cutJobDisplayNumber ?? '').trim()) blockingReasonCodes.push('CUT_JOB_DISPLAY_NUMBER_MISSING');
  if (request.hasMdfEvent !== true) blockingReasonCodes.push('MDF_EVENT_MISSING');
  if (numberField(request, 'liveFileCount') < 1) blockingReasonCodes.push('NO_LIVE_FILES');

  const requestedAt = new Date(String(request.requestedAt ?? ''));
  const ageSeconds = Number.isFinite(requestedAt.getTime())
    ? Math.max(0, Math.floor((exportedAt.getTime() - requestedAt.getTime()) / 1000))
    : null;
  const pollSeconds = matchingSession
    ? numberField(matchingSession, 'manualSvgSendPollIntervalSeconds')
    : 0;
  const stuckThresholdSeconds = Math.max(60, pollSeconds > 0 ? pollSeconds * 3 : 60);
  const claimableNow = blockingReasonCodes.length === 0;
  const stuck = claimableNow && ageSeconds !== null && ageSeconds > stuckThresholdSeconds;
  const reasonCodes = [...blockingReasonCodes, ...(stuck ? ['CLAIMABLE_BACKLOG_NOT_CLAIMED'] : [])];

  return {
    ...request,
    routing: {
      packetSourceChatId: request.packetSourceChatId ?? null,
      packetSourceIsSynthetic: request.packetSourceChatId === 'erp-manual-svg-upload',
      destinationChatId: destinationChatId || null,
      activeWorkerChatId: matchingSession?.sourceChatId ?? null,
      destinationMatchesActiveWorker: Boolean(matchingSession),
    },
    eligibility: {
      claimableNow,
      stuck,
      ageSeconds,
      stuckThresholdSeconds,
      reasonCodes,
      checks: {
        statusPending: status === 'pending',
        attemptLimitAvailable: numberField(request, 'attemptCount') < 5,
        destinationPresent: Boolean(destinationChatId),
        activeWorkerPresent: Boolean(matchingSession),
        workerRuntimeEvidenceComplete: matchingSession ? hasCompleteRuntimeEvidence(matchingSession) : false,
        workerManualSendEnabled: matchingSession?.canSendManualSvgUploads === true,
        svgImportReady: stringField(request, 'svgCutImportStatus') === 'imported',
        cutJobPresent: Boolean(stringField(request, 'cutJobId')),
        cutJobDisplayNumberPresent: Boolean(String(request.cutJobDisplayNumber ?? '').trim()),
        mdfEventPresent: request.hasMdfEvent === true,
        liveFilesPresent: numberField(request, 'liveFileCount') > 0,
      },
    },
  };
}

function manualSendFindings(requests: Record<string, unknown>[]): Record<string, unknown> {
  const pending = requests.filter((request) => request.status === 'pending');
  const processing = requests.filter((request) => request.status === 'processing');
  const unknown = requests.filter((request) => request.status === 'unknown');
  const claimable = pending.filter((request) => isRecord(request.eligibility) && request.eligibility.claimableNow === true);
  const stuck = pending.filter((request) => isRecord(request.eligibility) && request.eligibility.stuck === true);
  const reasonCounts: Record<string, number> = {};
  for (const request of pending) {
    if (!isRecord(request.eligibility)) continue;
    for (const reason of request.eligibility.reasonCodes as unknown[] ?? []) {
      if (typeof reason === 'string') reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    }
  }
  return {
    severity: stuck.length > 0 ? 'error' : pending.length > 0 || processing.length > 0 ? 'warning' : 'healthy',
    pendingCount: pending.length,
    processingCount: processing.length,
    unknownCount: unknown.length,
    claimablePendingCount: claimable.length,
    stuckPendingCount: stuck.length,
    reasonCounts,
  };
}

function hasCompleteRuntimeEvidence(session: Record<string, unknown>): boolean {
  return Boolean(
    stringField(session, 'stackEnv')
    && stringField(session, 'workerRole')
    && typeof session.canSendManualSvgUploads === 'boolean'
    && numberField(session, 'manualSvgSendPollIntervalSeconds') > 0
    && stringField(session, 'parserVersion'),
  );
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  return typeof field === 'string' ? field.trim() : field == null ? '' : String(field).trim();
}

function numberField(value: Record<string, unknown>, key: string): number {
  const parsed = Number(value[key]);
  return Number.isFinite(parsed) ? parsed : 0;
}
