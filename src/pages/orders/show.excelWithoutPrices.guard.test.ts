import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, 'show.tsx'), 'utf8');

describe('order show price-free Excel export', () => {
  it('exposes a separate action and sends the omit-pricing mode to the workbook builder', () => {
    expect(source).toContain('<Tooltip title="Excel для производства">');
    expect(source).toContain('aria-label="Excel для производства"');
    expect(source).toContain('productionExcelIcon');
    expect(source).toContain("handleExportExcel('without-prices')");
    expect(source).toContain("pricingMode: withoutPrices ? 'omit' : 'full'");
    expect(source).toContain("variant: withoutPrices ? 'without-prices' : 'standard'");
  });
});
