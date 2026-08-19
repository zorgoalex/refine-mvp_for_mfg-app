import { describe, expect, it } from 'vitest';
import type { CncTelegramImportRequest } from '../../api/types/cncTelegramImportApi.types';
import { needsDuplicateReconfirmation, repeatableItems } from './cutTelegramImportHelpers';

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
