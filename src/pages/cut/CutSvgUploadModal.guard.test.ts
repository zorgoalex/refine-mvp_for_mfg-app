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
    expect(modal).toContain('parseSvgCutUploadFileNameHints');
    expect(modal).toContain('applyFileNameOrderHints');
    expect(modal).toContain('создать карточку файла станка для Доски МДФ из раскроя?');
    expect(modal).toContain('createMdfMachineFileCard');
    expect(modal).toContain('requestedCutJobId');
    expect(modal).toContain('№ задания');
    expect(modal).toContain('Оставьте пустым для авто-номера');
    expect(modal).toContain('checkRequestedCutJobNumber');
    expect(modal).toContain('suggestAvailableCutJobNumbers');
    expect(modal).toContain('buildSvgMatchProblems');
    expect(modal).toContain('Детали SVG не сопоставлены с выбранными заказами');
    expect(modal).toContain('Размер в SVG');
    expect(modal).toContain('showManualSvgApiMatchError');
    expect(modal).toContain('MANUAL_SVG_UNMATCHED_DETAILS');
    expect(modal).toContain('MANUAL_SVG_ORDER_SCOPE_MISMATCH');
    expect(modal).toContain('Деталь уже есть в активных раскроях');
    expect(modal).toContain('warningMatchProblems');
    expect(modal).toContain('confirmSvgMatchWarnings');
    expect(modal).toContain('Формировать всё равно');
    expect(modal).toContain('Это предупреждение не запрещает новый раскрой');
    expect(modal).toContain('SvgUploadPreview');
    expect(modal).toContain('Превью SVG');
    expect(modal).toContain('Превью SVG-раскроя');
    expect(modal).toContain('URL.createObjectURL');
    expect(modal).toContain('URL.revokeObjectURL');
    expect(modal).toContain("objectFit: 'contain'");
    expect(modal).toContain("flex: '0 0 320px'");
    expect(modal).toContain('replaceSvgPreview(null)');
    expect(modal).toContain('manual-svg-preset:${asciiHash(commentText)}');
    expect(modal).toContain("okText: cutJobPath ? 'Открыть задание' : 'OK'");
    expect(modal).toContain('onOk: openCutJob');
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
