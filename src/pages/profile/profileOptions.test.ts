import { describe, expect, it } from 'vitest';
import { UI_VARIANTS } from '../../ui-variant/uiVariant';
import { profileInitials, profileRoleName, uiVariantCards } from './profileOptions';

describe('profile (NewLine)', () => {
  it('names roles in Russian and keeps unknown codes', () => {
    expect(profileRoleName('manager')).toBe('Менеджер');
    expect(profileRoleName('custom_role')).toBe('custom_role');
    expect(profileRoleName(undefined)).toBe('—');
  });

  it('takes initials from a name or a login', () => {
    expect(profileInitials('Тест Иванов')).toBe('ТИ');
    expect(profileInitials('codex_playwright')).toBe('CP');
    expect(profileInitials('admin')).toBe('AD');
    expect(profileInitials('')).toBe('?');
  });

  it('offers a card for every interface variant exactly once', () => {
    expect(uiVariantCards.map((card) => card.value).sort()).toEqual([...UI_VARIANTS].sort());
  });
});
