import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('order view production letters', () => {
  it('shows only the order stage marks (the menu state), never detail stages or a word badge', () => {
    const header = readFileSync(new URL('./components/sections/OrderShowHeader.tsx', import.meta.url), 'utf8');
    expect(header).toContain('resolveOrderStageCodes(backendStageCodes)');
    // legacy Hasura read path: the order's own events, loaded only when the backend codes are absent
    expect(header).toContain("resource: 'production_status_events'");
    expect(header).toContain('!Array.isArray(backendStageCodes)');
    expect(header).not.toContain('detailStatuses');
    expect(header).not.toContain('OrderProductionSummary');
    expect(header.match(/passedCodes=\{currentProductionStatusCodes\}/g)).toHaveLength(4);
  });
});
