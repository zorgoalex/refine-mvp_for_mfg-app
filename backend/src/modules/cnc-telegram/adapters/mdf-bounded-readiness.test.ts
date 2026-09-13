import { describe, expect, it } from 'vitest';
import { mdfOperationalTwoMonthStart } from '../application/mdf-operational-window';
import { parseTodayQuery } from '../http/cnc-telegram.controller';

describe('bounded MDF calculation window', () => {
  it.each([
    ['2026-09-13', '2026-07-13'], ['2026-04-30', '2026-02-28'],
    ['2024-04-30', '2024-02-29'], ['2026-01-31', '2025-11-30'],
  ])('uses two calendar months, clamped at month end: %s', (end, start) => {
    expect(mdfOperationalTwoMonthStart(end)).toBe(start);
  });

  it('accepts the explicit bounded contract, including focused baths', () => {
    expect(parseTodayQuery({ operationalWindow: 'two_months', date: '2026-09-13', focusBathCardId: 'cut-result:9' }))
      .toMatchObject({ operationalWindow: 'two_months', workday: '2026-09-13', focusBathCardId: 'cut-result:9' });
  });
});
