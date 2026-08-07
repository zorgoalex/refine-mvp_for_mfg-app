import { describe, expect, it } from 'vitest';
import {
  parseCncTelegramMediaRestoreComplete,
  parseCncTelegramMediaRestoreFailure,
  parseCncTelegramMediaRestoreRequestId,
} from './cnc-telegram-media.dto';

describe('CNC Telegram media restore DTO', () => {
  it('accepts bounded worker completion metadata', () => {
    expect(parseCncTelegramMediaRestoreComplete({
      storageKey: 'tg_100_10847.jpg', contentType: 'image/jpeg', sizeBytes: 1234,
    })).toEqual({ storageKey: 'tg_100_10847.jpg', contentType: 'image/jpeg', sizeBytes: 1234 });
    expect(() => parseCncTelegramMediaRestoreComplete({
      storageKey: '../secret.jpg', contentType: 'image/jpeg', sizeBytes: 1234,
    })).toThrow();
    expect(() => parseCncTelegramMediaRestoreComplete({
      storageKey: 'tg_100_10847.png', contentType: 'image/jpeg', sizeBytes: 1234,
    })).toThrow();
    expect(() => parseCncTelegramMediaRestoreComplete({
      storageKey: 'tg_100_10847', contentType: 'image/jpeg', sizeBytes: 1234,
    })).toThrow();
  });

  it('bounds failure messages and validates request UUIDs', () => {
    expect(parseCncTelegramMediaRestoreFailure({ error: 'message deleted' })).toBe('message deleted');
    expect(() => parseCncTelegramMediaRestoreFailure({ error: 'x'.repeat(501) })).toThrow();
    expect(parseCncTelegramMediaRestoreRequestId('00000000-0000-4000-8000-000000000002'))
      .toBe('00000000-0000-4000-8000-000000000002');
    expect(() => parseCncTelegramMediaRestoreRequestId('nope')).toThrow();
  });
});
