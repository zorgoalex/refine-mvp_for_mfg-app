import { describe, expect, it } from 'vitest';
import { cncMdfTargetDetailsCtes } from './target-details-sql.js';

describe('cncMdfTargetDetailsCtes', () => {
  it('keeps exact, fallback and whole-order matching on one workday-aware contract', () => {
    const sql = cncMdfTargetDetailsCtes();
    expect(sql).toContain('matched_target_detail_sources');
    expect(sql).toContain('fallback_target_detail_sources');
    expect(sql).toContain('whole_order_target_detail_sources');
    expect(sql).toContain('cnc_telegram_packet_whole_order_keys');
    expect(sql).toContain('target_detail_sources');
    expect(sql).toContain('item.workday');
    expect(sql).toContain('p.mdf_board_hidden_at IS NULL');
  });
});
