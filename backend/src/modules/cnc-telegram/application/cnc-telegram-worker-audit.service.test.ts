import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PgCncTelegramWorkerAuditRepository } from '../adapters/pg-cnc-telegram-worker-audit-repository';
import { parseWorkerAuditBatch } from '../dto/cnc-telegram-worker-audit.dto';
import { CncTelegramWorkerAuditService } from './cnc-telegram-worker-audit.service';

const scanId = '550e8400-e29b-41d4-a716-446655440000';
const digest = 'a'.repeat(64);

describe('CncTelegramWorkerAuditService', () => {
  it('authorizes and audits a spoofed writer before parsing malformed payload', async () => {
    const deniedAudit = deniedAuditPort();
    const service = createService(deniedAudit);

    await expect(service.writeRawBatch(user('intruder', []), { malformed: true }, 'request-malformed-spoof'))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });
    expect(deniedAudit.recordWorkerAuditWriteDenied).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'request-malformed-spoof', reason: 'PERMISSION_DENIED',
    }));
  });

  it('audits a disallowed raw chat before parsing the rest of a malformed payload', async () => {
    const deniedAudit = deniedAuditPort();
    const service = createService(deniedAudit);

    await expect(service.writeRawBatch(
      user('cnc-bot', ['cut.manage']),
      { scan: { sourceChatId: '-100999' }, messages: 'malformed' },
      'request-malformed-chat',
    )).rejects.toMatchObject({ code: 'CNC_TELEGRAM_CHAT_DENIED', statusCode: 403 });
    expect(deniedAudit.recordWorkerAuditWriteDenied).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'request-malformed-chat', reason: 'CNC_TELEGRAM_CHAT_DENIED',
    }));
  });

  it.each([
    { scan: { sourceChatId: -100999 }, messages: 'malformed' },
    { scan: { sourceChatId: '-100123' }, messages: [{ sourceChatId: -100999 }] },
    { scan: { sourceChatId: '-100123' }, observations: [{ sourceChatId: -100999 }] },
    { scan: { sourceChatId: '-100123' }, messages: [{ sourceChatId: { injected: true } }] },
  ])('denies and audits malformed non-string raw chat candidates before DTO parsing', async (raw) => {
    const deniedAudit = deniedAuditPort();
    const service = createService(deniedAudit);

    await expect(service.writeRawBatch(
      user('cnc-bot', ['cut.manage']), raw, 'request-malformed-numeric-chat',
    )).rejects.toMatchObject({ code: 'CNC_TELEGRAM_CHAT_DENIED', statusCode: 403 });
    expect(deniedAudit.recordWorkerAuditWriteDenied).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'request-malformed-numeric-chat', reason: 'CNC_TELEGRAM_CHAT_DENIED',
    }));
  });

  it('canonicalizes an allowed safe-integer raw chat before bounded DTO rejection', async () => {
    const deniedAudit = deniedAuditPort();
    const service = createService(deniedAudit);

    await expect(service.writeRawBatch(
      user('cnc-bot', ['cut.manage']),
      { scan: { sourceChatId: -100123 }, messages: 'malformed' },
      'request-malformed-allowed-numeric-chat',
    )).rejects.toMatchObject({ code: 'INVALID_CNC_TELEGRAM_WORKER_AUDIT', statusCode: 422 });
    expect(deniedAudit.recordWorkerAuditWriteDenied).not.toHaveBeenCalled();
  });

  it('returns bounded validation for malformed payload from the authorized chat', async () => {
    const deniedAudit = deniedAuditPort();
    const service = createService(deniedAudit);

    await expect(service.writeRawBatch(
      user('cnc-bot', ['cut.manage']),
      { scan: { sourceChatId: '-100123' }, messages: 'malformed' },
      'request-malformed-allowed',
    )).rejects.toMatchObject({ code: 'INVALID_CNC_TELEGRAM_WORKER_AUDIT', statusCode: 422 });
    expect(deniedAudit.recordWorkerAuditWriteDenied).not.toHaveBeenCalled();
  });

  it('best-effort audits a spoofed writer without attacker payload', async () => {
    const deniedAudit = deniedAuditPort();
    const service = createService(deniedAudit);

    await expect(service.capabilities(user('intruder', []), 'request-spoofed')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
    });
    expect(deniedAudit.recordWorkerAuditWriteDenied).toHaveBeenCalledWith({
      currentUser: user('intruder', []),
      event: 'cnc.telegram_worker.audit_write_denied',
      requestId: 'request-spoofed',
      reason: 'PERMISSION_DENIED',
      requiredPermissions: ['cut.manage'],
    });
  });

  it('best-effort audits a denied chat without persisting its id in audit metadata', async () => {
    const deniedAudit = deniedAuditPort();
    const service = createService(deniedAudit);

    await expect(service.writeBatch(user('cnc-bot', ['cut.manage']), batch('-100999'), 'request-chat')).rejects.toMatchObject({
      code: 'CNC_TELEGRAM_CHAT_DENIED',
      statusCode: 403,
    });
    expect(deniedAudit.recordWorkerAuditWriteDenied).toHaveBeenCalledWith({
      currentUser: user('cnc-bot', ['cut.manage']),
      event: 'cnc.telegram_worker.audit_write_denied',
      requestId: 'request-chat',
      reason: 'CNC_TELEGRAM_CHAT_DENIED',
      requiredPermissions: ['cut.manage'],
    });
  });

  it('does not collapse a basic-group id and a supergroup id with the same suffix', async () => {
    const service = createService(deniedAuditPort());

    await expect(service.writeBatch(user('cnc-bot', ['cut.manage']), batch('-123'), 'request-collision'))
      .rejects.toMatchObject({ code: 'CNC_TELEGRAM_CHAT_DENIED', statusCode: 403 });
  });
});

function createService(deniedAudit: ReturnType<typeof deniedAuditPort>): CncTelegramWorkerAuditService {
  const repository = {
    capabilities: vi.fn().mockResolvedValue(true),
    writeBatch: vi.fn().mockResolvedValue({ accepted: 1 }),
  } as unknown as PgCncTelegramWorkerAuditRepository;
  const config = {
    get: vi.fn((key: keyof BackendEnv) => ({
      CNC_TELEGRAM_WORKER_USERNAME: 'cnc-bot',
      CNC_TELEGRAM_ALLOWED_CHAT_IDS: '-100123',
    })[key]),
  } as unknown as ConfigService<BackendEnv, true>;
  return new CncTelegramWorkerAuditService(repository, config, deniedAudit);
}

function deniedAuditPort() {
  return {
    recordIngestDenied: vi.fn().mockResolvedValue(undefined),
    recordAutoCutStatusConfigureDenied: vi.fn().mockResolvedValue(undefined),
    recordWorkerAuditWriteDenied: vi.fn().mockResolvedValue(undefined),
  };
}

function user(username: string, permissions: CurrentUser['permissions']): CurrentUser {
  return { id: '7', username, role: 'admin', roleId: 1, permissions };
}

function batch(chatId: string) {
  const at = '2026-08-06T10:00:00+00:00';
  return parseWorkerAuditBatch({
    scan: {
      scanId, sourceChatId: chatId, workday: '2026-08-06', status: 'completed', startedAt: at,
      finishedAt: at, dayYieldedCount: 0, dayExhausted: true, dayTruncated: false,
      replySearchYieldedCount: 0, replySearchExhausted: true, replySearchTruncated: false,
      svgCount: 0, processedCount: 0, ingestedCount: 0, skippedCount: 0, failedCount: 0,
      parserVersion: 'v1', workerVersion: 'v1', canWriteChat: false,
    },
    messages: [{
      logKey: `tglog:raw-v1:${digest}`, rawSourceDigest: `sha256:${digest}`,
      sanitizerVersion: 'v1', sourceChatId: chatId, sourceMessageId: '1',
      sourceCreatedAt: at, workday: '2026-08-06', messageType: 'text', outgoing: false,
      status: 'observed', reasonCode: 'message_observed', observedAt: at,
    }],
    observations: [],
    operations: [],
  });
}
