import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sql = readFileSync(
  fileURLToPath(new URL('./117_dedupe_telegram_svg_image_packets.sql', import.meta.url)),
  'utf8',
);

describe('117_dedupe_telegram_svg_image_packets migration', () => {
  it('merges Telegram SVG/image duplicates by source file basename and archives duplicate jobs', () => {
    expect(sql).toContain('tmp_cnc_telegram_svg_packet_alias_merges');
    expect(sql).toContain("packet.cut_layout_json->>'status' = 'valid'");
    expect(sql).toContain("job.selection_criteria->>'source' = 'cnc_telegram_svg'");
    expect(sql).toContain("regexp_replace(lower(trim(COALESCE(packet.program_name, ''))), '\\.[^.]+$', '') AS program_key");
    expect(sql).toContain("regexp_replace(lower(trim(COALESCE(packet.program_name, ''))), '\\.[^.]+$', '') <> ''");
    expect(sql).toContain('duplicate.cut_layout_json = canonical.cut_layout_json');
    expect(sql).toContain('duplicate.detail_signature IS NOT DISTINCT FROM canonical.detail_signature');
    expect(sql).toContain('CASE WHEN ABS(EXTRACT(EPOCH FROM (canonical.source_at - duplicate.source_at))) <= 600 THEN 0 ELSE 1 END');
    expect(sql).not.toContain('AND ABS(EXTRACT(EPOCH FROM (canonical.source_at - duplicate.source_at))) <= 600');
    expect(sql).toContain('SET cutting_sequence_no = NULL');
    expect(sql).toContain("SET status = 'archived'");
    expect(sql).toContain('UPDATE cnc_telegram_worker_message_logs');
    expect(sql).toContain('UPDATE cnc_telegram_worker_operations');
  });
});
