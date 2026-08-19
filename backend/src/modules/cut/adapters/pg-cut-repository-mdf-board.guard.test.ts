import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./pg-cut-repository.ts', import.meta.url), 'utf8');
const statusQuery = source.slice(
  source.indexOf('async function loadMdfBoardStatuses'),
  source.indexOf('function buildMdfBoardStatus'),
);

describe('cut-list MDF board status query guard', () => {
  it('scopes bath matching to current-result candidates and indexed lookups', () => {
    expect(statusQuery).toContain('candidate_details AS');
    expect(statusQuery).toContain('item.match_detail_id = candidate.detail_id');
    expect(statusQuery).toContain('lower(trim(item.order_name)) = candidate.order_key');
    const wholeOrderQuery = statusQuery.slice(
      statusQuery.indexOf('whole_order_bath_sources AS'),
      statusQuery.indexOf('\n    bath_sources AS'),
    );
    expect(wholeOrderQuery).toContain('cnc_telegram_packet_whole_order_keys');
    expect(wholeOrderQuery).not.toContain('cnc_telegram_packet_items');
    expect(statusQuery).not.toContain('cncMdfTargetDetailsCtes');
    expect(statusQuery).not.toContain("'1900-01-01'");
    expect(statusQuery).not.toContain("'9999-12-31'");
  });
});
