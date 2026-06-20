import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Source-text guards (vitest env=node, no jsdom): AddToCutModal stays backend-owned
// and applies detail-level restriction via restrictDetailIds when detailIds is passed.
const source = readFileSync(fileURLToPath(new URL('./AddToCutModal.tsx', import.meta.url)), 'utf8');

describe('AddToCutModal source guards', () => {
  it('is backend-owned (cutApi only, no Hasura/graphql/fetch)', () => {
    expect(source).toContain("from '../../../api/cutApi'");
    expect(source).not.toMatch(/hasura/i);
    expect(source).not.toMatch(/graphql/i);
    expect(source).not.toMatch(/\bfetch\(/);
  });

  it('supports a detail-level mode that restricts chosen ids to eligible', () => {
    expect(source).toContain('detailIds');
    expect(source).toContain('restrictDetailIds');
  });
});
