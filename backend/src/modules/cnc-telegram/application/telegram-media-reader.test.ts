import { mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseTelegramStorageKey,
  prepareTelegramImage,
  TELEGRAM_IMAGE_LIMITS,
  validateTelegramImage,
  verifyPreparedTelegramImage,
} from './telegram-media-reader';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Telegram media reader guards', () => {
  it('accepts only strict image basenames', () => {
    expect(parseTelegramStorageKey('packet-1.jpg')).toBe('packet-1.jpg');
    expect(() => parseTelegramStorageKey('../packet-1.jpg')).toThrow();
    expect(() => parseTelegramStorageKey('packet-1.svg')).toThrow();
  });

  it('keeps source and normalized caps bounded', () => {
    expect(TELEGRAM_IMAGE_LIMITS.maxSourceBytes).toBe(12 * 1024 * 1024);
    expect(TELEGRAM_IMAGE_LIMITS.maxNormalizedBytes).toBe(512 * 1024);
  });

  it('decodes and deterministically normalizes a valid raster', async () => {
    const directory = await tempDirectory();
    const source = await sharp({
      create: { width: 32, height: 16, channels: 3, background: '#1677ff' },
    }).jpeg().toBuffer();
    await writeFile(join(directory, 'sheet.jpg'), source);

    const first = await prepareTelegramImage(directory, {
      storageKey: 'sheet.jpg', contentType: 'image/jpeg', sizeBytes: source.length,
    });
    const second = await prepareTelegramImage(directory, {
      storageKey: 'sheet.jpg', contentType: 'image/jpeg', sizeBytes: source.length,
    });
    try {
      expect(first.normalized.equals(second.normalized)).toBe(true);
      expect(first.dataUri).toMatch(/^data:image\/png;base64,/);
      await expect(verifyPreparedTelegramImage(first)).resolves.toBeUndefined();
    } finally {
      await Promise.all([first.handle.close(), second.handle.close()]);
    }
  });

  it('validates image metadata without producing a normalized render asset', async () => {
    const directory = await tempDirectory();
    const source = await sharp({
      create: { width: 32, height: 16, channels: 3, background: '#1677ff' },
    }).png().toBuffer();
    await writeFile(join(directory, 'sheet.png'), source);

    const opened = await validateTelegramImage(directory, {
      storageKey: 'sheet.png', contentType: 'image/png', sizeBytes: source.length,
    });
    try {
      expect(opened.raw.equals(source)).toBe(true);
      expect('normalized' in opened).toBe(false);
    } finally {
      await opened.handle.close();
    }
  });

  it('rejects symlinks, MIME mismatch, and corrupt image bodies', async () => {
    const directory = await tempDirectory();
    const source = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#ffffff' },
    }).png().toBuffer();
    const outside = join(directory, 'outside.png');
    await writeFile(outside, source);
    await symlink(outside, join(directory, 'link.png'));
    await writeFile(join(directory, 'corrupt.png'), Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from('not-a-png'),
    ]));

    await expect(prepareTelegramImage(directory, {
      storageKey: 'link.png', contentType: 'image/png', sizeBytes: source.length,
    })).rejects.toMatchObject({ code: 'LABEL_TELEGRAM_MEDIA_INVALID' });
    await expect(prepareTelegramImage(directory, {
      storageKey: 'outside.png', contentType: 'image/jpeg', sizeBytes: source.length,
    })).rejects.toMatchObject({ code: 'LABEL_TELEGRAM_MEDIA_INVALID' });
    await expect(prepareTelegramImage(directory, {
      storageKey: 'corrupt.png', contentType: 'image/png', sizeBytes: null,
    })).rejects.toBeTruthy();
  });

  it('detects same-path replacement and in-place rewrite after preparation', async () => {
    const directory = await tempDirectory();
    const path = join(directory, 'sheet.png');
    const source = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#000000' },
    }).png().toBuffer();
    await writeFile(path, source);
    const replaced = await prepareTelegramImage(directory, {
      storageKey: 'sheet.png', contentType: 'image/png', sizeBytes: source.length,
    });
    await rename(path, join(directory, 'old.png'));
    await writeFile(path, source);
    try {
      await expect(verifyPreparedTelegramImage(replaced)).rejects.toMatchObject({
        code: 'LABEL_TELEGRAM_MEDIA_INVALID',
      });
    } finally {
      await replaced.handle.close();
    }

    const rewritten = await prepareTelegramImage(directory, {
      storageKey: 'sheet.png', contentType: 'image/png', sizeBytes: source.length,
    });
    const changed = Buffer.from(source);
    changed[changed.length - 1] ^= 1;
    await writeFile(path, changed);
    try {
      await expect(verifyPreparedTelegramImage(rewritten)).rejects.toMatchObject({
        code: 'LABEL_TELEGRAM_MEDIA_INVALID',
      });
    } finally {
      await rewritten.handle.close();
    }
  });
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'telegram-media-reader-'));
  temporaryDirectories.push(directory);
  return directory;
}
