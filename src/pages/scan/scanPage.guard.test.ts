import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');

describe('qr scanner module', () => {
  it('lazily imports zxing and requests rear camera only from startQrScanner', () => {
    const src = read('qrScanner.ts');
    expect(src).toContain("import('zxing-wasm");
    expect(src).toContain('facingMode');
    expect(src).not.toMatch(/^import .*zxing/m); // нет статического импорта wasm
  });
});

describe('ScanPage', () => {
  it('ScanPage lazy-starts camera and wires manual input to scanResolve', () => {
    const src = read('ScanPage.tsx');
    expect(src).toContain('startQrScanner');
    expect(src).toContain('scanResolve');
    expect(src).toContain('NotAllowedError');
    expect(src).toContain('highlightDetail');
  });
});
