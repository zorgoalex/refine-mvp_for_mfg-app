import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({ failingStream: null as null | (() => Writable) }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createWriteStream: ((...args: Parameters<typeof actual.createWriteStream>) =>
      fsMock.failingStream ? fsMock.failingStream() : actual.createWriteStream(...args)) as typeof actual.createWriteStream,
  };
});

const { receiveToFile } = await import('./onec-etl-spool');

describe('1C ETL spool: receiveToFile', () => {
  let dir: string | null = null;
  afterEach(async () => {
    fsMock.failingStream = null;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('many backpressure waits leave no listeners behind (no MaxListenersExceededWarning)', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'onec-spool-'));
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => warnings.push(warning);
    process.on('warning', onWarning);
    try {
      // 64 chunks of 64 KiB: each write exceeds the 16 KiB write-stream buffer and waits for 'drain'.
      const chunk = Buffer.alloc(64 * 1024, 1);
      const body = Readable.from(Array.from({ length: 64 }, () => chunk));
      const result = await receiveToFile(body, path.join(dir, 'batch.part'), new AbortController().signal);
      expect(result.bytes).toBe(64 * chunk.length);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', onWarning);
    }
    expect(warnings.filter((w) => w.name === 'MaxListenersExceededWarning')).toEqual([]);
  });

  it('a write error while waiting for drain settles the upload with the original error and closes the stream', async () => {
    let stream: Writable | null = null;
    let writes = 0;
    fsMock.failingStream = () => {
      // highWaterMark 1: every write waits for 'drain'; the second write fails (disk full) during that wait.
      stream = new Writable({
        highWaterMark: 1,
        write(_chunk, _encoding, callback) {
          writes += 1;
          if (writes === 2) setImmediate(() => callback(new Error('ENOSPC: disk full')));
          else setImmediate(callback);
        },
      });
      return stream;
    };
    let consumed = 0;
    const body = Readable.from(
      (function* () {
        for (let i = 0; i < 10; i += 1) {
          consumed += 1;
          yield Buffer.alloc(1024, 1);
        }
      })(),
    );
    await expect(receiveToFile(body, '/unused/batch.part', new AbortController().signal)).rejects.toThrow('ENOSPC: disk full');
    expect(writes).toBe(2); // nothing is written after the error
    expect(consumed).toBe(10); // the rest of the body is read and discarded, not left hanging
    expect(stream!.destroyed).toBe(true);
    expect(stream!.listenerCount('drain')).toBe(0);
  });
});
