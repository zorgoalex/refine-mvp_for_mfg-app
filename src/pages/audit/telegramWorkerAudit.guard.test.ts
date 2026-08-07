import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildTelegramWorkerAuditExportQuery,
  buildTelegramWorkerAuditQuery,
  isTelegramWorkerScanStale,
} from './TelegramWorkerAudit';
import type { TelegramWorkerScan } from '../../api/types/cncTelegramWorkerAudit.types';
import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';

describe('Telegram worker audit UI', () => {
  it('encodes bounded filters', () => {
    const values: Parameters<typeof buildTelegramWorkerAuditQuery>[0] = {
      period: [dayjs('2026-08-01'), dayjs('2026-08-06')], status: 'failed',
      messageType: 'svg', search: ' 9007199254740993 ',
    };
    expect(buildTelegramWorkerAuditQuery(values, 25)).toEqual({
      dateFrom: '2026-08-01', dateTo: '2026-08-06', page: 1, pageSize: 25,
      sortDirection: 'desc',
      status: 'failed', messageType: 'svg', reasonCode: undefined, search: '9007199254740993',
    });
    expect(buildTelegramWorkerAuditExportQuery(values)).toEqual({
      dateFrom: '2026-08-01', dateTo: '2026-08-06',
      status: 'failed', messageType: 'svg', reasonCode: undefined, search: '9007199254740993',
    });
  });

  it('keeps separate audit tabs, readable sender/session ids and accessible controls', () => {
    const list = readFileSync(join(__dirname, 'list.tsx'), 'utf8');
    const telegram = readFileSync(join(__dirname, 'TelegramWorkerAudit.tsx'), 'utf8');
    expect(list).toContain("label: 'Действия ERP'");
    expect(list).toContain("label: 'Telegram-бот'");
    expect(telegram).toContain('Сессия Telegram #');
    expect(telegram).toContain('Отправитель #');
    expect(telegram).toContain('font-variant-numeric: tabular-nums');
    expect(telegram).toContain('min-height: 40px');
    expect(telegram).toContain('replyToMessageId');
    expect(telegram).toContain('sentTelegramMessageId');
    expect(telegram).toContain('Выгрузить JSON');
    expect(telegram).toContain('все поля сканов, сообщений, наблюдений, операций, шагов и ответов');
    expect(telegram).toContain('loading={exporting}');
    expect(telegram).toContain('saveBlob(');
    expect(telegram).toContain('sorter={true}');
    expect(telegram).toContain("sortOrder={query.sortDirection === 'asc' ? 'ascend' : 'descend'}");
  });

  it('marks only an overdue running scan as stale', () => {
    const scan: TelegramWorkerScan = {
      scanId: '550e8400-e29b-41d4-a716-446655440000', sourceChatId: '-100123', workday: '2026-08-06',
      status: 'running', startedAt: '2026-08-06T10:00:00Z', finishedAt: null, sessionUserId: '77',
      dayYieldedCount: 0, dayExhausted: false, dayTruncated: false, dayErrorCode: null,
      replySearchYieldedCount: 0, replySearchExhausted: false, replySearchTruncated: false, replySearchErrorCode: null,
      svgCount: 0, processedCount: 0, ingestedCount: 0, skippedCount: 0, failedCount: 0,
      parserVersion: 'v1', workerVersion: 'v1', canWriteChat: false, errorCode: null, errorMessage: null,
    };
    expect(isTelegramWorkerScanStale(scan, dayjs('2026-08-06T10:02:01Z'))).toBe(true);
    expect(isTelegramWorkerScanStale(scan, dayjs('2026-08-06T10:02:00Z'))).toBe(false);
    expect(isTelegramWorkerScanStale({ ...scan, status: 'completed' }, dayjs('2026-08-06T11:00:00Z'))).toBe(false);
  });
});
