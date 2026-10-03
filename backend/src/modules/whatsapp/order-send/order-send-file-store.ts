import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { BackendEnv } from '../../../config/env.validation';
import { ORDER_SEND_FILE_MAX_BYTES } from './order-send.types';

/** Quota of the whole `order-sends/` directory. */
export const ORDER_SEND_STORE_MAX_BYTES = 512 * 1024 * 1024;
/** An unreferenced file older than this is a crash remnant (write committed nowhere). */
const ORPHAN_AGE_MS = 60 * 60_000;
// png: pictures of the image forms (one file per page).
const KEY = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(?:pdf|xlsx|png)$/;
const TEMP = /^\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(?:pdf|xlsx|png)\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/;

export interface OrderSendStoredFile { fileKey: string; sha256: string; sizeBytes: number }

/**
 * Private files of «отправка заказа из карточки»: a separate `order-sends/` subdirectory of the
 * WhatsApp volume with its own lock, size limits and accounting. The digest and broadcast stores
 * ignore subdirectories, so their cleanup never touches these files and vice versa.
 */
@Injectable()
export class OrderSendFileStore {
  private readonly root: string;
  /** Directory quota; a property so tests can exercise the full-store refusal. */
  maxStoreBytes = ORDER_SEND_STORE_MAX_BYTES;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Optional() @Inject(ConfigService) config?: ConfigService<BackendEnv, true>,
  ) {
    this.root = join(resolve(config?.get('WHATSAPP_DAILY_DIGEST_DIR', { infer: true }) || '/data/whatsapp-daily-digest'), 'order-sends');
  }

  withStoreLock<T>(handler: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T | null> {
    return this.database.withAdvisoryLock('whatsapp-order-send-store', handler);
  }

  async write(bytes: Buffer, extension: 'pdf' | 'xlsx' | 'png', assertOwned: () => Promise<void>): Promise<OrderSendStoredFile> {
    if (bytes.byteLength < 1 || bytes.byteLength > ORDER_SEND_FILE_MAX_BYTES) {
      throw new ApiError(413, 'ORDER_SEND_FILE_TOO_LARGE', 'Файл формы больше 10 МБ');
    }
    await this.ensureRoot();
    if (await this.measureBytes() + bytes.byteLength > this.maxStoreBytes) {
      throw new ApiError(507, 'ORDER_SEND_STORAGE_FULL', 'Хранилище файлов отправки заполнено, повторите позже');
    }
    const fileKey = `${randomUUID()}.${extension}`;
    const tempPath = this.inRoot(`.${fileKey}.${randomUUID()}.tmp`, TEMP);
    await assertOwned();
    const handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await assertOwned();
      await rename(tempPath, this.inRoot(fileKey, KEY));
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return { fileKey, sha256: digest(bytes), sizeBytes: bytes.byteLength };
  }

  async read(fileKey: string, sha256: string, assertOwned: () => Promise<void>): Promise<Buffer> {
    await this.ensureRoot();
    const path = this.inRoot(fileKey, KEY);
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) throw new ApiError(404, 'ORDER_SEND_PAYLOAD_MISSING', 'Файл отправки недоступен');
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try { bytes = await handle.readFile(); } finally { await handle.close(); }
    await assertOwned();
    if (digest(bytes) !== sha256) throw new ApiError(409, 'ORDER_SEND_PAYLOAD_INVALID', 'Файл отправки повреждён');
    return bytes;
  }

  async remove(fileKey: string, assertOwned: () => Promise<void>): Promise<void> {
    await this.ensureRoot();
    await assertOwned();
    await rm(this.inRoot(fileKey, KEY), { force: true });
  }

  /**
   * Deletes the files of purged rows and unreferenced remnants older than an hour (a write whose
   * transaction rolled back after a crash). `referenced` = every file key still stored in the table.
   */
  async sweep(referenced: ReadonlySet<string>, assertOwned: () => Promise<void>, now = new Date()): Promise<string[]> {
    await this.ensureRoot();
    const removed: string[] = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const isKey = KEY.test(entry.name);
      if (!isKey && !TEMP.test(entry.name)) continue;
      if (isKey && referenced.has(entry.name)) continue;
      const info = await stat(join(this.root, entry.name)).catch(() => null);
      if (!info || now.getTime() - info.mtimeMs <= ORPHAN_AGE_MS) continue;
      await assertOwned();
      await rm(join(this.root, entry.name), { force: true });
      removed.push(entry.name);
    }
    return removed;
  }

  private async ensureRoot(): Promise<void> {
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const info = await lstat(this.root);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe directory');
      await chmod(this.root, 0o700);
      if (await realpath(this.root) !== this.root) throw new Error('unexpected root path');
    } catch {
      throw new ApiError(503, 'ORDER_SEND_STORE_UNAVAILABLE', 'Хранилище файлов отправки недоступно');
    }
  }

  private async measureBytes(): Promise<number> {
    let total = 0;
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      total += (await lstat(join(this.root, entry.name))).size;
    }
    return total;
  }

  private inRoot(name: string, pattern: RegExp): string {
    if (!pattern.test(name)) throw new ApiError(422, 'ORDER_SEND_FILE_KEY_INVALID', 'Некорректный идентификатор файла');
    const path = resolve(this.root, name);
    if (!path.startsWith(`${this.root}${sep}`)) throw new ApiError(422, 'ORDER_SEND_FILE_KEY_INVALID', 'Некорректный идентификатор файла');
    return path;
  }
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
