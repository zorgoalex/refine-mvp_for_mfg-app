import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import sharp from 'sharp';
import { ApiError } from '../../../common/errors/api-error';
import {
  openTelegramMedia,
  parseTelegramStorageKey,
  type OpenTelegramMedia,
  type TelegramMediaMetadata,
} from './telegram-media-reader';

const PREVIEW_DIRECTORY = 'previews';
const PREVIEW_WIDTH = 360;
const PREVIEW_HEIGHT = 240;
const MAX_PREVIEW_BYTES = 256 * 1024;

export async function openOrCreateTelegramPreview(
  mediaDir: string,
  source: TelegramMediaMetadata,
): Promise<OpenTelegramMedia> {
  const previewDirectory = await ensurePreviewDirectory(mediaDir);
  const previewKey = telegramPreviewKey(source.storageKey);
  try {
    return await openTelegramMedia(previewDirectory, previewMetadata(previewKey));
  } catch (error) {
    if (!(error instanceof ApiError) || !['NOT_FOUND', 'LABEL_TELEGRAM_MEDIA_INVALID'].includes(error.code)) {
      throw error;
    }
  }

  const opened = await openTelegramMedia(mediaDir, source);
  let thumbnail: Buffer;
  try {
    thumbnail = await sharp(opened.raw, {
      failOn: 'error',
      limitInputPixels: 40_000_000,
      pages: 1,
      animated: false,
    })
      .rotate()
      .resize({ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 72, chromaSubsampling: '4:2:0', mozjpeg: true })
      .toBuffer();
  } finally {
    await opened.handle.close();
  }
  if (thumbnail.length <= 0 || thumbnail.length > MAX_PREVIEW_BYTES) {
    throw new ApiError(422, 'CNC_TELEGRAM_PREVIEW_INVALID', 'Не удалось создать безопасное превью скрина', {
      reason: 'preview_size_limit',
      storageKey: source.storageKey,
    });
  }

  const target = resolve(previewDirectory, previewKey);
  const temporary = resolve(previewDirectory, `.${previewKey}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, thumbnail, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return openTelegramMedia(previewDirectory, previewMetadata(previewKey));
}

export function telegramPreviewKey(storageKey: string): string {
  const safeKey = parseTelegramStorageKey(storageKey);
  const extension = extname(safeKey);
  return `${basename(safeKey, extension)}.preview.jpg`;
}

export function telegramPreviewDirectory(mediaDir: string): string {
  return resolve(mediaDir, PREVIEW_DIRECTORY);
}

async function ensurePreviewDirectory(mediaDir: string): Promise<string> {
  const absoluteRoot = resolve(mediaDir);
  const previewDirectory = telegramPreviewDirectory(absoluteRoot);
  if (!previewDirectory.startsWith(`${absoluteRoot}/`)) {
    throw new ApiError(422, 'CNC_TELEGRAM_PREVIEW_INVALID', 'Некорректный каталог превью');
  }
  await mkdir(previewDirectory, { recursive: true, mode: 0o700 });
  const stat = await lstat(previewDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ApiError(422, 'CNC_TELEGRAM_PREVIEW_INVALID', 'Некорректный каталог превью');
  }
  return previewDirectory;
}

function previewMetadata(storageKey: string): TelegramMediaMetadata {
  return { storageKey, contentType: 'image/jpeg', sizeBytes: null };
}

export const TELEGRAM_PREVIEW_LIMITS = {
  width: PREVIEW_WIDTH,
  height: PREVIEW_HEIGHT,
  maxBytes: MAX_PREVIEW_BYTES,
} as const;
