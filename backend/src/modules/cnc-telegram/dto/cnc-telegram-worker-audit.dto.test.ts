import {
  parseWorkerAuditBatch,
  parseWorkerAuditExportQuery,
  parseWorkerAuditListQuery,
} from './cnc-telegram-worker-audit.dto';
import { describe, expect, it } from 'vitest';
import { sanitizeWorkerAuditBatch } from '../application/cnc-telegram-worker-audit.service';

const digest = 'a'.repeat(64);
const scan = {
  scanId: '550e8400-e29b-41d4-a716-446655440000', sourceChatId: '-1009007199254740993',
  workday: '2026-08-06', status: 'completed', startedAt: '2026-08-06T10:00:00+00:00',
  finishedAt: '2026-08-06T10:01:00+00:00', sessionUserId: '9007199254740993',
  dayYieldedCount: 1, dayExhausted: true, dayTruncated: false, dayErrorCode: null,
  replySearchYieldedCount: 0, replySearchExhausted: true, replySearchTruncated: false,
  replySearchErrorCode: null, svgCount: 1, processedCount: 1, ingestedCount: 1,
  skippedCount: 0, failedCount: 0, parserVersion: 'v1', workerVersion: 'v1',
  canWriteChat: true, errorCode: null, errorMessage: null,
};

describe('CNC Telegram worker audit DTO', () => {
  it('preserves signed bigint Telegram ids as strings', () => {
    const parsed = parseWorkerAuditBatch({
      scan,
      messages: [{
        logKey: `tglog:raw-v1:${digest}`, rawSourceDigest: `sha256:${digest}`,
        sanitizerVersion: 'v1', sourceChatId: scan.sourceChatId,
        sourceMessageId: '9007199254740993', senderUserId: '9007199254740994',
        sourceCreatedAt: scan.startedAt, workday: scan.workday, messageType: 'svg',
        filename: 'layout.svg', messageText: 'Телефон +7 777 123 45 67', outgoing: false, status: 'ingested',
        reasonCode: 'backend_ingest_succeeded', observedAt: scan.startedAt,
      }],
      observations: [{
        scanId: scan.scanId, logKey: `tglog:raw-v1:${digest}`, sourceChatId: scan.sourceChatId,
        sourceMessageId: '9007199254740993', observedAt: scan.startedAt,
        readSource: 'day_history', readOrdinal: 1, classificationCode: 'message_svg',
      }],
      operations: [],
    });
    expect(parsed.messages[0].sourceMessageId).toBe('9007199254740993');
    expect(parsed.messages[0].senderUserId).toBe('9007199254740994');
    const sanitized = sanitizeWorkerAuditBatch(parsed);
    expect(sanitized.messages[0].sourceMessageId).toBe('9007199254740993');
    expect(sanitized.messages[0].senderUserId).toBe('9007199254740994');
    expect(sanitized.messages[0].messageText).toContain('[PHONE_REDACTED]');
    expect(sanitizeWorkerAuditBatch({
      ...parsed,
      messages: [{ ...parsed.messages[0], messageText: 'password=top-secret' }],
    }).messages[0].messageText).toBe('password=[REDACTED]');
  });

  it('enforces canonical PostgreSQL BIGINT ids and bounded numeric search', () => {
    for (const sourceChatId of ['0', '-9223372036854775808', '9223372036854775807']) {
      expect(parseWorkerAuditBatch({
        scan: { ...scan, sourceChatId }, messages: [], observations: [], operations: [],
      }).scan.sourceChatId).toBe(sourceChatId);
    }
    for (const sourceChatId of ['00', '-0', '9223372036854775808', '-9223372036854775809']) {
      expect(() => parseWorkerAuditBatch({
        scan: { ...scan, sourceChatId }, messages: [], observations: [], operations: [],
      })).toThrow();
    }
    expect(() => parseWorkerAuditBatch({
      scan: { ...scan, sourceChatId: '9'.repeat(10000) }, messages: [], observations: [], operations: [],
    })).toThrow();
    expect(() => parseWorkerAuditListQuery({ search: '9223372036854775808' })).toThrow();
    expect(parseWorkerAuditListQuery({ search: '9223372036854775807' }).search).toBe('9223372036854775807');
  });

  it('rejects unknown fields and reconciliation without an operation key', () => {
    expect(() => parseWorkerAuditBatch({ ...scan, unexpected: true })).toThrow();
    expect(() => parseWorkerAuditBatch({
      scan, messages: [], operations: [], observations: [{
        scanId: scan.scanId, logKey: `tglog:raw-v1:${digest}`, sourceChatId: scan.sourceChatId,
        sourceMessageId: '1', observedAt: scan.startedAt, readSource: 'reply_reconciliation',
        readOrdinal: 1, classificationCode: 'bot_reply',
      }],
    })).toThrow();
  });

  it('bounds list periods to 31 days', () => {
    expect(parseWorkerAuditListQuery({ dateFrom: '2026-08-01', dateTo: '2026-08-06' }).pageSize).toBe(50);
    expect(parseWorkerAuditListQuery({ dateFrom: '2026-08-01', dateTo: '2026-08-31' }).dateTo).toBe('2026-08-31');
    expect(parseWorkerAuditListQuery({ dateFrom: '2024-02-29', dateTo: '2024-02-29' }).dateFrom).toBe('2024-02-29');
    expect(() => parseWorkerAuditListQuery({ dateFrom: '2026-01-01', dateTo: '2026-08-06' })).toThrow();
    expect(() => parseWorkerAuditListQuery({ dateFrom: '2026-08-01', dateTo: '2026-09-01' })).toThrow();
    expect(() => parseWorkerAuditListQuery({ dateFrom: '2026-02-29', dateTo: '2026-03-01' })).toThrow();
    expect(() => parseWorkerAuditListQuery({ dateFrom: '2026-99-99', dateTo: '2026-99-99' })).toThrow();
    expect(() => parseWorkerAuditBatch({
      scan: { ...scan, workday: '2026-02-29' }, messages: [], observations: [], operations: [],
    })).toThrow();
  });

  it('accepts bounded export filters without pagination fields', () => {
    expect(parseWorkerAuditExportQuery({
      dateFrom: '2026-08-01', dateTo: '2026-08-31', status: 'failed', messageType: 'svg',
      reasonCode: 'backend_ingest_failed', search: ' layout.svg ',
    })).toEqual({
      dateFrom: '2026-08-01', dateTo: '2026-08-31', status: 'failed', messageType: 'svg',
      reasonCode: 'backend_ingest_failed', search: 'layout.svg',
    });
    expect(() => parseWorkerAuditExportQuery({
      dateFrom: '2026-08-01', dateTo: '2026-09-01',
    })).toThrow();
    expect(() => parseWorkerAuditExportQuery({
      dateFrom: '2026-08-01', dateTo: '2026-08-06', page: 1,
    })).toThrow();
  });

  it('rejects reason codes outside the closed taxonomy', () => {
    expect(() => parseWorkerAuditBatch({
      scan: { ...scan, errorCode: 'made_up_reason' }, messages: [], observations: [], operations: [],
    })).toThrow();
  });

  it('rejects classification codes outside the closed taxonomy', () => {
    expect(() => parseWorkerAuditBatch({
      scan,
      messages: [{
        logKey: `tglog:raw-v1:${digest}`, rawSourceDigest: `sha256:${digest}`,
        sanitizerVersion: 'v1', sourceChatId: scan.sourceChatId, sourceMessageId: '1',
        sourceCreatedAt: scan.startedAt, workday: scan.workday, messageType: 'svg',
        outgoing: false, status: 'observed', reasonCode: 'message_observed', observedAt: scan.startedAt,
      }],
      observations: [{
        scanId: scan.scanId, logKey: `tglog:raw-v1:${digest}`, sourceChatId: scan.sourceChatId,
        sourceMessageId: '1', observedAt: scan.startedAt, readSource: 'day_history',
        readOrdinal: 1, classificationCode: 'message_pdf',
      }],
      operations: [],
    })).toThrow();
  });

  it('binds operationKey to the exact scan, digest, type, and positive ordinal', () => {
    const message = {
      logKey: `tglog:raw-v1:${digest}`, rawSourceDigest: `sha256:${digest}`,
      sanitizerVersion: 'v1', sourceChatId: scan.sourceChatId, sourceMessageId: '1',
      sourceCreatedAt: scan.startedAt, workday: scan.workday, messageType: 'svg' as const,
      outgoing: false, status: 'observed' as const, reasonCode: 'message_observed' as const, observedAt: scan.startedAt,
    };
    const operation = {
      operationKey: `tgop:v1:${scan.scanId}:${digest}:message_processing:1`,
      scanId: scan.scanId, logKey: message.logKey, operationType: 'message_processing' as const,
      status: 'planned' as const, plannedAt: scan.startedAt, steps: [], responses: [],
    };
    expect(parseWorkerAuditBatch({ scan, messages: [message], observations: [], operations: [operation] })
      .operations[0].operationKey).toBe(operation.operationKey);
    for (const operationKey of [
      `tgop:v1:da57432f-bb1e-45a1-a3ec-1022ab15e938:${digest}:message_processing:1`,
      `tgop:v1:${scan.scanId}:${'b'.repeat(64)}:message_processing:1`,
      `tgop:v1:${scan.scanId}:${digest}:telegram_reply:1`,
      `tgop:v1:${scan.scanId}:${digest}:message_processing:0`,
    ]) {
      expect(() => parseWorkerAuditBatch({
        scan, messages: [message], observations: [], operations: [{ ...operation, operationKey }],
      })).toThrow();
    }
  });

  it('rejects a log key whose digest does not match the raw source digest', () => {
    expect(() => parseWorkerAuditBatch({
      scan,
      messages: [{
        logKey: `tglog:raw-v1:${digest}`, rawSourceDigest: `sha256:${'b'.repeat(64)}`,
        sanitizerVersion: 'v1', sourceChatId: scan.sourceChatId, sourceMessageId: '1',
        sourceCreatedAt: scan.startedAt, workday: scan.workday, messageType: 'svg',
        outgoing: false, status: 'observed', reasonCode: 'message_observed', observedAt: scan.startedAt,
      }],
      observations: [],
      operations: [],
    })).toThrow();
  });

  it('rejects operations and observations outside the current batch', () => {
    const message = {
      logKey: `tglog:raw-v1:${digest}`, rawSourceDigest: `sha256:${digest}`,
      sanitizerVersion: 'v1', sourceChatId: scan.sourceChatId, sourceMessageId: '1',
      sourceCreatedAt: scan.startedAt, workday: scan.workday, messageType: 'svg',
      outgoing: false, status: 'observed', reasonCode: 'message_observed', observedAt: scan.startedAt,
    };
    expect(() => parseWorkerAuditBatch({
      scan, messages: [message], observations: [], operations: [{
        operationKey: 'tgop:v1:foreign', scanId: 'da57432f-bb1e-45a1-a3ec-1022ab15e938',
        logKey: message.logKey, operationType: 'message_processing', status: 'planned',
        plannedAt: scan.startedAt, steps: [], responses: [],
      }],
    })).toThrow();
    expect(() => parseWorkerAuditBatch({
      scan, messages: [message], operations: [], observations: [{
        scanId: scan.scanId, logKey: `tglog:raw-v1:${'b'.repeat(64)}`,
        sourceChatId: scan.sourceChatId, sourceMessageId: '2', observedAt: scan.startedAt,
        readSource: 'day_history', readOrdinal: 1, classificationCode: 'message_svg',
      }],
    })).toThrow();
    expect(() => parseWorkerAuditBatch({
      scan, messages: [message], operations: [], observations: [{
        scanId: scan.scanId, logKey: message.logKey,
        sourceChatId: message.sourceChatId, sourceMessageId: '2', observedAt: scan.startedAt,
        readSource: 'day_history', readOrdinal: 1, classificationCode: 'message_svg',
      }],
    })).toThrow();
  });
});
