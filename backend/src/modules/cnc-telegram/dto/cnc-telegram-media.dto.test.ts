import { describe, expect, it } from 'vitest';
import {
  parseCncTelegramMediaRestoreComplete,
  parseCncTelegramMediaRestoreFailure,
  parseCncTelegramMediaRestoreRequestId,
} from './cnc-telegram-media.dto';

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

const itemLease = {
  itemLeaseToken: 'lease-token-that-is-longer-than-32-characters',
  itemLeaseGeneration: 1,
  itemLeaseOwner: '00000000-0000-4000-8000-000000000001',
};
