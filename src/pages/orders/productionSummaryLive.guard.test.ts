import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('order production badge live wiring', () => {
  it('passes table live statuses and complete/empty load state into both header variants', () => {
    const show = readFileSync(new URL('./show.tsx', import.meta.url), 'utf8');
    const header = readFileSync(new URL('./components/sections/OrderShowHeader.tsx', import.meta.url), 'utf8');
    expect(show).toContain('overlayDetailProductionStatuses(details, currentDetailProductionStatusById)');
    expect(show).toContain('details={detailsWithLiveProductionStatuses}');
    expect(show).toContain('detailsLoaded={productionSummaryDetailsLoaded}');
    expect(show).toContain('detailsData.data.length === detailsData.total');
    expect(header.match(/details=\{detailsLoaded \? details : undefined\}/g)).toHaveLength(2);
    expect(header).not.toContain('details.length ? details : undefined');
  });
});
