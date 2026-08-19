import { describe, expect, it } from 'vitest';
import type { CncTelegramImportRequest } from '../../api/types/cncTelegramImportApi.types';
import {
  candidateLayoutSummary,
  candidateScreenshotLabel,
  eligibleCandidateIdForMessage,
  hasCandidateScreenshot,
  importMessageAttachmentLabel,
  importMessageHumanContent,
  importMessageTimeLabel,
  needsDuplicateReconfirmation,
  repeatableItems,
  sortImportMessages,
} from './cutTelegramImportHelpers';

const baseRequest = (status: CncTelegramImportRequest['status'], items: CncTelegramImportRequest['items']): CncTelegramImportRequest => ({
  importRequestId: '11111111-1111-4111-8111-111111111111',
  scanId: '22222222-2222-4222-8222-222222222222',
  status,
  confirmationId: '33333333-3333-4333-8333-333333333333',
  totalCount: items.length,
  importedCount: items.filter((item) => item.status === 'imported').length,
  failedCount: items.filter((item) => item.status === 'failed').length,
  items,
  error: null,
});

const item = (candidateId: string, status: CncTelegramImportRequest['items'][number]['status']) => ({
  importItemId: candidateId,
  candidateId,
  status,
  error: null,
  cutJobId: null,
  cutJobDisplayNumber: null,
  packetId: null,
  duplicateAcknowledged: false,
  matches: [],
});

describe('Telegram import retry state', () => {
  it('repeats every item only after a completed import', () => {
    const items = [item('44444444-4444-4444-8444-444444444444', 'imported'), item('55555555-5555-4555-8555-555555555555', 'failed')];
    expect(repeatableItems(baseRequest('completed', items))).toHaveLength(2);
  });

  it('retries only recoverable items for partial/failed requests', () => {
    const items = [
      item('44444444-4444-4444-8444-444444444444', 'imported'),
      item('55555555-5555-4555-8555-555555555555', 'failed'),
      item('66666666-6666-4666-8666-666666666666', 'unknown'),
      item('77777777-7777-4777-8777-777777777777', 'confirmation_required'),
    ];
    expect(repeatableItems(baseRequest('partial', items)).map((entry) => entry.status)).toEqual(['failed', 'unknown', 'confirmation_required']);
    expect(repeatableItems(baseRequest('failed', items)).map((entry) => entry.status)).toEqual(['failed', 'unknown', 'confirmation_required']);
  });

  it('recognizes draft and duplicate-change confirmation states', () => {
    expect(needsDuplicateReconfirmation(baseRequest('draft', [item('44444444-4444-4444-8444-444444444444', 'pending')]))).toBe(true);
    expect(needsDuplicateReconfirmation(baseRequest('processing', [item('44444444-4444-4444-8444-444444444444', 'confirmation_required')]))).toBe(true);
    expect(needsDuplicateReconfirmation(baseRequest('processing', [item('44444444-4444-4444-8444-444444444444', 'processing')]))).toBe(false);
  });
});

describe('Telegram import candidate evidence', () => {
  it('recognizes a screenshot from its message id even when Telegram has no filename', () => {
    const candidate = { screenshotFileName: null, screenshotMessageId: '11118', screenshotContentSha256: 'a'.repeat(64) };
    expect(hasCandidateScreenshot(candidate)).toBe(true);
    expect(candidateScreenshotLabel(candidate)).toBe('найден · сообщение #11118');
  });

  it('prefers a persisted filename and recognizes content hash evidence', () => {
    expect(candidateScreenshotLabel({ screenshotFileName: 'sheet.png', screenshotMessageId: '11118', screenshotContentSha256: null })).toBe('найден · sheet.png');
    expect(candidateScreenshotLabel({ screenshotFileName: null, screenshotMessageId: null, screenshotContentSha256: 'b'.repeat(64) })).toBe('найден · файл сохранён');
    expect(candidateScreenshotLabel({ screenshotFileName: null, screenshotMessageId: null, screenshotContentSha256: null })).toBe('нет');
  });

  it('derives missing summary values from persisted cut layout', () => {
    const summary = candidateLayoutSummary({
      sheetWidthMm: null,
      sheetHeightMm: null,
      sheetCount: null,
      positionCount: null,
      orderLabels: [],
      cutLayout: {
        status: 'valid',
        reasons: [],
        sheet: { widthMm: 1000, heightMm: 800 },
        items: [
          { orderName: ' 2723 ', detailNumber: 1, widthMm: 300, heightMm: 200, quantity: 1, xMm: 0, yMm: 0, placedWidthMm: 300, placedHeightMm: 200, rotated: false },
          { orderName: '2723', detailNumber: 2, widthMm: 200, heightMm: 100, quantity: 1, xMm: 300, yMm: 0, placedWidthMm: 200, placedHeightMm: 100, rotated: false },
          { orderName: '2724', detailNumber: 1, widthMm: 100, heightMm: 100, quantity: 1, xMm: 500, yMm: 0, placedWidthMm: 100, placedHeightMm: 100, rotated: false },
        ],
      },
    });
    expect(summary).toEqual({ sheetWidthMm: 1000, sheetHeightMm: 800, sheetCount: 1, positionCount: 3, orderLabels: ['2723', '2724'] });
  });
});

describe('Telegram import message projection', () => {
  const screenshot = {
    scanMessageId: 'message-2',
    scanId: 'scan-1',
    sourceChatId: '-100123',
    sourceMessageId: '11118',
    sourceCreatedAt: '2026-08-18T10:02:00.000Z',
    workday: '2026-08-18',
    messageType: 'image' as const,
    filename: null,
    mimeType: 'image/png',
    messageText: null,
    outgoing: false,
    candidateId: 'candidate-1',
    candidateRole: 'screenshot' as const,
    readOrdinal: 2,
  };

  it('keeps a screenshot row human-visible when Telegram has no filename', () => {
    expect(importMessageAttachmentLabel(screenshot)).toBe('Скриншот · имя файла не указано');
    expect(importMessageHumanContent(screenshot)).toBe('Скриншот · имя файла не указано');
    expect(importMessageTimeLabel(screenshot.sourceCreatedAt)).toMatch(/^\d{2}:\d{2}$/);
  });

  it('sorts both views chronologically, using scan order only as a tie-breaker', () => {
    const text = { ...screenshot, scanMessageId: 'message-1', sourceMessageId: '11117', messageType: 'text' as const, messageText: 'Готово', candidateId: null, candidateRole: null, readOrdinal: 1 };
    expect(sortImportMessages([screenshot, text]).map((message) => message.scanMessageId)).toEqual(['message-1', 'message-2']);

    const previousDay = { ...screenshot, scanMessageId: 'message-3', sourceCreatedAt: '2026-08-17T23:59:00.000Z', workday: '2026-08-17', readOrdinal: 99 };
    expect(sortImportMessages([text, previousDay]).map((message) => message.scanMessageId)).toEqual(['message-3', 'message-1']);
  });

  it('maps selection by candidateId and disables only non-eligible candidates', () => {
    const candidates = [
      { candidateId: 'candidate-1', eligibility: 'eligible' as const, sourceStatus: 'new' as const },
      { candidateId: 'candidate-2', eligibility: 'ineligible' as const, sourceStatus: 'new' as const },
    ];
    expect(eligibleCandidateIdForMessage(screenshot, candidates)).toBe('candidate-1');
    expect(eligibleCandidateIdForMessage({ candidateId: 'candidate-2' }, candidates)).toBeNull();
    expect(eligibleCandidateIdForMessage({ candidateId: null }, candidates)).toBeNull();
  });
});
