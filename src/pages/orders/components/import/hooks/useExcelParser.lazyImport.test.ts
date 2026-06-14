import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, 'useExcelParser.ts'), 'utf8');

describe('useExcelParser xlsx loading', () => {
  it('keeps xlsx as a dynamic runtime import', () => {
    expect(source).toContain("import('xlsx')");
    expect(source).toMatch(/import\s+type\s+\{[^}]*\}\s+from ['"]xlsx['"]/s);
    expect(source).not.toMatch(/import\s+\*\s+as\s+XLSX\s+from ['"]xlsx['"]/);
    expect(source).not.toMatch(/import\s+XLSX\s+from ['"]xlsx['"]/);
    expect(source).not.toMatch(/const\s+XLSX\s*=\s*require\(['"]xlsx['"]\)/);
  });
});
