import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tabSrc = readFileSync(new URL('./LabelsConfigTab.tsx', import.meta.url), 'utf8');
const indexSrc = readFileSync(new URL('../index.tsx', import.meta.url), 'utf8');
const apiSrc = readFileSync(new URL('../../../api/labelsApi.ts', import.meta.url), 'utf8');

describe('LabelsConfigTab wiring', () => {
  it('is registered only behind labels runtime flag and labels.view permission', () => {
    expect(indexSrc).toMatch(/featureFlags\.labels[\s\S]*can\('labels\.view'\)[\s\S]*LabelsConfigTab/);
  });

  it('reads and writes only through labelsApi backend endpoints', () => {
    expect(tabSrc).toMatch(/labelsApi\.listTemplates/);
    expect(tabSrc).toMatch(/labelsApi\.listFields/);
    expect(tabSrc).toMatch(/labelsApi\.createTemplate/);
    expect(tabSrc).toMatch(/labelsApi\.updateTemplate/);
    expect(tabSrc).not.toMatch(/dataProvider|gql`|mutation\s/);
    expect(apiSrc).toMatch(/createTemplate/);
    expect(apiSrc).toMatch(/updateTemplate/);
    expect(apiSrc).toMatch(/deleteTemplate/);
  });

  it('requires labels.manage_templates for create and edit controls', () => {
    expect(tabSrc).toMatch(/can\('labels\.manage_templates'\)/);
    expect(tabSrc).toMatch(/disabled=\{!canManage/);
    expect(tabSrc).toMatch(/Новый шаблон/);
    expect(tabSrc).toMatch(/Сохранить шаблон/);
  });

  it('exposes editable template elements and custom schema so created templates are not blank-only', () => {
    expect(tabSrc).toMatch(/Элементы шаблона/);
    expect(tabSrc).toMatch(/addElement\('text'\)/);
    expect(tabSrc).toMatch(/addElement\('line'\)/);
    expect(tabSrc).toMatch(/addElement\('rect'\)/);
    expect(tabSrc).toMatch(/customFieldSchema/);
    expect(tabSrc).toMatch(/elements,/);
  });
});
