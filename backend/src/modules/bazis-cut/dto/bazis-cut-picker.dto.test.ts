import { describe, expect, it } from 'vitest';
import {
  bazisCutPickerCriteriaSchema,
  bazisCutPickerPeriodSchema,
  createBazisCutSetFromPickerSchema,
  searchBazisCutPickerSchema,
} from './bazis-cut.dto';

describe('Basis-cut detail-picker schemas', () => {
  it('requires the period and accepts an inclusive 366-day range', () => {
    expect(bazisCutPickerPeriodSchema.parse({ dateFrom: '2024-01-01', dateTo: '2024-12-31' }))
      .toEqual({ dateFrom: '2024-01-01', dateTo: '2024-12-31' });
    expect(() => bazisCutPickerPeriodSchema.parse({})).toThrow();
    expect(() => bazisCutPickerPeriodSchema.parse({ dateFrom: '2024-01-01', dateTo: '2025-01-01' }))
      .toThrow('Период не может превышать 366 дней');
  });

  it('defaults filters, bounds arrays, and rejects unknown properties', () => {
    const criteria = bazisCutPickerCriteriaSchema.parse({
      dateFrom: '2026-08-01', dateTo: '2026-08-05',
    });
    expect(criteria).toMatchObject({
      orderIds: [], clientIds: [], sheetMaterialTypeIds: [], millingTypeIds: [], bazisKeys: [],
      designEngineerIds: [], dowelingOrderIds: [], excludedDetailIds: [],
    });
    expect(() => searchBazisCutPickerSchema.parse({
      dateFrom: '2026-08-01', dateTo: '2026-08-05', extra: true,
    })).toThrow();
    expect(() => bazisCutPickerCriteriaSchema.parse({
      dateFrom: '2026-08-01', dateTo: '2026-08-05', excludedDetailIds: Array.from({ length: 2001 }, (_, index) => index + 1),
    })).toThrow();
  });

  it('requires bounded selected details and SHA-256 tokens for creation', () => {
    const validHash = 'a'.repeat(64);
    expect(createBazisCutSetFromPickerSchema.parse({
      criteria: { dateFrom: '2026-08-01', dateTo: '2026-08-05' },
      criteriaHash: validHash,
      details: [{ detailId: 10, selectionToken: 'b'.repeat(64) }],
    }).details).toHaveLength(1);
    expect(() => createBazisCutSetFromPickerSchema.parse({
      criteria: { dateFrom: '2026-08-01', dateTo: '2026-08-05' },
      criteriaHash: 'bad', details: [],
    })).toThrow();
  });
});
