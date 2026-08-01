import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class Bitrix24TokenCipher {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = decodeKey(base64Key);
  }

  encrypt(plaintext: string): string {
    if (!plaintext) throw new Error('Bitrix24 token cannot be empty');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString('base64url'),
      ciphertext.toString('base64url'),
      tag.toString('base64url'),
    ].join('.');
  }

  decrypt(value: string): string {
    const [version, ivRaw, ciphertextRaw, tagRaw, extra] = value.split('.');
    if (
      version !== VERSION ||
      !ivRaw ||
      !ciphertextRaw ||
      !tagRaw ||
      extra !== undefined
    ) {
      throw new Error('Invalid encrypted Bitrix24 token');
    }

    const iv = Buffer.from(ivRaw, 'base64url');
    const ciphertext = Buffer.from(ciphertextRaw, 'base64url');
    const tag = Buffer.from(tagRaw, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ciphertext.length === 0) {
      throw new Error('Invalid encrypted Bitrix24 token');
    }

    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error('Invalid encrypted Bitrix24 token');
    }
  }
}

export function hashBitrix24ApplicationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function matchesBitrix24ApplicationToken(
  token: string,
  expectedHash: string,
): boolean {
  const actual = Buffer.from(hashBitrix24ApplicationToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return (
    actual.length === expected.length &&
    expected.length === 32 &&
    timingSafeEqual(actual, expected)
  );
}

function decodeKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  const canonical = key.toString('base64').replace(/=+$/, '');
  if (key.length !== 32 || canonical !== base64Key.replace(/=+$/, '')) {
    throw new Error('Bitrix24 token encryption key must be exactly 32 bytes');
  }
  return key;
}
