import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Node-тест-env без jsdom: контракт per-user настройки «Компактный интерфейс»
 * фиксируем source-text guard'ами. uiSize — backend-предпочтение профиля
 * (user_preferences.ui_size), паттерн идентичен themeMode: per-user
 * localStorage-кэш + синк через profileApi; глобально применяется через
 * ConfigProvider componentSize.
 */
const themeStorage = readFileSync(new URL('./themeStorage.ts', import.meta.url), 'utf8');
const themeProvider = readFileSync(new URL('./ThemeProvider.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const profilePage = readFileSync(new URL('../pages/profile/index.tsx', import.meta.url), 'utf8');

describe('per-user uiSize preference', () => {
  it('storage: per-user ключ и валидация значений', () => {
    expect(themeStorage).toContain('uiSizeStorageKey');
    expect(themeStorage).toContain('getStoredUiSize');
    expect(themeStorage).toContain('setStoredUiSize');
  });

  it('ThemeProvider тянет uiSize из того же getPreferences и отдаёт setUiSize', () => {
    expect(themeProvider).toContain('uiSize');
    expect(themeProvider).toContain('setUiSize');
    expect(themeProvider).toMatch(/preferences\.uiSize/);
  });

  it('App: ConfigProvider componentSize управляется uiSize', () => {
    expect(app).toMatch(/componentSize=\{uiSize === 'small' \? 'small' : undefined\}/);
  });

  it('профиль: видимый чекбокс «Компактный интерфейс»', () => {
    expect(profilePage).toContain('Компактный интерфейс');
    expect(profilePage).toContain('setUiSize');
  });
});
