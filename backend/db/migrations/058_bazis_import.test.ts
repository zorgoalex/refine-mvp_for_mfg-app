import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./058_bazis_import.sql', import.meta.url), 'utf8');

describe('058_bazis_import migration', () => {
  it('creates all seven bazis tables idempotently', () => {
    for (const table of [
      'bazis_projects',
      'bazis_project_revisions',
      'bazis_nodes',
      'bazis_material_mappings',
      'bazis_node_order_detail_map',
      'bazis_order_links',
      'bazis_import_runs',
    ]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'i'));
    }
  });

  it('links bazis_projects to projects parent entity', () => {
    expect(sql).toMatch(/project_id\s+bigint NOT NULL REFERENCES projects\(project_id\)/i);
  });

  it('stores immutable revision with sha256 dedup per bazis project', () => {
    expect(sql).toMatch(/xml_sha256\s+text NOT NULL/i);
    expect(sql).toMatch(/raw_xml\s+bytea NOT NULL/i);
    expect(sql).toMatch(/UNIQUE \(bazis_project_id, xml_sha256\)/i);
    expect(sql).toMatch(/UNIQUE \(bazis_project_id, revision_no\)/i);
  });

  it('keeps full node payload in raw_json and indexes tree traversal', () => {
    expect(sql).toMatch(/raw_json\s+jsonb NOT NULL/i);
    expect(sql).toMatch(/bazis_nodes_revision_type_idx/i);
    expect(sql).toMatch(/bazis_nodes_parent_idx/i);
  });

  it('enforces one-target material mapping keyed by source context', () => {
    expect(sql).toMatch(/source_kind\s+text NOT NULL CHECK \(source_kind IN \('sheet','film','edge'\)\)/i);
    expect(sql).toMatch(/target_kind\s+text NOT NULL CHECK \(target_kind IN \('sheet','film','edge','ignore'\)\)/i);
    expect(sql).toMatch(/ON bazis_material_mappings \(source_kind, lower\(bazis_name\)\)/i);
  });

  it('keeps referential integrity to orders and details', () => {
    expect(sql).toMatch(/order_id\s+bigint NOT NULL REFERENCES orders\(order_id\) ON DELETE CASCADE/i);
    expect(sql).toMatch(/order_detail_id\s+bigint NULL REFERENCES order_details\(detail_id\) ON DELETE SET NULL/i);
  });

  it('never drops columns', () => {
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
  });
});
