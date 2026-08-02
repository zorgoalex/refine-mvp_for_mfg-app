import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const src = readFileSync(resolve(__dirname, 'list.tsx'), 'utf8');
describe('audit list related-entity UI', () => {
  it('adds related entity filter fields', () => {
    expect(src).toContain('relatedEntityType');
    expect(src).toContain('relatedEntityId');
  });
  it('renders relatedEntities from the row', () => {
    expect(src).toContain('relatedEntities');
  });
  it('keeps readable and technical audit views available', () => {
    expect(src).toContain("'readable' | 'technical'");
    expect(src).toContain('Понятный');
    expect(src).toContain('Технический');
  });
  it('loads filter option values and renders filter fields as dropdowns', () => {
    expect(src).toContain('auditApi.filterOptions');
    expect(src).toContain('filterSelectOptions.events');
    expect(src).toContain('<Select');
    expect(src).toContain('showSearch');
  });
});
