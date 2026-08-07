import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./show.tsx', import.meta.url), 'utf8');

describe('order show doweling column', () => {
  it('shows doweling immediately after production status and before cut', () => {
    const statusColumn = source.indexOf("title: 'Статус'");
    const dowelingColumn = source.indexOf("title: 'Присадка'", statusColumn);
    const cutColumns = source.indexOf('...(cutColumnEnabled', dowelingColumn);

    expect(statusColumn).toBeGreaterThan(-1);
    expect(dowelingColumn).toBeGreaterThan(statusColumn);
    expect(cutColumns).toBeGreaterThan(dowelingColumn);
    expect(source.slice(dowelingColumn, cutColumns)).toContain("dataIndex: 'doweling'");
    expect(source.slice(dowelingColumn, cutColumns)).toContain('<CheckOutlined');
  });

  it('keeps the new column after status for users with older saved preferences', () => {
    expect(source).toContain("{ key: 'doweling', label: 'Присадка', defaultAfter: 'production_status_id' }");
  });

  it('passes the detail doweling flag into both Excel export modes', () => {
    expect(source).toContain('doweling: detail.doweling === true');
    expect(source).toContain("pricingMode: withoutPrices ? 'omit' : 'full'");
  });
});
