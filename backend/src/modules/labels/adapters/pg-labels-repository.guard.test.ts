import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./pg-labels-repository.ts', import.meta.url), 'utf8');

describe('PgLabelsRepository structural guards', () => {
  it('requires row version when updating existing order label data', () => {
    expect(source).toMatch(/beforeVersion != null && row\.version == null/);
    expect(source).toMatch(/OrderLabelDataStaleVersionError\(row\.detailId,\s*null,\s*beforeVersion\)/);
  });

  it('uses command idempotency for non-generation label writes', () => {
    expect(source).toMatch(/label_template\.create/);
    expect(source).toMatch(/label_template\.update/);
    expect(source).toMatch(/label_template\.delete/);
    expect(source).toMatch(/order_label_data\.update/);
  });

  it('deactivates templates without tombstoning rows needed by saved label data', () => {
    expect(source).toMatch(/SET is_active=false, version=version\+1/);
    expect(source).not.toMatch(/deleted_at=COALESCE\(deleted_at, now\(\)\)/);
  });
});
