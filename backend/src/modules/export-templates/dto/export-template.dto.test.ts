import { describe, expect, it } from 'vitest';
import { previewExportTemplateSchema, updateExportTemplateSchema } from './export-template.dto';

const columns = [{
  columnKey: 'position',
  header: 'Позиция',
  expression: { type: 'field' as const, field: 'detail.position' },
}];

describe('export template endpoint DTOs', () => {
  it('accepts the exact update contract and rejects immutable fields', () => {
    const body = {
      name: 'Шаблон', description: null, sheetName: 'Раскрой', schemaVersion: 1 as const,
      columns, isActive: true, expectedVersion: 2, idempotencyKey: 'update-template-2',
    };
    expect(updateExportTemplateSchema.safeParse(body).success).toBe(true);
    expect(updateExportTemplateSchema.safeParse({ ...body, targetScreen: 'bazis_cut_set' }).success).toBe(false);
  });

  it('accepts the exact preview contract and rejects full editor drafts', () => {
    const body = {
      targetScreen: 'bazis_cut_set' as const,
      sourceType: 'bazis_cut_set_detail' as const,
      format: 'xls_biff8' as const,
      columns,
    };
    expect(previewExportTemplateSchema.safeParse(body).success).toBe(true);
    expect(previewExportTemplateSchema.safeParse({ ...body, name: 'Лишнее поле' }).success).toBe(false);
  });
});
