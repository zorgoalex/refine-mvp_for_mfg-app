import { describe, expect, it } from 'vitest';
import {
  Bitrix24TokenCipher,
  hashBitrix24ApplicationToken,
  matchesBitrix24ApplicationToken,
} from './bitrix24-token-cipher';

const key = Buffer.alloc(32, 7).toString('base64');

describe('Bitrix24TokenCipher', () => {
  it('round-trips without exposing plaintext', () => {
    const cipher = new Bitrix24TokenCipher(key);
    const encrypted = cipher.encrypt('secret-token');
    expect(encrypted).not.toContain('secret-token');
    expect(cipher.decrypt(encrypted)).toBe('secret-token');
  });

  it('rejects tampered ciphertext', () => {
    const cipher = new Bitrix24TokenCipher(key);
    const encrypted = cipher.encrypt('secret-token');
    const parts = encrypted.split('.');
    const ciphertext = Buffer.from(parts[2], 'base64url');
    ciphertext[0] ^= 1;
    parts[2] = ciphertext.toString('base64url');
    const tampered = parts.join('.');
    expect(() => cipher.decrypt(tampered)).toThrow('Invalid encrypted Bitrix24 token');
  });

  it('requires a canonical 32-byte key', () => {
    expect(() => new Bitrix24TokenCipher(Buffer.alloc(16).toString('base64')))
      .toThrow('exactly 32 bytes');
    expect(() => new Bitrix24TokenCipher('not-base64')).toThrow('exactly 32 bytes');
  });

  it('matches application tokens through a fixed-size hash', () => {
    const hash = hashBitrix24ApplicationToken('application-secret');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(matchesBitrix24ApplicationToken('application-secret', hash)).toBe(true);
    expect(matchesBitrix24ApplicationToken('wrong', hash)).toBe(false);
    expect(matchesBitrix24ApplicationToken('application-secret', 'bad')).toBe(false);
  });
});
