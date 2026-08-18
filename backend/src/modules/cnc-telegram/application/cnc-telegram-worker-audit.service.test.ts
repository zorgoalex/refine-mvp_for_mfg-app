import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PgCncTelegramWorkerAuditRepository } from '../adapters/pg-cnc-telegram-worker-audit-repository';
import { parseWorkerAuditBatch } from '../dto/cnc-telegram-worker-audit.dto';
import { CncTelegramWorkerAuditService } from './cnc-telegram-worker-audit.service';

const scanId = '550e8400-e29b-41d4-a716-446655440000';
const digest = 'a'.repeat(64);
const sessionLease = {
  sourceChatId: '-100123',
  leaseToken: 't'.repeat(64),
  leaseGeneration: 1,
  workerInstanceId: scanId,
};

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

  it('exports a readable full-fidelity JSON envelope for audit viewers', async () => {
    const exportDetailed = vi.fn().mockResolvedValue({
      scans: [{ scanId }],
      messages: [{
        logId: 'log-1',
        observations: [{ observationId: 'observation-1' }],
        operations: [{
          operationId: 'operation-1',
          steps: [{ stepId: 'step-1' }],
          responses: [{ responseId: 'response-1' }, { responseId: 'response-2' }],
        }],
      }],
    });
    const service = createService(deniedAuditPort(), { exportDetailed });
    const query = { dateFrom: '2026-08-01', dateTo: '2026-08-06', status: 'failed' } as const;

    const currentUser = user('auditor', ['audit.view']);
    const file = await service.exportDetailed(currentUser, query);
    const payload = JSON.parse(file.content) as Record<string, unknown>;

    expect(exportDetailed).toHaveBeenCalledWith(query);
    expect(file.fileName).toBe('telegram-worker-audit_2026-08-01_2026-08-06.json');
    expect(file.content.endsWith('\n')).toBe(true);
    expect(payload).toMatchObject({
      format: 'erp.cnc-telegram-worker-audit',
      schemaVersion: 1,
      detailLevel: 'full',
      exportedBy: { userId: currentUser.id, username: 'auditor', role: currentUser.role },
      period: {
        dateFrom: '2026-08-01', dateTo: '2026-08-06',
        messageDateField: 'sourceCreatedAt', messageTimezone: 'Asia/Almaty',
        scanDateField: 'workday', inclusive: true,
      },
      filters: { status: 'failed', messageType: null, reasonCode: null, search: null },
      totals: { scans: 1, messages: 1, observations: 1, operations: 1, steps: 1, responses: 2 },
    });
    expect(payload.scans).toEqual([{ scanId }]);
    expect(payload.messages).toEqual([expect.objectContaining({
      operations: [expect.objectContaining({
        responses: [{ responseId: 'response-1' }, { responseId: 'response-2' }],
      })],
    })]);
  });

  it('denies detailed export without audit.view before reading the repository', async () => {
    const exportDetailed = vi.fn();
    const service = createService(deniedAuditPort(), { exportDetailed });

    await expect(service.exportDetailed(
      user('viewer', []),
      { dateFrom: '2026-08-01', dateTo: '2026-08-06' },
    )).rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });
    expect(exportDetailed).not.toHaveBeenCalled();
  });

  it('requires the distinct dangerous permission for raw technical logs', async () => {
    const listTechnical = vi.fn();
    const service = createService(deniedAuditPort(), { listTechnical });
    const query = { dateFrom: '2026-08-18', dateTo: '2026-08-18', page: 1, pageSize: 100 };

    expect(() => service.listTechnical(user('auditor', ['audit.view']), query))
      .toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED', statusCode: 403 }));
    expect(listTechnical).not.toHaveBeenCalled();

    await service.listTechnical(user('admin', ['audit.technical.view']), query);
    expect(listTechnical).toHaveBeenCalledWith(query);
  });

  it('redacts worker credentials again before storing technical lines', async () => {
    const writeTechnicalBatch = vi.fn().mockResolvedValue({ accepted: 1 });
    const service = createService(deniedAuditPort(), {
      technicalCapabilities: vi.fn().mockResolvedValue(true), writeTechnicalBatch,
    });
    await service.writeTechnicalRawBatch(user('cnc-bot', ['cut.manage']), {
      batchId: '550e8400-e29b-41d4-a716-446655440001',
      lines: [{
        workerInstanceId: scanId, sequence: 1, observedAt: '2026-08-18T14:49:40+00:00',
        stream: 'stderr', message: 'Authorization: Bearer unsafe-token-value',
        redactionVersion: 'worker-v1', redacted: false, truncated: false,
        redactionCategories: [], droppedBefore: 0,
      }],
    }, undefined, sessionLease);
    expect(writeTechnicalBatch).toHaveBeenCalledWith(expect.objectContaining({
      lines: [expect.objectContaining({ message: 'Authorization: [REDACTED]', redacted: true, redactionCategories: ['authorization'] })],
    }), { id: '7' }, sessionLease);
  });

  it('passes the resolved single allowed chat to the technical repository', async () => {
    const writeTechnicalBatch = vi.fn().mockResolvedValue({ accepted: 1 });
    const repository = {
      technicalCapabilities: vi.fn().mockResolvedValue(true), writeTechnicalBatch,
    } as unknown as PgCncTelegramWorkerAuditRepository;
    const config = {
      get: vi.fn((key: keyof BackendEnv) => ({
        CNC_TELEGRAM_WORKER_USERNAME: 'cnc-bot',
        CNC_TELEGRAM_ALLOWED_CHAT_IDS: '-100123',
      })[key]),
    } as unknown as ConfigService<BackendEnv, true>;
    const session = {
      resolveChatId: vi.fn().mockReturnValue('-100123'),
      assertCurrent: vi.fn().mockResolvedValue(undefined),
    };
    const service = new CncTelegramWorkerAuditService(
      repository,
      config,
      deniedAuditPort(),
      session as never,
    );
    const leaseWithoutChat = { ...sessionLease, sourceChatId: '' };

    await service.writeTechnicalRawBatch(user('cnc-bot', ['cut.manage']), {
      batchId: '550e8400-e29b-41d4-a716-446655440001',
      lines: [{
        workerInstanceId: scanId, sequence: 1, observedAt: '2026-08-18T14:49:40+00:00',
        stream: 'stdout', message: 'worker alive', redactionVersion: 'worker-v1',
        redacted: false, truncated: false, redactionCategories: [], droppedBefore: 0,
      }],
    }, undefined, leaseWithoutChat);

    const normalizedLease = { ...sessionLease, sourceChatId: '-100123' };
    expect(session.assertCurrent).toHaveBeenCalledWith(user('cnc-bot', ['cut.manage']), normalizedLease);
    expect(writeTechnicalBatch).toHaveBeenCalledWith(expect.any(Object), { id: '7' }, normalizedLease);
  });
});

function createService(
  deniedAudit: ReturnType<typeof deniedAuditPort>,
  repositoryOverrides: Record<string, unknown> = {},
): CncTelegramWorkerAuditService {
  const repository = {
    capabilities: vi.fn().mockResolvedValue(true),
    writeBatch: vi.fn().mockResolvedValue({ accepted: 1 }),
    listTechnical: vi.fn().mockResolvedValue({}),
    ...repositoryOverrides,
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
