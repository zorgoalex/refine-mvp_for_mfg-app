import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('./OcrTemplateEditor.tsx', import.meta.url), 'utf8');

describe('OcrTemplateEditor wiring', () => {
  it('reads and writes only through labelsApi backend endpoints', () => {
    expect(src).toMatch(/import \{ labelsApi \} from '\.\.\/\.\.\/\.\.\/api\/labelsApi'/);
    expect(src).toMatch(/labelsApi\.previewOcrLabel/);
    expect(src).toMatch(/labelsApi\.testOcrTemplate/);
    expect(src).toMatch(/labelsApi\.createOcrTemplate/);
    expect(src).toMatch(/labelsApi\.updateOcrTemplate/);
    expect(src).not.toMatch(/dataProvider|gql`|mutation\s/);
  });

  it('renders the recognize/test/anchor UI copy', () => {
    expect(src).toMatch(/Проверить на фото/);
    expect(src).toMatch(/Якорь/);
    expect(src).toMatch(/Распознать/);
  });

  it('validates rules with the shared FE mirror before allowing save', () => {
    expect(src).toMatch(/validateOcrRulesFe/);
  });

  it('mirrors the ScanPage OCR ApiError code branches (422/503 + timeout)', () => {
    expect(src).toMatch(/OCR_IMAGE_UNREADABLE/);
    expect(src).toMatch(/OCR_SERVICE_BUSY/);
    expect(src).toMatch(/OCR_SERVICE_UNAVAILABLE/);
    expect(src).toMatch(/TimeoutError/);
  });

  it('saves the full ordered rules array (matcher is order-sensitive), not just non-ignore rules', () => {
    expect(src).toMatch(/buildOcrTemplateInput/);
    expect(src).not.toMatch(/rules\.filter\(\s*\(?r(ule)?\)?\s*=>\s*r(ule)?\.field\s*!==\s*'ignore'/);
  });

  it('guards mutating actions behind canManage', () => {
    expect(src).toMatch(/canManage: boolean/);
    expect(src).toMatch(/disabled=\{!canManage/);
  });

  it('renders a box overlay over the uploaded photo, keyed to normalized boxes', () => {
    expect(src).toMatch(/normalizeBox/);
    expect(src).toMatch(/<img/);
    expect(src).toMatch(/photoUrl/);
  });

  it('shares one activeIndex between row hover and box click for the row<->box highlight', () => {
    expect(src).toMatch(/activeIndex/);
    expect(src).toMatch(/onMouseEnter=\{?\(?\)? *=> *setActiveIndex/);
  });

  it('shows the rule-order hint above the per-line list', () => {
    expect(src).toMatch(/Порядок правил/);
  });

  it('revokes the sample-photo object URL to avoid leaking it', () => {
    expect(src).toMatch(/URL\.createObjectURL/);
    expect(src).toMatch(/URL\.revokeObjectURL/);
  });
});
