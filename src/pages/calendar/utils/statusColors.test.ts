import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getMaterialsForCard, hasDrawnProductionStatus, areAllProductionStagesReady, MANUAL_STAGE_LETTER_COLOR } from './statusColors';

describe('all production ready uses ordinary detail composition', () => {
  it('does not trust a packed header, ignore nulls or accept an empty order', () => {
    for (const details of [[], [{ production_status_name: 'Упакован' }, { production_status_name: null }],
      [{ production_status_name: 'Упакован' }, { production_status_name: 'Распилен' }]]) {
      expect(areAllProductionStagesReady({ production_status_name: 'Упакован', order_details: details })).toBe(false);
    }
  });
  it('accepts all packed details without including deleted ones', () => {
    expect(areAllProductionStagesReady({ production_detail_count: 2, order_details: [
      { production_status_name: 'Упакован' }, { production_status_name: 'Упакован' },
      { production_status_name: null, delete_flag: true },
    ] })).toBe(true);
  });
});

describe('calendar material card tags', () => {
  it('renders short material tags from resolved sheet material names', () => {
    const details = [
      { material: { material_name: 'МДФ 18мм - белый' } },
      { material: { material_name: 'ЛДСП Дуб' } },
      { material: { material_name: 'МДФ 18мм - белый' } },
    ];

    expect(getMaterialsForCard(details, true)).toEqual([
      { name: '18мм', fullName: 'МДФ 18мм - белый' },
      { name: 'ЛДСП', fullName: 'ЛДСП Дуб' },
    ]);
  });

  it('keeps hiding default MDF 16mm from standard calendar cards', () => {
    const details = [
      { material: { material_name: 'МДФ 16мм' } },
      { material: { material_name: 'МДФ 16 мм' } },
      { material: { material_name: 'МДФ 8мм' } },
    ];

    expect(getMaterialsForCard(details, true)).toEqual([
      { name: '8мм', fullName: 'МДФ 8мм' },
    ]);
  });

  it('shows draft MDF 16mm because it is not the default hidden material', () => {
    const details = [
      { material: { material_name: 'Черновой МДФ 16мм' } },
      { material: { material_name: 'МДФ 16мм' } },
    ];

    expect(getMaterialsForCard(details, true)).toEqual([
      { name: 'Черн. 16мм', fullName: 'Черновой МДФ 16мм' },
    ]);
  });

  it('renders every plywood variant with the lowercase plywood code', () => {
    const details = [
      { material: { material_name: 'Фанера 2500*1250 10мм' } },
      { material: { material_name: 'ФАНЕРА' } },
    ];

    expect(getMaterialsForCard(details, true)).toEqual([
      { name: 'фанера', fullName: 'Фанера 2500*1250 10мм' },
      { name: 'фанера', fullName: 'ФАНЕРА' },
    ]);
  });

  it('does not gate calendar resolved material names on the old sheetMaterialsReads flag', () => {
    const source = readFileSync(
      resolve(__dirname, '../hooks/useCalendarData.ts'),
      'utf8',
    );
    const resolvedMaterialFetch = source.split("resource: 'order_details_view'")[1] ?? '';

    expect(resolvedMaterialFetch).toContain("enabled: orderIds.length > 0");
    expect(resolvedMaterialFetch).not.toContain('sheetMaterialsReads');
  });
});

describe('calendar drawn production indicator', () => {
  it('shows the pencil only when the projection contains drawn', () => {
    expect(hasDrawnProductionStatus({ passedProductionCodes: ['drawn'] })).toBe(true);
    expect(hasDrawnProductionStatus({ passedProductionCodes: ['cut', 'paint'] })).toBe(false);
    expect(hasDrawnProductionStatus({})).toBe(false);
  });

  it('ignores order and detail status names', () => {
    expect(hasDrawnProductionStatus({
      production_status_name: ' Отрисован ',
      order_details: [{ production_status_name: 'Отрисован' }],
      passedProductionCodes: [],
    } as never)).toBe(false);
  });
});

describe('manual stage letter colour', () => {
  it('is a distinct token', () => {
    expect(MANUAL_STAGE_LETTER_COLOR).toMatch(/^#[0-9a-f]{6}$/i);
    expect(MANUAL_STAGE_LETTER_COLOR).not.toBe('#fa8c16');
    expect(MANUAL_STAGE_LETTER_COLOR).not.toBe('#d46b08');
    expect(MANUAL_STAGE_LETTER_COLOR).not.toBe('#52c41a');
  });
});

describe('manual stage letters and the saw status', () => {
  it('renders manual letters with the manual colour in every letters renderer', () => {
    const display = readFileSync(resolve(__dirname, '../../../components/ProductionStagesDisplay.tsx'), 'utf8');
    expect(display).toContain('manualSet.has(stage.code) ? manualColor : passedColor');
    for (const file of ['OrderCard.tsx', 'OrderCardCompact.tsx', 'DayColumnBrief.tsx']) {
      expect(readFileSync(resolve(__dirname, '../components', file), 'utf8')).toContain('manualCodes=');
    }
    for (const file of ['../../orders/list.tsx', '../../orders/mobile/OrderCardList.tsx', '../../orders/components/sections/OrderShowHeader.tsx', '../../orders/components/sections/OrderHeaderSummary.tsx']) {
      expect(readFileSync(resolve(__dirname, file), 'utf8')).toContain('manualCodes=');
    }
  });

  it('maps saw to the letter Б right after drawn', async () => {
    const { PRODUCTION_STATUS_CODE_LETTERS, PRODUCTION_STATUS_DISPLAY_ORDER } = await import('../../../types/orders');
    expect(PRODUCTION_STATUS_CODE_LETTERS.saw).toBe('Б');
    expect(PRODUCTION_STATUS_CODE_LETTERS.film_purchase).toBe('П');
    expect(PRODUCTION_STATUS_DISPLAY_ORDER.indexOf('saw')).toBe(PRODUCTION_STATUS_DISPLAY_ORDER.indexOf('drawn') + 1);
  });
});

describe('milling on calendar cards: «выборка» and «неоклассика» are shown and accented', () => {
  const details = (...names: string[]) => names.map((name) => ({ milling_type: { milling_type_name: name } }));
  it('names them explicitly', async () => {
    const { getMillingDisplayValue, isAccentMilling } = await import('./statusColors');
    expect(getMillingDisplayValue(details('модерн', 'неоклассика арка') as never)).toBe('Неоклассика');
    expect(getMillingDisplayValue(details('Неоклассика Люкс') as never)).toBe('Неоклассика');
    expect(getMillingDisplayValue(details('выборка-1ступень', 'модерн') as never)).toBe('Выборка');
    expect(getMillingDisplayValue(details('выборка арка', 'неоклассика') as never)).toBe('Выборка, неоклассика');
    expect(getMillingDisplayValue(details('крупная лапша') as never)).toBe('Фрезеровка');
    expect(getMillingDisplayValue(details('модерн') as never)).toBe('Модерн');
    expect(isAccentMilling('Неоклассика')).toBe(true);
    expect(isAccentMilling('Выборка, неоклассика')).toBe(true);
    expect(isAccentMilling('Фрезеровка')).toBe(false);
    expect(isAccentMilling(undefined)).toBe(false);
  });
});
