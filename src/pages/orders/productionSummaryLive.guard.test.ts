import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('order view production letters', () => {
  it('shows only the backend projection (manual letters in another colour), never Hasura events', () => {
    const header = read('./components/sections/OrderShowHeader.tsx');
    expect(header).toContain('record?.passed_production_status_codes ?? record?.passedProductionStatusCodes');
    expect(header).toContain('record?.manual_production_status_codes ?? record?.manualProductionStatusCodes');
    expect(header).not.toContain("resource: 'production_status_events'");
    expect(header).not.toContain('currentRoundStageEvents');
    expect(header).not.toContain('detailStatuses');
    expect(header).not.toContain('OrderProductionSummary');
    expect(header.match(/passedCodes=\{currentProductionStatusCodes\}/g)).toHaveLength(4);
    expect(header.match(/manualCodes=\{manualProductionStatusCodes\}/g)).toHaveLength(4);
  });

  it('re-reads the order when detail stages change (the backend recomputes the letters)', () => {
    const header = read('./components/sections/OrderShowHeader.tsx');
    expect(header).toContain('buildStageMarksSignature(details || [], hdfDetails)');
    expect(header).toContain('onRefreshOrder?.();');
    expect(read('./show.tsx').match(/onRefreshOrder=\{refreshOrderShow\}/g)).toHaveLength(2);
    const editHeader = read('./components/sections/OrderHeaderSummary.tsx');
    expect(editHeader).toContain('buildStageMarksSignature(details, hdfDetails)');
    expect(editHeader).toContain('header.version');
    expect(editHeader).toContain('refreshLetters();');
    // the stage menu checks the real letters; a finished order shows only its last letter
    expect(editHeader).toContain('projectedCodes: menuStageCodes');
    expect(editHeader).toContain('projectionLoadedAt: headerLetters?.loadedAt');
    expect(editHeader).toContain('if (finishedOrderLetters) return projectedPassedCodes;');
    // a late answer of an earlier re-read is dropped
    expect(editHeader).toContain('if (seq !== lettersRequestSeq.current) return;');
    expect(editHeader).toContain('onCommandAnswered: refreshLetters');
  });

  it('the orders list and mobile cards take letters from the projection only', () => {
    const list = read('./list.tsx');
    const cards = read('./mobile/OrderCardList.tsx');
    expect(list).not.toContain("resource: \"production_status_events\"");
    expect(list).toContain('resolveOrderStageCodes(record.passed_production_status_codes)');
    expect(list).toContain('resolveOrderStageCodes(record.manual_production_status_codes)');
    expect(cards).toContain('resolveOrderStageCodes(row.passed_production_status_codes)');
    expect(cards).toContain('resolveOrderStageCodes(row.manual_production_status_codes)');
  });

  it('refreshing the calendar re-reads the orders (letters are on the order)', () => {
    const calendar = read('../calendar/hooks/useCalendarData.ts');
    expect(calendar).not.toContain('refetchProductionEvents');
    expect(calendar).toContain('const refetchWithStageMarks = useCallback(() => refetch(), [refetch]);');
    expect(calendar).toContain('refetch: refetchWithStageMarks,');
  });
});
