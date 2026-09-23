import { describe, expect, it } from 'vitest';
import {
  parseCncTelegramManualSvgTelegramSendComplete,
  parseCncTelegramMediaRestoreComplete,
  parseCncTelegramMediaRestoreFailure,
  parseCncTelegramMediaRestoreRequestId,
} from './cnc-telegram-media.dto';

const itemLease = {
  itemLeaseToken: 'lease-token-that-is-longer-than-32-characters',
  itemLeaseGeneration: 1,
  itemLeaseOwner: '00000000-0000-4000-8000-000000000001',
};

describe('CNC Telegram media restore DTO', () => {
  it('accepts bounded worker completion metadata', () => {
    expect(parseCncTelegramMediaRestoreComplete({
      storageKey: 'tg_100_10847.jpg', contentType: 'image/jpeg', sizeBytes: 1234, ...itemLease,
    })).toEqual({ storageKey: 'tg_100_10847.jpg', contentType: 'image/jpeg', sizeBytes: 1234, ...itemLease });
    expect(() => parseCncTelegramMediaRestoreComplete({
      storageKey: '../secret.jpg', contentType: 'image/jpeg', sizeBytes: 1234, ...itemLease,
    })).toThrow();
    expect(() => parseCncTelegramMediaRestoreComplete({
      storageKey: 'tg_100_10847.png', contentType: 'image/jpeg', sizeBytes: 1234, ...itemLease,
    })).toThrow();
    expect(() => parseCncTelegramMediaRestoreComplete({
      storageKey: 'tg_100_10847', contentType: 'image/jpeg', sizeBytes: 1234, ...itemLease,
    })).toThrow();
  });

  it('bounds failure messages and validates request UUIDs', () => {
    expect(parseCncTelegramMediaRestoreFailure({ error: 'message deleted', ...itemLease }))
      .toEqual({ error: 'message deleted', ...itemLease });
    expect(() => parseCncTelegramMediaRestoreFailure({ error: 'x'.repeat(501), ...itemLease })).toThrow();
    expect(parseCncTelegramMediaRestoreRequestId('00000000-0000-4000-8000-000000000002'))
      .toBe('00000000-0000-4000-8000-000000000002');
    expect(() => parseCncTelegramMediaRestoreRequestId('nope')).toThrow();
  });
});

describe('manual SVG send observation completion DTO', () => {
  const base = {
    sentChatId: '-100123',
    sentMessageIds: ['9002', '9001', '9003', '9004'],
    ...itemLease,
  };
  const sentFiles = [
    { fileId: '00000000-0000-4000-8000-000000000011', messageId: '9001', sourceSha256: 'a'.repeat(64), mediaSha256: 'a'.repeat(64) },
    // The image may be recompressed as a Telegram photo; preserve both hashes.
    { fileId: '00000000-0000-4000-8000-000000000013', messageId: '9003', sourceSha256: 'c'.repeat(64), mediaSha256: 'd'.repeat(64) },
    { fileId: '00000000-0000-4000-8000-000000000012', messageId: '9002', sourceSha256: 'b'.repeat(64), mediaSha256: 'b'.repeat(64) },
  ];

  it('keeps old-worker completions valid without granting a binding', () => {
    expect(parseCncTelegramManualSvgTelegramSendComplete(base)).toEqual(base);
  });

  it('accepts explicit per-file bindings independent of array order and separates comment IDs', () => {
    expect(parseCncTelegramManualSvgTelegramSendComplete({ ...base, sentFiles })).toEqual({ ...base, sentFiles });
    // sentMessageIds includes the optional comment; sentFiles is the 1:1 media mapping only.
    expect(sentFiles.some((file) => file.messageId === '9004')).toBe(false);
    expect(parseCncTelegramManualSvgTelegramSendComplete({
      ...base,
      sentFiles: [{ ...sentFiles[0], sourceSha256: 'A'.repeat(64), mediaSha256: 'B'.repeat(64) }],
    }).sentFiles?.[0]).toMatchObject({ sourceSha256: 'a'.repeat(64), mediaSha256: 'b'.repeat(64) });
  });

  it('accepts a bounded post-send media verification failure without pretending it is a sent file map', () => {
    expect(parseCncTelegramManualSvgTelegramSendComplete({
      ...base,
      observationBindingError: 'MEDIA_VERIFICATION_FAILED',
    })).toMatchObject({ observationBindingError: 'MEDIA_VERIFICATION_FAILED' });
    expect(() => parseCncTelegramManualSvgTelegramSendComplete({
      ...base,
      sentFiles,
      observationBindingError: 'MEDIA_VERIFICATION_FAILED',
    })).toThrow();
    expect(() => parseCncTelegramManualSvgTelegramSendComplete({
      ...base,
      observationBindingError: 'FETCH_TIMEOUT',
    })).toThrow();
  });

  it('bounds and validates every explicit file identity and both SHA-256 values', () => {
    expect(() => parseCncTelegramManualSvgTelegramSendComplete({
      ...base,
      sentFiles: [...sentFiles, { ...sentFiles[0], fileId: '00000000-0000-4000-8000-000000000014', messageId: '9005' }],
      sentMessageIds: [...base.sentMessageIds, '9005'],
    })).toThrow();
    expect(() => parseCncTelegramManualSvgTelegramSendComplete({
      ...base,
      sentFiles: [sentFiles[0], { ...sentFiles[1], fileId: sentFiles[0].fileId }],
    })).toThrow();
    expect(() => parseCncTelegramManualSvgTelegramSendComplete({
      ...base,
      sentFiles: [sentFiles[0], { ...sentFiles[1], messageId: sentFiles[0].messageId }],
    })).toThrow();
    expect(() => parseCncTelegramManualSvgTelegramSendComplete({
      ...base,
      sentFiles: [{ ...sentFiles[0], mediaSha256: 'g'.repeat(64) }],
    })).toThrow();
    expect(() => parseCncTelegramManualSvgTelegramSendComplete({
      ...base,
      sentFiles: [{ ...sentFiles[0], messageId: '9999' }],
    })).toThrow();
    expect(() => parseCncTelegramManualSvgTelegramSendComplete({
      ...base,
      sentFiles: [{ ...sentFiles[0], messageId: '2147483648' }],
    })).toThrow();
    expect(() => parseCncTelegramManualSvgTelegramSendComplete({
      ...base,
      sentFiles: [{ ...sentFiles[0], messageId: '01' }],
    })).toThrow();
    for (const messageId of ['abc', '1.5', '+1', ' 1', '-1', '']) {
      expect(() => parseCncTelegramManualSvgTelegramSendComplete({
        ...base,
        sentFiles: [{ ...sentFiles[0], messageId }],
      })).toThrow();
    }
  });
});
