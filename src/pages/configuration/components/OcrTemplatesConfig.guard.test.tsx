import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('./OcrTemplatesConfig.tsx', import.meta.url), 'utf8');
const tabSrc = readFileSync(new URL('./LabelsConfigTab.tsx', import.meta.url), 'utf8');

describe('OcrTemplatesConfig wiring', () => {
  it('reads and writes only through labelsApi backend endpoints', () => {
    expect(src).toMatch(/import \{ labelsApi \} from '\.\.\/\.\.\/\.\.\/api\/labelsApi'/);
    expect(src).toMatch(/labelsApi\.listOcrTemplates/);
    expect(src).toMatch(/labelsApi\.deleteOcrTemplate/);
    expect(src).not.toMatch(/dataProvider|gql`|mutation\s/);
  });

  it('renders create and deactivate actions', () => {
    expect(src).toMatch(/Создать/);
    expect(src).toMatch(/Деактивировать/);
    expect(src).toMatch(/Редактировать/);
  });

  it('renders field tags via summarizeFieldTags', () => {
    expect(src).toMatch(/summarizeFieldTags/);
    expect(src).toMatch(/template\.rules/);
  });

  it('guards mutating actions behind canManage', () => {
    expect(src).toMatch(/canManage: boolean/);
    expect(src).toMatch(/disabled=\{!canManage\}/);
    expect(src).toMatch(/disabled=\{!canManage \|\| !template\.isActive\}/);
  });

  it('is mounted additively in LabelsConfigTab behind labels.manage_templates', () => {
    expect(tabSrc).toMatch(/import \{ OcrTemplatesConfig \} from '\.\/OcrTemplatesConfig'/);
    expect(tabSrc).toMatch(/<OcrTemplatesConfig canManage=\{can\('labels\.manage_templates'\)\}/);
  });
});
