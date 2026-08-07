import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  openOrCreateTelegramPreview,
  TELEGRAM_PREVIEW_LIMITS,
  telegramPreviewDirectory,
  telegramPreviewKey,
} from './telegram-thumbnail-store';

describe('Telegram thumbnail store', () => {
  it('creates and reuses a bounded persistent JPEG preview', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'telegram-preview-'));
    const source = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: '#2f6fed' },
    }).png().toBuffer();
    await writeFile(join(directory, 'tg_chat_10.png'), source);

    const metadata = { storageKey: 'tg_chat_10.png', contentType: 'image/png', sizeBytes: source.length };
    const first = await openOrCreateTelegramPreview(directory, metadata);
    const firstRaw = first.raw;
    await first.handle.close();
    const second = await openOrCreateTelegramPreview(directory, metadata);
    await second.handle.close();

    expect(first.storageKey).toBe('tg_chat_10.preview.jpg');
    expect(first.contentType).toBe('image/jpeg');
    expect(firstRaw.length).toBeLessThanOrEqual(TELEGRAM_PREVIEW_LIMITS.maxBytes);
    expect(second.raw.equals(firstRaw)).toBe(true);
    const info = await sharp(firstRaw).metadata();
    expect(info.width).toBeLessThanOrEqual(TELEGRAM_PREVIEW_LIMITS.width);
    expect(info.height).toBeLessThanOrEqual(TELEGRAM_PREVIEW_LIMITS.height);
    expect((await stat(join(telegramPreviewDirectory(directory), first.storageKey))).isFile()).toBe(true);
  });

  it('derives a basename-only preview key', () => {
    expect(telegramPreviewKey('tg_100_10.webp')).toBe('tg_100_10.preview.jpg');
    expect(() => telegramPreviewKey('../secret.jpg')).toThrow();
  });

  it('does not silently reuse a corrupted preview', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'telegram-preview-corrupt-'));
    const source = await sharp({
      create: { width: 20, height: 20, channels: 3, background: '#ffffff' },
    }).png().toBuffer();
    await writeFile(join(directory, 'tg_chat_11.png'), source);
    const previewDirectory = telegramPreviewDirectory(directory);
    await import('node:fs/promises').then(({ mkdir }) => mkdir(previewDirectory, { recursive: true }));
    await writeFile(join(previewDirectory, 'tg_chat_11.preview.jpg'), Buffer.from('not-an-image'));

    const opened = await openOrCreateTelegramPreview(directory, {
      storageKey: 'tg_chat_11.png', contentType: 'image/png', sizeBytes: source.length,
    });
    await opened.handle.close();
    expect((await readFile(join(previewDirectory, 'tg_chat_11.preview.jpg'))).subarray(0, 3))
      .toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });
});
