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

  it('can derive historical targets by packet creation time including hidden packets', () => {
    const sql = cncMdfTargetDetailsCtes('created-history');

    expect(sql).toContain('COALESCE(p.source_created_at, p.created_at) >= $1::date');
    expect(sql).toContain("COALESCE(p.source_created_at, p.created_at) < ($2::date + INTERVAL '1 day')");
    expect(sql).not.toContain('p.mdf_board_hidden_at IS NULL');
  });

  it('can namespace a current standard-board projection that excludes hidden packets', () => {
    const sql = cncMdfTargetDetailsCtes('current-visible', 'current_');

    expect(sql).toContain('current_packet_items AS');
    expect(sql).toContain('FROM current_packet_items item');
    expect(sql).toContain('current_target_details AS');
    expect(sql).toContain('p.workday = CURRENT_DATE');
    expect(sql).toContain('p.mdf_board_hidden_at IS NULL');
  });
});
