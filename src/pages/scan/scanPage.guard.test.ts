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

  it('decodes QR from an image file without touching the camera', () => {
    const src = read('qrScanner.ts');
    expect(src).toContain('export async function decodeQrFromFile');
    // файл-декод не должен дёргать getUserMedia
    expect(src.split('decodeQrFromFile')[1]).not.toContain('getUserMedia');
  });

  it('serves the zxing wasm from OUR bundle, not the default CDN (CSP blocks it)', () => {
    // Без locateFile-override zxing тянет .wasm с fastly.jsdelivr.net —
    // стейджовый CSP это режет и декод молча умирает (пойман на живой бирке).
    const src = read('qrScanner.ts');
    expect(src).toContain("zxing-wasm/reader/zxing_reader.wasm?url");
    expect(src).toContain('prepareZXingModule');
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

  it('applies saved action on ANY candidate select (single and multi) via shared handler', () => {
    const src = read('ScanPage.tsx');
    expect(src).toContain('handleCandidateSelect');
    // multi-candidate list taps must route through the shared handler,
    // not open the chooser modal unconditionally
    expect(src).toMatch(/onClick=\{\(\) => handleCandidateSelect\(candidate\)\}/);
  });

  it('distinguishes request failures (403/network) from empty results', () => {
    const src = read('ScanPage.tsx');
    expect(src).toContain('scanError');
    expect(src).toContain('403');
    expect(src).toContain('ApiError');
  });

  it('auto-selects a confident leader instead of dumping the whole order as a list', () => {
    // Неточный QR (имя заказа без ID) даёт все детали заказа; если top-score
    // строго выше остальных — ведём себя как с единственным кандидатом.
    const src = read('ScanPage.tsx');
    expect(src).toContain('confidentLeader');
  });

  it('restores the last scan result when returning to the page (back navigation)', () => {
    const src = read('ScanPage.tsx');
    expect(src).toContain('sessionStorage');
    expect(src).toContain('scanLastResult');
  });

  it('renders a human match label, never the raw matchedBy template string', () => {
    const src = read('ScanPage.tsx');
    // сырой matchedBy содержит весь QR-шаблон и разрывал вёрстку карточек
    expect(src).not.toMatch(/\{candidate\.matchedBy\}/);
    expect(src).toContain('matchedByLabel');
  });

  it('OCR request has a hard client timeout and a timeout error branch', () => {
    // без клиентского таймаута зависший аплоад = вечный спиннер (живой баг 2026-07-05)
    const api = readFileSync(join(__dirname, '..', '..', 'api', 'labelsApi.ts'), 'utf8');
    expect(api).toContain('AbortSignal.timeout');
    const src = read('ScanPage.tsx');
    expect(src).toContain('TimeoutError');
    expect(src).toContain('Не удалось распознать за отведённое время');
  });

  it('offers photo-file scanning wired to the same resolve flow', () => {
    const src = read('ScanPage.tsx');
    expect(src).toContain('Скан из фото');
    expect(src).toContain('accept="image/*,.emf,.bmp"'); // .emf от Базиса = часто растр
    expect(src).toContain('decodeQrFromFile');
  });

  it('offers an OCR fallback (pendingOcrFile + "Распознать текст бирки") when no QR is decoded from the photo', () => {
    const src = read('ScanPage.tsx');
    expect(src).toContain('pendingOcrFile');
    expect(src).toContain('Распознать текст бирки');
    expect(src).toContain('scanResolveImage');
    // Loading label must be visible while the OCR request is in flight.
    expect(src).toContain('Распознаём бирку');
  });

  it('invalidates the pending OCR photo on any new search act (resolvePayload resets it)', () => {
    const src = read('ScanPage.tsx');
    // Otherwise a stale «QR не найден» Alert/retry lingers next to fresh
    // manual/live-QR results, and the error-Alert retry re-OCRs the OLD photo.
    const resolvePayloadBody = src.split('const resolvePayload')[1]?.split('const handleResolveOcr')[0] ?? '';
    expect(resolvePayloadBody).toContain('setPendingOcrFile(null)');
  });

  it('maps OCR ApiError codes to Russian messages, including OCR_SERVICE_BUSY', () => {
    const src = read('ScanPage.tsx');
    expect(src).toContain('OCR_SERVICE_UNAVAILABLE');
    expect(src).toContain('OCR_SERVICE_BUSY');
    expect(src).toContain('UNSUPPORTED_IMAGE_TYPE');
  });

  it('maps OCR_IMAGE_UNREADABLE (400 unreadable/oversize image) to a distinct retry-photo message', () => {
    const src = read('ScanPage.tsx');
    expect(src).toContain('OCR_IMAGE_UNREADABLE');
    expect(src).toContain('Не удалось прочитать изображение. Попробуйте другое фото.');
  });
});

describe('scan surface gating', () => {
  const readSrc = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8');

  it('App.tsx gates the /scan route and scan resource behind featureFlags.labels', () => {
    const app = readSrc('App.tsx');
    expect(app).toMatch(/featureFlags\.labels[\s\S]{0,200}path="\/scan"/);
    expect(app).toMatch(/featureFlags\.labels[\s\S]{0,200}name: "scan"/);
  });

  it('AppHeader QR icon is gated by labels flag + scan navigation permission', () => {
    const header = readSrc('components/AppHeader.tsx');
    expect(header).toContain('featureFlags.labels');
    expect(header).toContain("canViewNavigationResource('scan'");
  });

  it('vercel.json Permissions-Policy allows self camera (scanner needs getUserMedia)', () => {
    // camera=() глушит getUserMedia на проде БЕЗ промпта — сканер бирок мёртв.
    const vercel = readFileSync(join(__dirname, '..', '..', '..', 'vercel.json'), 'utf8');
    expect(vercel).toContain('camera=(self)');
    expect(vercel).not.toContain('camera=()');
  });
});
