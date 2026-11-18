import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./299_bazis_product_name_b3d.sql', import.meta.url), 'utf8');
const v109 = readFileSync(new URL('./109_bazis_single_product_reprojection.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

const functionBody = (text: string): string =>
  text.slice(
    text.indexOf('CREATE OR REPLACE FUNCTION reconcile_bazis_panel_order_links('),
    text.indexOf('COMMENT ON FUNCTION reconcile_bazis_panel_order_links'),
  );

describe('migration 299: Bazis product names compared without .b3d', () => {
  it('is one bounded transaction that only redefines the function (no data changes, no reprojection run)', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    const outsideFunction = sql.replace(functionBody(sql), '');
    expect(outsideFunction).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/i);
    expect(outsideFunction).not.toContain('reprojection_candidates');
  });

  it('strips a trailing .b3d from both product names and changes nothing else in the v109 body', () => {
    const body = functionBody(sql);
    expect(body).toContain("))), '\\.b3d$', '')), '') AS product_name,");
    expect(body).toContain(
      "btrim(regexp_replace(lower(btrim(tree.root_product_name)), '\\.b3d$', '')) AS product_name,",
    );
    const normalize = (text: string): string =>
      text
        .replace(/^\s*-- v299:.*\n.*\n/m, '')
        .replace("NULLIF(btrim(regexp_replace(lower(btrim(COALESCE(", 'NULLIF(lower(btrim(COALESCE(')
        .replace("))), '\\.b3d$', '')), '') AS product_name,", "))), '') AS product_name,")
        .replace(
          "btrim(regexp_replace(lower(btrim(tree.root_product_name)), '\\.b3d$', '')) AS product_name,",
          'lower(btrim(tree.root_product_name)) AS product_name,',
        );
    expect(normalize(body)).toBe(functionBody(v109));
  });

  it('marks the function as v299 and has an end-state probe', () => {
    expect(sql).toContain(
      "IS 'v299 exact current-revision panel reconciliation, one-product NULL product, product names without .b3d'",
    );
    expect(runner).toContain('299_bazis_product_name_b3d*) probe_all');
    expect(runner).toMatch(/299_bazis_product_name_b3d\*\)\n\s+probe_file "\$f"/);
  });
});
