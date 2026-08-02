import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(new URL('./generateOrderExcel.ts', import.meta.url), 'utf8');
const workerSource = readFileSync(new URL('./orderExcelWorker.ts', import.meta.url), 'utf8');
const viteConfigSource = readFileSync(new URL('../../../vite.config.ts', import.meta.url), 'utf8');

describe('order Excel worker generation guard', () => {
  it('runs ExcelJS workbook generation only in a module worker from the main export path', () => {
    expect(mainSource).toContain("new URL('./orderExcelWorker.ts', import.meta.url)");
    expect(mainSource).toContain('type: \'module\'');
    expect(mainSource).toContain('buildOrderExcelBufferInWorker(params)');
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
});
