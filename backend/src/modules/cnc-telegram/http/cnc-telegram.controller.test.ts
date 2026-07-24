import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import { parseDateQuery, parseIdempotencyKey, parseStructuredIngest } from './cnc-telegram.controller';

describe('CncTelegramController parsing', () => {
  it('accepts structured packet ingest and rejects raw fields', () => {
    const payload = structuredPayload();

    expect(parseStructuredIngest(payload, 'cnc:test:1')).toMatchObject({
      idempotencyKey: 'cnc:test:1',
      externalPacketKey: 'chat:-100:message:10',
      source: { version: 2 },
      items: [{ orderName: '2689', detailNumber: 31 }],
    });

    expect(() =>
      parseStructuredIngest({
        ...payload,
        rawGcodeText: 'G1 X0 Y0',
      }, 'cnc:test:1'),
    ).toThrow(ApiError);
    expect(() =>
      parseStructuredIngest({
        ...payload,
        idempotencyKey: 'cnc:test:body',
      }, 'cnc:test:1'),
    ).toThrow(ApiError);
  });

  it('reads idempotency only from the Idempotency-Key header', () => {
    expect(parseIdempotencyKey('  cnc:test:header  ')).toBe('cnc:test:header');
    expect(parseIdempotencyKey(['cnc:test:first', 'cnc:test:second'])).toBe('cnc:test:first');
    expect(() => parseIdempotencyKey(undefined)).toThrow(ApiError);
    expect(() => parseIdempotencyKey('short')).toThrow(ApiError);
  });

  it('keeps match ids coherent in structured rows', () => {
    const payload = structuredPayload();
    expect(() =>
      parseStructuredIngest({
        ...payload,
        items: [{
          ...payload.items[0],
          matchStatus: 'matched',
          matchDetailId: null,
        }],
      }, 'cnc:test:1'),
    ).toThrow(ApiError);
    expect(() =>
      parseStructuredIngest({
        ...payload,
        items: [{
          ...payload.items[0],
          matchStatus: 'unmatched',
          matchOrderId: 2689,
          matchDetailId: null,
        }],
      }, 'cnc:test:1'),
    ).toThrow(ApiError);
  });

  it('validates date-only query values', () => {
    expect(parseDateQuery(undefined)).toBeNull();
    expect(parseDateQuery('2026-07-24')).toBe('2026-07-24');
    expect(() => parseDateQuery('24.07.2026')).toThrow(ApiError);
    expect(() => parseDateQuery('2026-02-30')).toThrow(ApiError);
  });
});

function structuredPayload() {
  return {
    externalPacketKey: 'chat:-100:message:10',
    source: {
      chatId: '-100',
      messageId: 10,
      version: 2,
      updatedAt: '2026-07-24T08:00:00.000Z',
    },
    workday: '2026-07-24',
    machine: 'CNC#1',
    programName: 'CNC#1_2689-HDF.TXT',
    materialName: 'ХДФ',
    parseStatus: 'parsed',
    thumbsUp: true,
    comments: ['ХДФ!!!'],
    tools: [{ toolNumber: 8, spindleRpm: 15000 }],
    items: [
      {
        sourceItemKey: '2689:31:497x477',
        orderName: '2689',
        detailNumber: 31,
        widthMm: 497,
        heightMm: 477,
        quantity: 4,
        source: 'ocr',
        confidence: 0.94,
        matchOrderId: 2689,
        matchDetailId: 3101,
        matchStatus: 'matched',
      },
    ],
  };
}
