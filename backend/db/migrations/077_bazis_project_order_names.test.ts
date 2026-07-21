import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL('./077_bazis_project_order_names.sql', import.meta.url),
  'utf8',
);

describe('077 Bazis project order names migration', () => {
  it('uses latest effective Bazis order name and preserves manually named projects', () => {
    expect(sql).toContain("NULLIF(btrim(r.bazis_order_no), '')");
    expect(sql).toContain("n.raw_json->>'Заказ'");
    expect(sql).toMatch(/ORDER BY r\.bazis_project_id,[\s\S]*r\.revision_no DESC/i);
    expect(sql).toContain('legacy_revision.product_name = project.name');
    expect(sql).toContain('project.name IS DISTINCT FROM latest.order_name');
  });
});
