import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('order view production letters', () => {
  it('shows only the order stage marks (the menu state), never detail stages or a word badge', () => {
    const header = readFileSync(new URL('./components/sections/OrderShowHeader.tsx', import.meta.url), 'utf8');
    // backend codes only until the order's own events load
    expect(header).toContain('if (!orderMarkEvents) return resolveOrderStageCodes(backendStageCodes);');
    expect(header).toContain("resource: 'production_status_events'");
    expect(header).not.toContain('detailStatuses');
    expect(header).not.toContain('OrderProductionSummary');
    expect(header.match(/passedCodes=\{currentProductionStatusCodes\}/g)).toHaveLength(2);
  });

  it('re-reads the marks when detail stages change (the database sets and clears them)', () => {
    const header = readFileSync(new URL('./components/sections/OrderShowHeader.tsx', import.meta.url), 'utf8');
    // ordinary and HDF stages, and every re-read of the order
    expect(header).toContain('buildStageMarksSignature(details || [], hdfDetails)');
    expect(header).toContain('previous.record === record');
    expect(header).toContain('if (canViewProductionReferences && record?.order_id != null) void refetchOrderMarks();');
    const editHeader = readFileSync(new URL('./components/sections/OrderHeaderSummary.tsx', import.meta.url), 'utf8');
    expect(editHeader).toContain('buildStageMarksSignature(details, hdfDetails)');
    expect(editHeader).toContain('header.version');
    expect(editHeader).toContain('if (header.order_id) refetchStageMarks();');
  });

  it('refreshing the calendar re-reads the stage marks', () => {
    const calendar = readFileSync(new URL('../calendar/hooks/useCalendarData.ts', import.meta.url), 'utf8');
    expect(calendar).toContain('if (orderIds.length > 0) void refetchProductionEvents();');
    expect(calendar).toContain('refetch: refetchWithStageMarks,');
  });
});
