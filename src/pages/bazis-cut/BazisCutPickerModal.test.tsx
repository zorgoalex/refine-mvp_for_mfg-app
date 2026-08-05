import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import { validatePickerPeriod } from './BazisCutPickerModal';

const source = readFileSync(new URL('./BazisCutPickerModal.tsx', import.meta.url), 'utf8');
const list = readFileSync(new URL('./BazisCutListPage.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('./BazisCutPickerModal.css', import.meta.url), 'utf8');

describe('Basis-cut detail picker UI', () => {
  it('enforces the inclusive 366-day period before enabling other filters', () => {
    expect(validatePickerPeriod(null)).toBeNull();
    expect(validatePickerPeriod([dayjs('2024-01-01'), dayjs('2024-12-31')])).toBeNull();
    expect(validatePickerPeriod([dayjs('2024-01-01'), dayjs('2025-01-01')]))
      .toBe('Период не может превышать 366 дней');
    expect(source).toContain('const filtersDisabled = !period || Boolean(periodError)');
    expect(source.indexOf('1. Период заказов')).toBeLessThan(source.indexOf('label="Номер заказа"'));
  });

  it('renders every requested dynamic multi-select and 25-row search contract', () => {
    for (const label of [
      'Номер заказа', 'Клиент', 'Материал', 'Фрезеровка', 'Базис-проект / Базис-заказ',
      'Конструктор', 'Присадка',
    ]) expect(source).toContain(`label="${label}"`);
    expect(source).toContain('mode="multiple"');
    expect(source).toContain('const PAGE_SIZE = 25');
    expect(source).toContain('scroll={{ x: 2080, y: 480 }}');
    expect(source).toContain('Убрать из списка');
    expect(source).toContain('Вернуть убранные');
    expect(source).toContain('Создать набор (');
  });

  it('shows all-list and selected totals and exposes picker only to cut managers', () => {
    expect(source).toContain('title="В списке"');
    expect(source).toContain('title="Выбрано"');
    expect(source).toContain('totalAreaM2');
    expect(list).toContain("const canManage = can('cut.manage')");
    expect(list).toContain('Подобрать детали');
    expect(styles).toContain('min-height: 40px');
    expect(styles).not.toContain('transition: all');
  });

  it('invalidates in-flight reads without a period and freezes selection during create', () => {
    expect(source).toMatch(/const epoch = \+\+facetEpoch\.current;\s+if \(!open \|\| !period \|\| periodError\)/);
    expect(source).toMatch(/const epoch = \+\+searchEpoch\.current;\s+if \(!open \|\| !criteria\)/);
    expect(source).toMatch(/const changePeriod[\s\S]*?facetEpoch\.current \+= 1;\s+searchEpoch\.current \+= 1;/);
    expect(source).toContain('disabled={!criteria || !criteriaHash || selectedById.size === 0 || creating}');
    expect(source).toContain('getCheckboxProps: () => ({ disabled: creating || !criteria || !criteriaHash })');
    expect(source).toContain('if (creating) return;');
    expect(source).toMatch(/const removeSelected[\s\S]*?setExcludedDetailIds\(next\);[\s\S]*?setCriteriaHash\(''\);/);
    expect(source).toMatch(/const restoreExcluded[\s\S]*?setExcludedDetailIds\(\[\]\);[\s\S]*?setCriteriaHash\(''\);/);
  });
});
