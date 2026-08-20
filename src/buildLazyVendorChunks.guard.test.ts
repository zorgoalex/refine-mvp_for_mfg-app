import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const viteConfig = readFileSync('vite.config.ts', 'utf8');

describe('lazy heavyweight vendor chunk guard', () => {
  it('lets Rollup preserve dynamic PDF.js and ExcelJS imports', () => {
    expect(viteConfig).not.toContain('pkg === "pdfjs-dist"');
    expect(viteConfig).not.toContain('pkg === "exceljs"');
    expect(viteConfig).toContain('pkg === "xlsx"');
  });
});
