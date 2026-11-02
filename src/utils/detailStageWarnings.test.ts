import { describe, expect, it } from 'vitest';
import { buildDetailStageWarningTexts } from './detailStageWarnings';

describe('detail stage warnings', () => {
  it('words the CNC and Bazis warnings in Russian', () => {
    expect(buildDetailStageWarningTexts([
      { code: 'DETAIL_ALSO_IN_CNC', detailId: 1, orderId: 5, cutJobIds: [9] },
    ])).toEqual(['Деталь уже в задании ЧПУ — добавлена, статус не изменён']);
    expect(buildDetailStageWarningTexts([
      { code: 'DETAIL_ALSO_IN_BAZIS', detailId: 1, orderId: 5, bazisCutSetIds: [3] },
    ])).toEqual(['Деталь уже в карточке «Базис раскрой» — добавлена в задание ЧПУ']);
  });

  it('groups several details per code and ignores absent warnings', () => {
    const texts = buildDetailStageWarningTexts([
      { code: 'DETAIL_ALSO_IN_CNC', detailId: 1, orderId: 5, cutJobIds: [9] },
      { code: 'DETAIL_ALSO_IN_CNC', detailId: 2, orderId: 5, cutJobIds: [9] },
    ]);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('деталей: 2');
    expect(buildDetailStageWarningTexts(undefined)).toEqual([]);
  });
});
