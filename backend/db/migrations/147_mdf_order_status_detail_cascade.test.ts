import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  fileURLToPath(new URL('./147_mdf_order_status_detail_cascade.sql', import.meta.url)),
  'utf8',
);

describe('147_mdf_order_status_detail_cascade migration', () => {
  it('installs the three guarded order-to-detail rules', () => {
    expect(sql).toContain("'Выдан -> проз-во Выдан'");
    expect(sql).toContain("'Готов к выдаче -> произ-во Упакован'");
    expect(sql).toContain("'В производстве после готовности -> произ-во Закатан'");
    expect(sql).toContain("'previousOrderStatusIn'");
    expect(sql).toContain("'advance_only'");
    expect(sql).toContain("'set_exact'");
  });

  it('updates existing named rules and inserts only missing rules', () => {
    expect(sql).toContain('UPDATE status_automation_rules rule');
    expect(sql).toContain('NOT EXISTS (');
    expect(sql).toContain('WHERE existing.name = desired.name');
  });
});
