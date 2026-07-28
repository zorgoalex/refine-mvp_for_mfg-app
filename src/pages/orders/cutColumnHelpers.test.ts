import { describe, it, expect } from 'vitest';
import { buildCutJobByDetailId, cutJobDeepLink, cutJobProfileLabel } from './cutColumnHelpers';

describe('cutColumnHelpers', () => {
  it('buildCutJobByDetailId maps each detail to its ref', () => {
    const map = buildCutJobByDetailId([
      { orderDetailId: 1, cutJobId: 9, name: 'A' },
      { orderDetailId: 2, cutJobId: 9, name: 'A' },
    ]);
    expect(map.get(1)?.cutJobId).toBe(9);
    expect(map.get(2)?.name).toBe('A');
    expect(map.has(3)).toBe(false);
  });

  it('cutJobDeepLink builds the /cut?job= path', () => {
    expect(cutJobDeepLink(45)).toBe('/cut?job=45');
  });

  it('cutJobProfileLabel resolves profile display names', () => {
    expect(cutJobProfileLabel({ paramProfileId: null, profileName: null, profileIsActive: null })).toBe('По умолчанию');
    expect(cutJobProfileLabel({ paramProfileId: 7, profileName: 'Вакуумный стол', profileIsActive: true })).toBe('Вакуумный стол');
    expect(cutJobProfileLabel({ paramProfileId: 8, profileName: 'Архивный', profileIsActive: false })).toBe('Архивный (неактивен)');
    expect(cutJobProfileLabel({ paramProfileId: 9, profileName: null, profileIsActive: null })).toBe('Профиль #9');
  });
});
