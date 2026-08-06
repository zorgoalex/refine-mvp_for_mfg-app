import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, 'show.tsx'), 'utf8');

describe('order show price-free Excel export', () => {
  it('keeps production Excel in the overflow menu and sends omit-pricing mode to the workbook builder', () => {
    expect(source).toContain("key: 'excel-without-prices'");
    expect(source).toContain("label: 'Excel для производства'");
    expect(source).not.toContain('<Tooltip title="Excel для производства">');
    expect(source).not.toContain('aria-label="Excel для производства"');
    expect(source).toContain("handleExportExcel('without-prices')");
    expect(source).toContain("pricingMode: withoutPrices ? 'omit' : 'full'");
    expect(source).toContain("variant: withoutPrices ? 'without-prices' : 'standard'");
  });

  it('exposes the production PDF as the direct order action', () => {
    expect(source).toContain('aria-label="PDF для производства"');
    expect(source).toContain('PDF для производства');
    expect(source).toContain('openOrderProductionPdfPreview');
  });
});
