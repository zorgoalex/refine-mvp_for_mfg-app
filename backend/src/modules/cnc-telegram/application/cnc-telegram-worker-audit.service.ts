import { ConfigService } from '@nestjs/config';
import { ApiError } from '../../../common/errors/api-error';
import type { BackendEnv } from '../../../config/env.validation';
import type { CurrentUser } from '../../../permissions/current-user';
import { PermissionsService } from '../../../permissions/permissions.service';
import { PgCncTelegramWorkerAuditRepository } from '../adapters/pg-cnc-telegram-worker-audit-repository';
import type { CncTelegramDeniedAuditPort } from './cnc-telegram.types';
import {
  parseWorkerAuditBatch,
  type WorkerAuditBatchDto,
  type WorkerAuditExportQueryDto,
  type WorkerAuditListQueryDto,
} from '../dto/cnc-telegram-worker-audit.dto';

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],
  [/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, '[BOT_TOKEN_REDACTED]'],
  [/\b(password|secret|api[_-]?hash)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]'],
  [/(?:https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, 'https://[CREDENTIALS_REDACTED]@'],
  [/\/data\/session\/[A-Za-z0-9._/-]+/gi, '/data/session/[REDACTED]'],
  [/(?<!\d)\+?\d[\d ()-]{8,17}\d(?!\d)/g, '[PHONE_REDACTED]'],
];

export class CncTelegramWorkerAuditService {
  private readonly permissions = new PermissionsService();

  constructor(
    private readonly repository: PgCncTelegramWorkerAuditRepository,
    private readonly config: ConfigService<BackendEnv, true>,
    private readonly deniedAudit?: CncTelegramDeniedAuditPort,
  ) {}

  async capabilities(currentUser: CurrentUser, requestId?: string): Promise<{ capability: string }> {
    await this.assertWriter(currentUser, requestId);
    if (!await this.repository.capabilities()) {
      throw new ApiError(503, 'CNC_TELEGRAM_WORKER_AUDIT_UNAVAILABLE', 'Схема журнала Telegram-бота не готова');
    }
    return { capability: 'cnc_telegram_worker_audit_v1' };
  }

  async writeBatch(currentUser: CurrentUser, dto: WorkerAuditBatchDto, requestId?: string): Promise<{ accepted: number }> {
    await this.assertWriter(currentUser, requestId);
    await this.assertChats(currentUser, dto, requestId);
    return this.writeAuthorizedBatch(currentUser, dto);
  }

  async writeRawBatch(currentUser: CurrentUser, raw: unknown, requestId?: string): Promise<{ accepted: number }> {
    await this.assertWriter(currentUser, requestId);
    await this.assertRawChats(currentUser, raw, requestId);
    const dto = parseWorkerAuditBatch(raw);
    await this.assertChats(currentUser, dto, requestId);
    return this.writeAuthorizedBatch(currentUser, dto);
  }

  private async writeAuthorizedBatch(currentUser: CurrentUser, dto: WorkerAuditBatchDto): Promise<{ accepted: number }> {
    this.assertBatchReferences(dto);
    if (!await this.repository.capabilities()) {
      throw new ApiError(503, 'CNC_TELEGRAM_WORKER_AUDIT_UNAVAILABLE', 'Схема журнала Telegram-бота не готова');
    }
    return this.repository.writeBatch(sanitizeWorkerAuditBatch(dto), { id: currentUser.id });
  }

  list(currentUser: CurrentUser, query: WorkerAuditListQueryDto): Promise<Record<string, unknown>> {
    this.assertViewer(currentUser);
    return this.repository.list(query);
  }

  async exportDetailed(
    currentUser: CurrentUser,
    query: WorkerAuditExportQueryDto,
  ): Promise<{ fileName: string; content: string }> {
    this.assertViewer(currentUser);
    const data = await this.repository.exportDetailed(query);
    const operations = data.messages.flatMap((message) => arrayField(message, 'operations'));
    const payload = {
      format: 'erp.cnc-telegram-worker-audit',
      schemaVersion: 1,
      detailLevel: 'full',
      exportedAt: new Date().toISOString(),
      exportedBy: {
        userId: currentUser.id,
        username: currentUser.username,
        role: currentUser.role,
      },
      period: {
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        dateField: 'workday',
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
      },
      includes: [
        'all_stored_scan_fields',
        'all_stored_message_fields',
        'all_stored_observation_fields',
        'all_stored_operation_fields',
        'operation_steps',
        'operation_responses',
      ],
      scans: data.scans,
      messages: data.messages,
    };
    return {
      fileName: `telegram-worker-audit_${query.dateFrom}_${query.dateTo}.json`,
      content: `${JSON.stringify(payload, null, 2)}\n`,
    };
  }

  private assertViewer(currentUser: CurrentUser): void {
    if (!this.permissions.canUser(currentUser, 'audit.view')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для журнала Telegram-бота', {
        requiredPermissions: ['audit.view'],
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

  private async assertChats(currentUser: CurrentUser, dto: WorkerAuditBatchDto, requestId?: string): Promise<void> {
    const allowed = this.allowedChats();
    const supplied = new Set([dto.scan.sourceChatId, ...dto.messages.map((message) => message.sourceChatId), ...dto.observations.map((observation) => observation.sourceChatId)]);
    for (const chatId of supplied) {
      if (!allowed.has(chatId)) {
        await this.recordDenied(currentUser, requestId, 'CNC_TELEGRAM_CHAT_DENIED');
        throw new ApiError(403, 'CNC_TELEGRAM_CHAT_DENIED', 'Telegram-чат не разрешён политикой worker-аудита');
      }
    }
  }

  private async assertRawChats(currentUser: CurrentUser, raw: unknown, requestId?: string): Promise<void> {
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
    if ([...supplied].some((chatId) => !allowed.has(chatId))) {
      await this.recordDenied(currentUser, requestId, 'CNC_TELEGRAM_CHAT_DENIED');
      throw new ApiError(403, 'CNC_TELEGRAM_CHAT_DENIED', 'Telegram-чат не разрешён политикой worker-аудита');
    }
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

function arrayField(value: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const field = value[key];
  return Array.isArray(field)
    ? field.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
}
