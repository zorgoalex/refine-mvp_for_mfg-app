import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('./pg-cnc-telegram-repository.ts', import.meta.url)), 'utf8');

describe('MDF whole-order projection', () => {
  it('uses normalized keys and the shared strict MDF classifier', () => {
    const cte = source.slice(
      source.indexOf('completed_whole_order_keys AS ('),
      source.indexOf('whole_order_target_details AS ('),
    );
    expect(cte).toContain('cnc_telegram_packet_whole_order_keys');
    expect(cte).not.toContain('regexp_matches');
    expect(cte).toContain("cncPacketCountsForMdfReadinessSql('p')");

    const classifier = source.slice(
      source.indexOf('function cncPacketCountsForMdfReadinessSql('),
      source.indexOf('interface PacketJoinedRow'),
    );
    expect(classifier).toContain('.material_name');
    expect(classifier).toContain('.program_name');
    expect(classifier).toContain('.external_packet_key');
    expect(classifier).toContain('.comments_json');
    expect(classifier).toContain('CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE');
    expect(classifier).toContain('CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE');
  });
});
