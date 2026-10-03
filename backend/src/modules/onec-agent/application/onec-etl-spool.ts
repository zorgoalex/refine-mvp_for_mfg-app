import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { ONEC_ETL_LIMITS } from '../domain/onec-etl';

export type EtlLimits = Pick<typeof ONEC_ETL_LIMITS, 'maxCompressedBytes' | 'maxUncompressedBytes' | 'maxRows' | 'maxLineBytes'>;

/**
 * Batch files on the spool volume. Every upload attempt writes its own file
 * (`<batchId>.<attemptToken>.part` → `.ndjson.gz`), so an attempt never
 * overwrites or deletes another attempt's file (plan §6.5).
 */

export class EtlLimitError extends Error {
  constructor(readonly code: 'BATCH_LIMIT_EXCEEDED' | 'BATCH_GZIP_INVALID' | 'BATCH_LINE_TOO_LONG', message: string) {
    super(message);
  }
}

/**
 * File names start with `<sourceId>.<entityCode>.` so every file of an entity can be found on disk
 * without any database record (revocation cleanup, plan §21.3): a lost row never hides a file.
 */
export interface SpoolKey {
  sourceId: number;
  entityCode: string;
  batchId: string;
  token: string;
}

export function entityFilePrefix(sourceId: number, entityCode: string): string {
  return `${sourceId}.${entityCode}.`;
}

export function partPath(dir: string, key: SpoolKey): string {
  return path.join(dir, `${entityFilePrefix(key.sourceId, key.entityCode)}${key.batchId}.${key.token}.part`);
}

export function finalPath(dir: string, key: SpoolKey): string {
  return path.join(dir, `${entityFilePrefix(key.sourceId, key.entityCode)}${key.batchId}.${key.token}.ndjson.gz`);
}

/**
 * Files an attempt may have left, in both naming formats: the current `<source>.<entity>.<batch>.<attempt>.*`
 * and the E3a format `<batch>.<attempt>.*` (files written before this change).
 */
export function attemptFiles(dir: string, key: SpoolKey): string[] {
  return [
    partPath(dir, key),
    finalPath(dir, key),
    path.join(dir, `${key.batchId}.${key.token}.part`),
    path.join(dir, `${key.batchId}.${key.token}.ndjson.gz`),
  ];
}

/** Every spool file of an entity (any attempt, stored or not). */
export async function listEntityFiles(dir: string, sourceId: number, entityCode: string): Promise<string[]> {
  const prefix = entityFilePrefix(sourceId, entityCode);
  try {
    return (await fs.readdir(dir)).filter((name) => name.startsWith(prefix)).map((name) => path.join(dir, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function ensureSpoolDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}

export async function freeBytes(dir: string): Promise<number> {
  const stats = await fs.statfs(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** Removes a file this attempt owns; a missing file is fine. */
export async function removeQuietly(file: string): Promise<void> {
  try {
      await fs.unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Streams the request body into the attempt's part file while hashing the
 * compressed bytes. The request itself is never destroyed: on a limit or an
 * abort (superseded attempt) writing stops and the rest of the body is read
 * and discarded, so the agent receives a structured answer (413/409) rather
 * than a reset connection (the agent treats a reset as an unknown outcome).
 */
export async function receiveToFile(
  body: Readable,
  file: string,
  signal: AbortSignal,
  maxCompressedBytes: number = ONEC_ETL_LIMITS.maxCompressedBytes,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  const out = createWriteStream(file, { flags: 'wx', mode: 0o600 });
  let writeError: Error | null = null;
  out.on('error', (error) => {
    writeError = error;
  });
  let bytes = 0;
  let stopped: Error | null = null;
  try {
    for await (const chunk of body as AsyncIterable<Buffer>) {
      if (stopped) continue; // discard the rest of the body
      bytes += chunk.length;
      if (bytes > maxCompressedBytes) {
        stopped = new EtlLimitError('BATCH_LIMIT_EXCEEDED', `compressed body exceeds ${maxCompressedBytes} bytes`);
        continue;
      }
      if (signal.aborted) {
        stopped = new Error('aborted');
        continue;
      }
      if (writeError) {
        stopped = writeError;
        continue;
      }
      hash.update(chunk);
      if (!out.write(chunk)) {
        // Both listeners are removed whichever fires first: one backpressure wait per chunk
        // must not leave an 'error' listener behind (large batches hit MaxListeners otherwise).
        await new Promise<void>((resolve) => {
          const done = () => {
            out.off('drain', done);
            out.off('error', done);
            resolve();
          };
          out.on('drain', done);
          out.on('error', done);
        });
      }
    }
  } catch (error) {
    // The client went away mid-body: release the file descriptor before the caller deletes the file.
    await closeStream(out, true);
    throw error;
  }
  await closeStream(out, false);
  if (stopped) throw stopped;
  if (writeError) throw writeError;
  return { sha256: hash.digest('base64'), bytes };
}

/** Waits until the file descriptor is released (also when the stream already errored or closed). */
function closeStream(out: ReturnType<typeof createWriteStream>, destroy: boolean): Promise<void> {
  if (out.closed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    out.once('close', () => resolve());
    if (destroy || out.errored) out.destroy();
    else out.end();
  });
}

/** Splits NDJSON into lines with a per-line byte cap; the trailing line may lack "\n". */
export class LineSplitter extends Transform {
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  constructor(private readonly maxLineBytes: number) {
    super({ readableObjectMode: true });
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) break;
      const piece = chunk.subarray(start, newline);
      if (this.pendingBytes + piece.length > this.maxLineBytes) {
        callback(new EtlLimitError('BATCH_LINE_TOO_LONG', `line exceeds ${this.maxLineBytes} bytes`));
        return;
      }
      this.pending.push(piece);
      this.emitLine();
      start = newline + 1;
    }
    const rest = chunk.subarray(start);
    if (this.pendingBytes + rest.length > this.maxLineBytes) {
      callback(new EtlLimitError('BATCH_LINE_TOO_LONG', `line exceeds ${this.maxLineBytes} bytes`));
      return;
    }
    if (rest.length > 0) {
      this.pending.push(Buffer.from(rest));
      this.pendingBytes += rest.length;
    }
    callback();
  }

  override _flush(callback: TransformCallback): void {
    if (this.pendingBytes > 0) this.emitLine();
    callback();
  }

  private emitLine(): void {
    let line = Buffer.concat(this.pending).toString('utf8');
    this.pending = [];
    this.pendingBytes = 0;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.trim().length > 0) this.push(line);
  }
}

/** Decompresses a stored file and yields its non-empty lines (uncompressed-size cap enforced). */
export async function* readLines(
  file: string,
  onBytes?: (total: number) => void,
  limits: EtlLimits = ONEC_ETL_LIMITS,
): AsyncGenerator<string> {
  let uncompressed = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      uncompressed += chunk.length;
      if (uncompressed > limits.maxUncompressedBytes) {
        callback(new EtlLimitError('BATCH_LIMIT_EXCEEDED', `uncompressed body exceeds ${limits.maxUncompressedBytes} bytes`));
        return;
      }
      onBytes?.(uncompressed);
      callback(null, chunk);
    },
  });
  const splitter = new LineSplitter(limits.maxLineBytes);
  const done = pipeline(createReadStream(file), createGunzip(), counter, splitter).catch((error: unknown) => {
    throw asEtlError(error);
  });
  // The pipeline rejection is also surfaced through the destroyed splitter; keep one owner.
  done.catch(() => undefined);
  try {
      for await (const line of splitter) yield line as string;
  } catch (error) {
    throw asEtlError(error);
  }
  await done;
}

function asEtlError(error: unknown): unknown {
  if (error instanceof EtlLimitError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && code.startsWith('Z_')) return new EtlLimitError('BATCH_GZIP_INVALID', 'gzip stream is invalid');
  return error;
}

/** Counts lines and uncompressed bytes of a received file (upload-time check). */
export async function countLines(file: string, limits: EtlLimits = ONEC_ETL_LIMITS): Promise<{ rows: number; uncompressedBytes: number }> {
  let rows = 0;
  let uncompressedBytes = 0;
  for await (const _line of readLines(file, (total) => (uncompressedBytes = total), limits)) {
    rows += 1;
    if (rows > limits.maxRows) throw new EtlLimitError('BATCH_LIMIT_EXCEEDED', `more than ${limits.maxRows} rows`);
  }
  return { rows, uncompressedBytes };
}

/** Durability: file contents, then the rename, then the directory entry. */
export async function persist(part: string, target: string): Promise<void> {
  const handle = await fs.open(part, 'r');
  try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(part, target);
    const dir = await fs.open(path.dirname(target), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }

  /** Reads and discards the rest of a request body (the agent must get our answer, not a reset). */
  export async function drain(body: Readable): Promise<void> {
    if (body.readableEnded || body.destroyed) return;
    await new Promise<void>((resolve) => {
      body.on('end', resolve);
      body.on('close', resolve);
      body.on('error', () => resolve());
      body.resume();
    });
  }
