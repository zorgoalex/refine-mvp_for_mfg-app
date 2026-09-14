import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('order list renders backend audit labels without fetching creator profiles', () => {
  const source = readFileSync(new URL('./list.tsx', import.meta.url), 'utf8');
  expect(source.includes('createdByIds')).toBe(false);
  expect(source.includes('createdByMap')).toBe(false);
  expect(source).toContain('record?.created_by_label');
  expect(source).toContain('`ERP #${record.created_by}`');
  // Keep real-user filter choices, but never hydrate audit actors through them.
  expect(source).toContain('selectProps: userSelectProps');
});
