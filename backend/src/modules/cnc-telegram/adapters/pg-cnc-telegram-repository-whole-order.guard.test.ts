import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('./pg-cnc-telegram-repository.ts', import.meta.url)), 'utf8');
const classifier = readFileSync(fileURLToPath(new URL('../../../shared/cnc-material/index.ts', import.meta.url)), 'utf8');
const readiness = readFileSync(fileURLToPath(new URL('../../../shared/cnc-material/cut-readiness-sql.ts', import.meta.url)), 'utf8');

describe('MDF whole-order projection', () => {
  it('uses normalized keys and the shared strict MDF classifier', () => {
    const cte = readiness.slice(
      readiness.indexOf('completed_whole_order_keys AS ('),
      readiness.indexOf('whole_order_target_details AS ('),
    );
    expect(cte).toContain('cnc_telegram_packet_whole_order_keys');
    expect(cte).not.toContain('regexp_matches');
    expect(cte).toContain("packet.mdf_relevant AND (packet.completion_status = 'completed' OR packet.thumbs_up = true)");
    expect(cte).not.toContain('visually_cut');
    expect(readiness).toContain("cncPacketCountsForMdfReadinessSql('p')");

    expect(source).toContain("import { mdfCutReadinessCtes } from '../../../shared/cnc-material/cut-readiness-sql'");
    expect(source).not.toContain('function cncPacketCountsForMdfReadinessSql(');
    expect(classifier).toContain('export function cncPacketCountsForMdfReadinessSql(');
    expect(classifier).toContain('.material_name');
    expect(classifier).toContain('.program_name');
    expect(classifier).toContain('.external_packet_key');
    expect(classifier).toContain('.comments_json');
    expect(classifier).toContain('CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE');
    expect(classifier).toContain('CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE');
  });
});
