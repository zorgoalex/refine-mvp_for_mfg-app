import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { constants } from 'node:fs';
import { mkdir, open, readdir, realpath, rename, rm, stat, lstat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { ApiError } from '../../common/errors/api-error';
import { DatabaseService } from '../../database/database.service';
import type { BackendEnv } from '../../config/env.validation';
import type { DailyDigestRenderedPage } from './daily-digest-snapshot.types';
import type { DailyDigestFileMetadata, DailyDigestStoredImage } from './daily-digest.types';

const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_RUN_BYTES = 16 * 1024 * 1024;
const MAX_STORE_BYTES = 256 * 1024 * 1024;
const MAX_PAGE_COUNT = 500;
const PAGE_INDEX_PATTERN = '(?:[1-9]|[1-9]\\d|[1-4]\\d{2}|500)';
const KEY_PATTERN = new RegExp(`^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-${PAGE_INDEX_PATTERN}\\.png$`);
const TEMP_KEY_PATTERN = new RegExp(`^\\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-${PAGE_INDEX_PATTERN}\\.png\\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\\.tmp$`);

/** Private filesystem storage. All mutations and reads are serialized against every instance. */
@Injectable()
export class DailyDigestFileStore {
  private readonly root: string;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Optional() @Inject(ConfigService) config?: ConfigService<BackendEnv, true>,
  ) {
    this.root = resolve(config?.get('WHATSAPP_DAILY_DIGEST_DIR', { infer: true }) || '/data/whatsapp-daily-digest');
  }

  withStoreLock<T>(handler: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T | null> {
    return this.database.withAdvisoryLock('whatsapp-daily-digest-store', handler);
  }

  async writePages(pages: DailyDigestRenderedPage[], expiresAt: Date, assertOwned: () => Promise<void>): Promise<DailyDigestFileMetadata[]> {
    if (!pages.length) return [];
    if (pages.length > MAX_PAGE_COUNT || pages.some((page,index)=>!Number.isSafeInteger(page.pageIndex)||page.pageIndex!==index+1||page.pageIndex>MAX_PAGE_COUNT)) {
      throw new ApiError(413, 'WHATSAPP_DAILY_DIGEST_PAGE_LIMIT', 'Рассылка превышает допустимое количество страниц');
    }
    const runBytes = pages.reduce((sum, page) => sum + page.png.byteLength, 0);
    if (runBytes > MAX_RUN_BYTES || pages.some(page => page.png.byteLength > MAX_PAGE_BYTES)) {
      throw new ApiError(413, 'WHATSAPP_DAILY_DIGEST_IMAGE_LIMIT', 'Изображения рассылки превышают допустимый размер');
    }
    await this.ensureRoot();
    const currentBytes = await this.measureBytes();
    if (currentBytes + runBytes > MAX_STORE_BYTES) {
      throw new ApiError(507, 'WHATSAPP_DAILY_DIGEST_STORE_FULL', 'Хранилище изображений рассылки заполнено');
    }

    const owned: string[] = [];
    const result: DailyDigestFileMetadata[] = [];
    try {
      for (const page of pages) {
        const fileKey = `${randomUUID()}-${page.pageIndex}.png`;
        const finalPath = this.pathFor(fileKey);
        const tempName = `.${fileKey}.${randomUUID()}.tmp`;
        const tempPath = this.tempPathFor(tempName);
        await assertOwned();
        const handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        try {
          await handle.writeFile(page.png);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await assertOwned();
        await rename(tempPath, finalPath);
        owned.push(fileKey);
        result.push({ fileKey, sha256: digest(page.png), sizeBytes: page.png.byteLength, expiresAt });
      }
      return result;
    } catch (error) {
      await Promise.all(owned.map(key => rm(this.pathFor(key), { force: true }).catch(() => undefined)));
      throw error;
    }
  }

  async readImage(fileKey: string, sha256: string, expiresAt: Date, assertOwned: () => Promise<void>, now = new Date()): Promise<DailyDigestStoredImage> {
    this.assertKey(fileKey);
    if (expiresAt.getTime() <= now.getTime()) {
      throw new ApiError(410, 'WHATSAPP_DAILY_DIGEST_IMAGE_EXPIRED', 'Срок хранения изображения рассылки истёк');
    }
    await this.ensureRoot();
    const path = this.pathFor(fileKey);
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) {
      throw new ApiError(404, 'WHATSAPP_DAILY_DIGEST_IMAGE_MISSING', 'Изображение рассылки недоступно');
    }
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try { bytes = await handle.readFile(); } finally { await handle.close(); }
    await assertOwned();
    if (digest(bytes) !== sha256) {
      throw new ApiError(409, 'WHATSAPP_DAILY_DIGEST_IMAGE_INVALID', 'Изображение рассылки повреждено');
    }
    return { bytes, expiresAt };
  }

  async remove(fileKey: string, assertOwned: () => Promise<void>): Promise<void> {
    this.assertKey(fileKey);
    await this.ensureRoot();
    await assertOwned();
    await rm(this.pathFor(fileKey), { force: true });
  }

  /** Remove expired files and old unreferenced crash remnants; caller must hold store lease. */
  async sweep(referenced: ReadonlyMap<string, Date>, expiredKeys: readonly string[], assertOwned: () => Promise<void>, now = new Date()): Promise<{ expired: string[]; orphaned: string[] }> {
    await this.ensureRoot();
    const expired: string[] = [];
    const orphaned: string[] = [];
    const entries = await readdir(this.root, { withFileTypes: true });
    for (const fileKey of expiredKeys) {
      if (!KEY_PATTERN.test(fileKey)) continue;
      await assertOwned();
      await rm(this.pathFor(fileKey), { force: true });
      expired.push(fileKey);
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(this.root, entry.name);
      if (entry.isFile() && KEY_PATTERN.test(entry.name)) {
        const expiresAt = referenced.get(entry.name);
        if (expiresAt && expiresAt.getTime() <= now.getTime()) {
          await assertOwned();
          await rm(path, { force: true });
          expired.push(entry.name);
        } else if (!expiresAt) {
          const info = await stat(path).catch(() => null);
          if (info && now.getTime() - info.mtimeMs > 10 * 60_000) {
            await assertOwned();
            await rm(path, { force: true });
            orphaned.push(entry.name);
          }
        }
      } else if (entry.isFile() && entry.name.endsWith('.tmp')) {
        const info = await stat(path).catch(() => null);
        if (info && now.getTime() - info.mtimeMs > 10 * 60_000) { await assertOwned(); await rm(path, { force: true }); }
      }
    }
    // Expiration is enforced from DB metadata by the repository. This return is intentionally
    // limited to orphan files; caller supplies only currently-live referenced keys.
    return { expired, orphaned };
  }

  private async ensureRoot(): Promise<void> {
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const info = await lstat(this.root);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe directory');
      await chmodDir(this.root);
      const actual = await realpath(this.root);
      if (actual !== this.root) throw new Error('unexpected root path');
    } catch {
      throw new ApiError(503, 'WHATSAPP_DAILY_DIGEST_STORE_UNAVAILABLE', 'Хранилище изображений рассылки недоступно');
    }
  }

  private async measureBytes(): Promise<number> {
    const entries = await readdir(this.root, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const info = await lstat(join(this.root, entry.name));
      if (info.isSymbolicLink()) throw new ApiError(503, 'WHATSAPP_DAILY_DIGEST_STORE_UNAVAILABLE', 'Хранилище изображений рассылки недоступно');
      total += info.size;
    }
    return total;
  }

  private pathFor(fileKey: string): string {
    if (!KEY_PATTERN.test(fileKey)) throw new ApiError(422, 'WHATSAPP_DAILY_DIGEST_FILE_KEY_INVALID', 'Некорректный идентификатор изображения');
    const path = resolve(this.root, fileKey);
    if (!path.startsWith(`${this.root}${sep}`)) throw new ApiError(422, 'WHATSAPP_DAILY_DIGEST_FILE_KEY_INVALID', 'Некорректный идентификатор изображения');
    return path;
  }

  private assertKey(fileKey: string): void {
    if (!KEY_PATTERN.test(fileKey)) throw new ApiError(422, 'WHATSAPP_DAILY_DIGEST_FILE_KEY_INVALID', 'Некорректный идентификатор изображения');
  }

  private tempPathFor(name: string): string {
    if (!TEMP_KEY_PATTERN.test(name)) {
      throw new ApiError(422, 'WHATSAPP_DAILY_DIGEST_FILE_KEY_INVALID', 'Некорректный идентификатор изображения');
    }
    const path = resolve(this.root, name);
    if (!path.startsWith(`${this.root}${sep}`)) throw new ApiError(422, 'WHATSAPP_DAILY_DIGEST_FILE_KEY_INVALID', 'Некорректный идентификатор изображения');
    return path;
  }
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function chmodDir(path: string): Promise<void> {
  const { chmod } = await import('node:fs/promises');
  await chmod(path, 0o700);
}
