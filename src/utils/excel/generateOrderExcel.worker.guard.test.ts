import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExcelGenerationError } from './excelErrorHandler';
import { buildOrderExcelBufferInWorker } from './generateOrderExcel';
import type { GenerateOrderExcelParams } from './orderExcelBuilder';

const mainSource = readFileSync(new URL('./generateOrderExcel.ts', import.meta.url), 'utf8');
const workerSource = readFileSync(new URL('./orderExcelWorker.ts', import.meta.url), 'utf8');
const viteConfigSource = readFileSync(new URL('../../../vite.config.ts', import.meta.url), 'utf8');

class FakeWorker {
  static latest: FakeWorker;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postedMessage?: { requestId: string };
  terminate = vi.fn();

  constructor() {
    FakeWorker.latest = this;
  }

  postMessage(message: { requestId: string }) {
    this.postedMessage = message;
  }

  respond(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

describe('order Excel worker generation guard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs ExcelJS workbook generation only in a module worker from the main export path', () => {
    expect(mainSource).toContain("new URL('./orderExcelWorker.ts', import.meta.url)");
    expect(mainSource).toContain('type: \'module\'');
    expect(mainSource).toContain('buildOrderExcelBufferInWorker(params)');
    expect(mainSource).toContain("if ('error' in response)");
    expect(mainSource).toContain("import type { GenerateOrderExcelParams } from './orderExcelBuilder'");
    expect(mainSource).not.toContain("await import('./orderExcelBuilder')");
    expect(mainSource).not.toContain("import { buildOrderExcelBuffer");
    expect(mainSource).not.toContain('falling back to main thread');
  });

  it('transfers the generated ArrayBuffer back without copying it through the main thread', () => {
    expect(workerSource).toContain("import { buildOrderExcelBuffer, type GenerateOrderExcelParams } from './orderExcelBuilder'");
    expect(workerSource).toContain('const toTransferableArrayBuffer');
    expect(workerSource).toContain('const buffer = toTransferableArrayBuffer(await buildOrderExcelBuffer(params))');
    expect(workerSource).toContain('self.postMessage({ requestId, ok: true, buffer }, [buffer])');
  });

  it('keeps Vite worker output in module format so ExcelJS can stay code-split inside the worker', () => {
    expect(viteConfigSource).toContain('worker: {');
    expect(viteConfigSource).toContain('format: "es"');
  });

  it('resolves a successful worker response and terminates the worker', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const promise = buildOrderExcelBufferInWorker({} as GenerateOrderExcelParams);
    const buffer = new ArrayBuffer(4);

    FakeWorker.latest.respond({
      requestId: FakeWorker.latest.postedMessage?.requestId,
      ok: true,
      buffer,
    });

    await expect(promise).resolves.toBe(buffer);
    expect(FakeWorker.latest.terminate).toHaveBeenCalledOnce();
  });

  it.each([
    ['ExcelGenerationError', ExcelGenerationError],
    ['Error', Error],
  ])('rejects a %s worker failure with its message', async (name, ErrorType) => {
    vi.stubGlobal('Worker', FakeWorker);
    const promise = buildOrderExcelBufferInWorker({} as GenerateOrderExcelParams);

    FakeWorker.latest.respond({
      requestId: FakeWorker.latest.postedMessage?.requestId,
      ok: false,
      error: { name, message: 'worker failed' },
    });

    await expect(promise).rejects.toEqual(expect.objectContaining({
      name: ErrorType.name,
      message: 'worker failed',
    }));
    expect(FakeWorker.latest.terminate).toHaveBeenCalledOnce();
  });
});
