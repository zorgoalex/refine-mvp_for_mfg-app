import { describe, expect, it } from 'vitest';
import { extractLabelFields, parseDate } from './label-text-extraction';

describe('extractLabelFields (fixtures = сырой OCR-вывод прототипа 2026-07-04)', () => {
  it('чистая бирка (paddle label1)', () => {
    const f = extractLabelFields([':N', '2590', 'Заказ№: 548-16мм МДФ', 'Поз. 27', 'МДФ 16 мм', '902 X 596', '24.06.2026', 'Бир.№', '1/0']);
    expect(f.orderName).toBe('548-16мм МДФ');
    expect(f.detailNumber).toBe(27);
    expect(f.width).toBe(902);
    expect(f.height).toBe(596);
    expect(f.date).toBe('24.06.2026');
    expect(f.material).toBe('МДФ 16мм');
  });
  it('З→3 в «Поз» (paddle label15)', () => {
    const f = extractLabelFields(['2590', 'Заказ№: 548-16мм МДФ', 'По3.36', 'МДФ 16 мм', '90 X 2040']);
    expect(f.detailNumber).toBe(36);
    expect(f.width).toBe(90);
    expect(f.height).toBe(2040);
  });
  it('кириллическая Х и Хх как разделитель (tesseract label1/label25)', () => {
    expect(extractLabelFields(['902Хх 596']).width).toBe(902);
    expect(extractLabelFields(['2400Х% 95']).height).toBe(95);
  });
  it('пусто при мусоре', () => {
    const f = extractLabelFields(['33N: 548-16 Φ', 'о2х5эв']);
    expect(f.detailNumber).toBeUndefined();
    expect(f.width).toBeUndefined();
  });
  it('«37БХ 598» (tesseract label35: 375→37Б) НЕ даёт ложную ширину 37', () => {
    const f = extractLabelFields(['37БХ 598']);
    // буква прилипла к числу → доверять нельзя: размер НЕ извлекается
    expect(f.width).toBeUndefined();
    expect(f.height).toBeUndefined();
  });
  it('дата не принимается за размеры', () => {
    const f = extractLabelFields(['24.06.2026']);
    expect(f.width).toBeUndefined();
    expect(f.date).toBe('24.06.2026');
  });
  it('распознаёт ЛДСП как материал (с толщиной и без)', () => {
    const f = extractLabelFields(['ЛДСП белый 16 мм']);
    expect(f.material).toContain('ЛДСП');
    // толщина сразу за «ЛДСП» (без слов между) — извлекается
    const g = extractLabelFields(['ЛДСП 16 мм']);
    expect(g.material).toBe('ЛДСП 16мм');
    // без толщины вовсе — просто «ЛДСП»
    const h = extractLabelFields(['ЛДСП белый']);
    expect(h.material).toBe('ЛДСП');
  });

  it('orderName обрезается до «Поз» и не тащит хвосты', () => {
    const f = extractLabelFields(['Заказ№: 548-16мм МДФ Поз. 27 МДФ 16 мм']);
    expect(f.orderName).toBe('548-16мм МДФ');
    const g = extractLabelFields(['Заказ№: 548-16мм МДФ', 'Бир.№ 1/0']);
    expect(g.orderName).toBe('548-16мм МДФ');
  });

  it('parseDate принимает и 2-, и 4-значный год (dd.mm.yy(yy))', () => {
    expect(parseDate('00.00.17')).toBe('00.00.17');
    expect(parseDate('24.06.26')).toBe('24.06.26');
    expect(parseDate('24.06.2026')).toBe('24.06.2026');
  });
});
