import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./104_bazis_panel_order_links.sql', import.meta.url), 'utf8');

describe('104 Bazis imported panel order links migration', () => {
  it('adds imported provenance without weakening existing mapping kinds', () => {
    expect(sql).toMatch(/mapping_kind[\s\S]*'created'[\s\S]*'ignored'[\s\S]*'manual'[\s\S]*'imported'/i);
    expect(sql).toMatch(/import_source/i);
    expect(sql).toMatch(/imported_by/i);
    expect(sql).toMatch(/request_id/i);
  });

  it('matches only complete exact identities in current revisions', () => {
    expect(sql).toMatch(/current_revision_id/i);
    expect(sql).toMatch(/basis_project/i);
    expect(sql).toMatch(/basis_product/i);
    expect(sql).toMatch(/basis_designation/i);
    expect(sql).toMatch(/basis_data/i);
    expect(sql).toMatch(/data_designation/i);
    expect(sql).toMatch(/project_count\s*=\s*1/i);
    expect(sql).toMatch(/detail_count\s*=\s*panel_count/i);
  });

  it('does not invent detail pairing for duplicate identity groups', () => {
    expect(sql).toMatch(/CASE\s+WHEN\s+safe\.detail_count\s*=\s*1[\s\S]*ELSE\s+NULL/i);
    expect(sql).not.toMatch(/row_number\s*\(/i);
  });

  it('locks current revisions and records historical exact-safe links idempotently', () => {
    expect(sql).toMatch(/FOR\s+KEY\s+SHARE/i);
    expect(sql).toMatch(/ORDER\s+BY\s+[^;]*bazis_revision_id/i);
    expect(sql).toMatch(/historical_backfill/i);
    expect(sql).toMatch(/ON\s+CONFLICT\s*\(node_id,\s*order_id\)\s+DO\s+NOTHING/i);
  });

  it('allows old detail mappings only for exact current-revision reprojection', () => {
    expect(sql).toMatch(
      /p_source\s*=\s*'revision_reprojection'[\s\S]*OR\s+NOT\s+EXISTS\s*\([\s\S]*existing_detail_map\.order_detail_id\s*=\s*detail\.detail_id/i,
    );
    expect(sql).toMatch(
      /existing_node_map\.node_id\s*=\s*tree\.bazis_node_id[\s\S]*existing_node_map\.order_id\s*=\s*p_order_id/i,
    );
  });

  it('contains no broad destructive data operation', () => {
    expect(sql).not.toMatch(/\b(?:DELETE|TRUNCATE|DROP TABLE)\b/i);
  });
});
