import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(join(__dirname, '110_cnc_telegram_label_maps.sql'), 'utf8');

describe('110 CNC Telegram label maps migration', () => {
  it('keeps raw evidence versioned and immutable', () => {
    expect(sql).toContain('cnc_telegram_packet_evidence_set');
    expect(sql).toContain('cnc_telegram_packet_item_evidence');
    expect(sql).toContain('UNIQUE (packet_id, source_version, source_item_key)');
    expect(sql).toContain('reject_cnc_telegram_label_immutable_mutation');
  });

  it('isolates label-only maps from cut result projections', () => {
    expect(sql).toContain('cnc_telegram_label_sheet_map');
    expect(sql).toContain('cnc_telegram_label_placement');
    expect(sql).not.toContain('INSERT INTO cut_result_placement');
  });

  it('freezes image assets and rejects dual row provenance', () => {
    expect(sql).toContain('label_generation_media_asset');
    expect(sql).toContain('label_generation_telegram_source');
    expect(sql).toContain('fk_label_generation_telegram_source_sheet');
    expect(sql).toContain('fk_label_generation_telegram_source_placement');
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain("TG_TABLE_NAME = 'label_generation_cut_placement'");
    expect(sql).toContain("source_kind = 'telegram_image' AND media_asset_key IS NOT NULL AND media_asset_key = asset_key");
    expect(sql).toContain('trg_label_generation_cut_placement_immutable');
  });
});
