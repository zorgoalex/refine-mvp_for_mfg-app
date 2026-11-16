import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The MDF events query runs inside every SVG upload / BASIS cut-set save / import completion transaction under the
// 10 s query timeout. Computing bath totals for every bath (and matching every bath per detail) outgrew it on prod;
// the events must be narrowed to the baths of the source and the details in them before totals are summed.
describe('MDF board events query narrowing', () => {
  const source = readFileSync(join(__dirname, 'pg-mdf-board-event-repository.ts'), 'utf8');

  it('selects the baths of the source once, before the bath totals', () => {
    expect(source).toContain('relevant_baths AS MATERIALIZED (');
    expect(source).toContain('relevant_details AS MATERIALIZED (');
    expect(source.indexOf('relevant_details AS MATERIALIZED (')).toBeLessThan(source.indexOf('bath_totals AS ('));
  });

  it('sums totals only for details of those baths and emits bath events only for those baths', () => {
    expect(source).toContain('JOIN relevant_details rd ON rd.order_id=m.order_id AND rd.detail_id=m.detail_id');
    expect(source).toContain('FROM relevant_baths r JOIN bath_members m USING(cut_result_id) JOIN bath_states s USING(cut_result_id)');
    expect(source).not.toContain('WHERE member.cut_result_id=m.cut_result_id');
  });
});
