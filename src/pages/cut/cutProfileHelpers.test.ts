import { describe, expect, it } from 'vitest';
import { resolveProfileLabel, formatArea, describeCutProfile } from './cutProfileHelpers';

const profiles = [
  { cutParamProfileId: 1, name: 'Стандарт', params: {}, isDefault: true, isActive: true, version: 1 },
  { cutParamProfileId: 2, name: 'Быстрый', params: {}, isDefault: false, isActive: true, version: 1 },
  { cutParamProfileId: 3, name: 'Архивный', params: {}, isDefault: false, isActive: false, version: 1 },
];
const settings = [{ key: 'defaults', value: { param_profile: 'Стандарт' }, version: 1 }];

describe('resolveProfileLabel', () => {
  it('names the chosen active profile', () => {
    expect(resolveProfileLabel(2, profiles, settings)).toBe('Быстрый');
  });
  it('marks the chosen profile that is also the runtime default', () => {
    expect(resolveProfileLabel(1, profiles, settings)).toBe('Стандарт (по умолчанию)');
  });
  it('marks a chosen-but-inactive profile as inactive (NOT default)', () => {
    expect(resolveProfileLabel(3, profiles, settings)).toBe('Архивный (неактивен)');
  });
  it('labels unset (null) as a NEUTRAL "По умолчанию" — never names the current default profile', () => {
    // null = create-time snapshot, which may differ from the current default;
    // naming "Стандарт" here would misrepresent what calculate uses.
    expect(resolveProfileLabel(null, profiles, settings)).toBe('По умолчанию');
    expect(resolveProfileLabel(null, [], [])).toBe('По умолчанию');
  });
  it('falls back to a stable label for an id missing from the list', () => {
    expect(resolveProfileLabel(99, profiles, settings)).toBe('Профиль #99');
  });
});

describe('formatArea', () => {
  it('formats to 2 dp', () => {
    expect(formatArea(4.5)).toBe('4.50');
    expect(formatArea(0)).toBe('0.00');
  });
});

describe('describeCutProfile', () => {
  it('vacuum_table + optimal → авто text', () => {
    expect(describeCutProfile({ layout_mode: 'vacuum_table', vacuum: { direction: 'optimal' } })).toBe(
      'Вакуумный стол (авто): пробует ряды и вдоль, и поперёк листа, берёт вариант с большим заполнением (≥ вдоль/поперёк по эффективности).'
    );
  });

  it('vacuum_table + width → вдоль text', () => {
    expect(describeCutProfile({ layout_mode: 'vacuum_table', vacuum: { direction: 'width' } })).toBe(
      'Вакуумный стол (вдоль): ряды деталей идут вдоль ширины листа — жёсткая ориентация рядов (под канавки/подачу стола).'
    );
  });

  it('vacuum_table + height → поперёк text', () => {
    expect(describeCutProfile({ layout_mode: 'vacuum_table', vacuum: { direction: 'height' } })).toBe(
      'Вакуумный стол (поперёк): ряды идут вдоль высоты листа — жёсткая ориентация рядов.'
    );
  });

  it('vacuum_table without direction → авто text (optimal fallback)', () => {
    expect(describeCutProfile({ layout_mode: 'vacuum_table' })).toBe(
      'Вакуумный стол (авто): пробует ряды и вдоль, и поперёк листа, берёт вариант с большим заполнением (≥ вдоль/поперёк по эффективности).'
    );
    expect(describeCutProfile({ layout_mode: 'vacuum_table', vacuum: {} })).toBe(
      'Вакуумный стол (авто): пробует ряды и вдоль, и поперёк листа, берёт вариант с большим заполнением (≥ вдоль/поперёк по эффективности).'
    );
  });

  it('guillotine → гильотинный text', () => {
    expect(describeCutProfile({ layout_mode: 'guillotine' })).toBe(
      'Гильотинный рез: сквозные прямые резы (полосами).'
    );
  });

  it('nested → вложенный text', () => {
    expect(describeCutProfile({ layout_mode: 'nested' })).toBe(
      'Вложенный раскрой: детали плотно вкладываются друг в друга.'
    );
  });

  it('unknown layout_mode → гильотинный text (fallback)', () => {
    expect(describeCutProfile({ layout_mode: 'unknown_mode' })).toBe(
      'Гильотинный рез: сквозные прямые резы (полосами).'
    );
    expect(describeCutProfile({})).toBe(
      'Гильотинный рез: сквозные прямые резы (полосами).'
    );
  });
});
