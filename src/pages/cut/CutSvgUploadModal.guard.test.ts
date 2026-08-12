import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const modal = readFileSync('src/pages/cut/CutSvgUploadModal.tsx', 'utf8');
const cutPage = readFileSync('src/pages/cut/CutPage.tsx', 'utf8');
const orderList = readFileSync('src/pages/orders/list.tsx', 'utf8');
const orderShow = readFileSync('src/pages/orders/show.tsx', 'utf8');
const cncApi = readFileSync('src/api/cncTelegramApi.ts', 'utf8');

describe('manual SVG cut upload UI guard', () => {
  it('uses backend manual SVG command and exact MDF-card question', () => {
    expect(cncApi).toContain('manualSvgUpload');
    expect(cncApi).toContain('Idempotency-Key');
    expect(modal).toContain('parseSvgCutUploadFile');
    expect(modal).toContain('создать карточку файла станка для Доски МДФ из раскроя?');
    expect(modal).toContain('createMdfMachineFileCard');
    expect(modal).toContain('manual-svg-preset:${asciiHash(commentText)}');
  });

  it('wires upload button into cut and orders headers', () => {
    expect(cutPage).toContain('<CutSvgUploadModal');
    expect(cutPage).toContain('setSvgUploadOpen(true)');
    expect(orderList).toContain('<CutSvgUploadModal');
    expect(orderList).toContain('setSvgUploadOpen(true)');
    expect(orderShow).toContain('<CutSvgUploadModal');
    expect(orderShow).toContain('defaultOrderIds={[record.order_id]}');
  });
});
