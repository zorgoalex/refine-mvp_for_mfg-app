import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildOrderLabelsArchiveFilename } from './pg-labels-repository';

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

  it('discovers detail fields from the live order details view schema', () => {
    expect(source).toMatch(/information_schema\.columns/);
    expect(source).toMatch(/table_name = 'order_details_view'/);
    expect(source).toMatch(/ORDER BY ordinal_position/);
  });

  it('persists field catalog snapshots for label and QR templates', () => {
    expect(source).toMatch(/field_catalog_snapshot/);
    expect(source).toMatch(/JSON\.stringify\(command\.fieldCatalogSnapshot \?\? \{\}\)/);
  });

  it('names order archives from the order name and current generation number', () => {
    expect(buildOrderLabelsArchiveFilename(' Кухня / Север ', 22)).toBe('заказ-Кухня - Север-бирки-22.zip');
    expect(buildOrderLabelsArchiveFilename(null, 4)).toBe('заказ-без-названия-бирки-4.zip');
    expect(buildOrderLabelsArchiveFilename(`${'a'.repeat(119)}😀`, 5)).toBe(`заказ-${'a'.repeat(119)}😀-бирки-5.zip`);
  });
});
