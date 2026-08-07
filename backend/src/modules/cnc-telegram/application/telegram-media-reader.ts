import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { ApiError } from '../../../common/errors/api-error';

const STORAGE_KEY_RE = /^[A-Za-z0-9._-]{1,220}$/;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const MAX_SIDE = 16_384;
const MAX_NORMALIZED_BYTES = 512 * 1024;

export interface TelegramMediaMetadata {
  storageKey: string;
  contentType: string | null;
  sizeBytes: number | null;
}

export interface OpenTelegramMedia {
  storageKey: string;
  absolutePath: string;
  handle: FileHandle;
  raw: Buffer;
  rawSha256: string;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  identity: string;
  sizeBytes: number;
}

export interface PreparedTelegramImage extends OpenTelegramMedia {
  normalized: Buffer;
  normalizedSha256: string;
  dataUri: string;
}

export async function openTelegramMedia(
  mediaDir: string,
  metadata: TelegramMediaMetadata,
): Promise<OpenTelegramMedia> {
  const storageKey = parseTelegramStorageKey(metadata.storageKey);
  const absoluteDir = resolve(mediaDir);
  const absolutePath = resolve(absoluteDir, storageKey);
  if (!absolutePath.startsWith(`${absoluteDir}/`)) throw invalidMedia('path_outside_media_dir', storageKey);
  let before;
  try {
    before = await lstat(absolutePath);
  } catch {
    throw new ApiError(404, 'NOT_FOUND', 'CNC Telegram media file not found', { storageKey });
  }
  if (!before.isFile() || before.isSymbolicLink()) throw invalidMedia('not_regular_file', storageKey);
  if (before.size <= 0 || before.size > MAX_SOURCE_BYTES) throw invalidMedia('source_size_limit', storageKey);
  const handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) {
      throw invalidMedia('file_changed_during_open', storageKey);
    }
    if (metadata.sizeBytes !== null && metadata.sizeBytes !== stat.size) {
      throw invalidMedia('stored_size_mismatch', storageKey);
    }
    const raw = await readHandleAll(handle, stat.size);
    if (raw.length !== stat.size) throw invalidMedia('truncated_read', storageKey);
    const contentType = detectContentType(raw, storageKey);
    if (metadata.contentType && normalizeTelegramMediaContentType(metadata.contentType) !== contentType) {
      throw invalidMedia('stored_content_type_mismatch', storageKey);
    }
    return {
      storageKey,
      absolutePath,
      handle,
      raw,
      rawSha256: sha256(raw),
      contentType,
      identity: fileIdentity(stat),
      sizeBytes: stat.size,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function prepareTelegramImage(
  mediaDir: string,
  metadata: TelegramMediaMetadata,
): Promise<PreparedTelegramImage> {
  const opened = await openTelegramMedia(mediaDir, metadata);
  try {
    const pipeline = sharp(opened.raw, {
      failOn: 'error',
      limitInputPixels: MAX_PIXELS,
      pages: 1,
      animated: false,
    });
    const info = await pipeline.metadata();
    if (!info.width || !info.height || info.width > MAX_SIDE || info.height > MAX_SIDE) {
      throw invalidMedia('image_dimensions_limit', metadata.storageKey);
    }
    if ((info.pages ?? 1) !== 1) throw invalidMedia('animated_or_multipage', metadata.storageKey);
    const normalized = await pipeline
      .rotate()
      .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: true, colours: 256, effort: 10 })
      .toBuffer();
    if (normalized.length <= 0 || normalized.length > MAX_NORMALIZED_BYTES) {
      throw invalidMedia('normalized_size_limit', metadata.storageKey);
    }
    const normalizedSha256 = sha256(normalized);
    return {
      ...opened,
      normalized,
      normalizedSha256,
      dataUri: `data:image/png;base64,${normalized.toString('base64')}`,
    };
  } catch (error) {
    await opened.handle.close();
    throw error;
  }
}

export async function validateTelegramImage(
  mediaDir: string,
  metadata: TelegramMediaMetadata,
): Promise<OpenTelegramMedia> {
  const opened = await openTelegramMedia(mediaDir, metadata);
  try {
    const info = await sharp(opened.raw, {
      failOn: 'error',
      limitInputPixels: MAX_PIXELS,
      pages: 1,
      animated: false,
    }).metadata();
    if (!info.width || !info.height || info.width > MAX_SIDE || info.height > MAX_SIDE) {
      throw invalidMedia('image_dimensions_limit', metadata.storageKey);
    }
    if ((info.pages ?? 1) !== 1) throw invalidMedia('animated_or_multipage', metadata.storageKey);
    return opened;
  } catch (error) {
    await opened.handle.close();
    throw error;
  }
}

export async function verifyPreparedTelegramImage(prepared: PreparedTelegramImage): Promise<void> {
  let currentHandle: FileHandle;
  try {
    currentHandle = await open(prepared.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw invalidMedia('file_path_changed', prepared.storageKey);
  }
  try {
    const [retainedStat, currentStat] = await Promise.all([prepared.handle.stat(), currentHandle.stat()]);
    if (
      !currentStat.isFile()
      || fileIdentity(retainedStat) !== prepared.identity
      || fileIdentity(currentStat) !== prepared.identity
      || retainedStat.size !== prepared.sizeBytes
      || currentStat.size !== prepared.sizeBytes
    ) {
      throw invalidMedia('file_identity_changed', prepared.storageKey);
    }
  } finally {
    await currentHandle.close();
  }
  const raw = await readHandleAll(prepared.handle, prepared.sizeBytes);
  if (raw.length !== prepared.sizeBytes || sha256(raw) !== prepared.rawSha256) {
    throw invalidMedia('file_digest_changed', prepared.storageKey);
  }
}

export async function closePreparedTelegramImages(images: Iterable<PreparedTelegramImage>): Promise<void> {
  await Promise.allSettled([...images].map((image) => image.handle.close()));
}

export function parseTelegramStorageKey(value: string): string {
  const normalized = value.trim();
  if (!STORAGE_KEY_RE.test(normalized) || basename(normalized) !== normalized || !IMAGE_EXTENSIONS.has(extname(normalized).toLowerCase())) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid CNC Telegram media key', { field: 'storageKey' });
  }
  return normalized;
}

function detectContentType(raw: Buffer, storageKey: string): OpenTelegramMedia['contentType'] {
  const extension = extname(storageKey).toLowerCase();
  if (raw.length >= 3 && raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff && (extension === '.jpg' || extension === '.jpeg')) {
    return 'image/jpeg';
  }
  if (raw.length >= 8 && raw.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && extension === '.png') {
    return 'image/png';
  }
  if (raw.length >= 12 && raw.subarray(0, 4).toString('ascii') === 'RIFF' && raw.subarray(8, 12).toString('ascii') === 'WEBP' && extension === '.webp') {
    return 'image/webp';
  }
  throw invalidMedia('magic_extension_mismatch', storageKey);
}

export function normalizeTelegramMediaContentType(
  value: string | null | undefined,
): OpenTelegramMedia['contentType'] | null {
  if (value == null) return null;
  const normalized = value.split(';', 1)[0]?.trim().toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'image/jpeg';
  if (normalized === 'image/png') return 'image/png';
  if (normalized === 'image/webp') return 'image/webp';
  return null;
}

function fileIdentity(stat: { dev: number | bigint; ino: number | bigint; size: number | bigint; mtimeMs: number }): string {
  return `${String(stat.dev)}:${String(stat.ino)}:${String(stat.size)}:${stat.mtimeMs}`;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function readHandleAll(handle: FileHandle, size: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(buffer, offset, size - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  return offset === size ? buffer : buffer.subarray(0, offset);
}

function invalidMedia(reason: string, storageKey: string): ApiError {
  return new ApiError(422, 'LABEL_TELEGRAM_MEDIA_INVALID', 'Telegram cut-map image is unavailable', { reason, storageKey });
}

export const TELEGRAM_IMAGE_LIMITS = {
  maxSourceBytes: MAX_SOURCE_BYTES,
  maxNormalizedBytes: MAX_NORMALIZED_BYTES,
} as const;
