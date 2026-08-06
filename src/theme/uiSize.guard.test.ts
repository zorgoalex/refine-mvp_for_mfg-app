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
    // critic R1 (mixed deploy): старый backend стрипает uiSize из ответа —
    // каждое чтение response.preferences.uiSize обязано идти через isUiSize
    const readingLines = themeProvider
      .split('\n')
      .filter((line) => line.includes('response.preferences.uiSize'));
    expect(readingLines.length).toBeGreaterThan(0);
    for (const line of readingLines) {
      expect(line).toContain('isUiSize(response.preferences.uiSize)');
    }
    // critic R2: смена юзера в том же браузере не должна наследовать чужой
    // компакт — на auth-change state сбрасывается в per-user кэш ?? default
    expect(themeProvider).toContain("setUiSizeState(cachedSize ?? 'default')");
    // critic R3: протухший PATCH-ответ (сессия сменилась в полёте) не должен
    // перезаписывать state/кэш нового юзера
    expect(themeProvider).toMatch(/if \(getCurrentUserId\(\) !== userId\) \{\s*return;/);
    // critic R4: GET-ответ тоже применяется только под originating userId
    expect(themeProvider).toMatch(/responseSize && getCurrentUserId\(\) === userId/);
    expect(themeProvider).toContain('setStoredUiSize(userId, responseSize)');
  });

  it('App: ConfigProvider componentSize управляется uiSize', () => {
    expect(app).toMatch(/componentSize=\{uiSize === 'small' \? 'small' : undefined\}/);
  });

  it('профиль: видимый чекбокс «Компактный интерфейс»', () => {
    expect(profilePage).toContain('Компактный интерфейс');
    expect(profilePage).toContain('setUiSize');
  });

  it('профиль: доступная кнопка принудительного планшетного вида', () => {
    expect(themeStorage).toContain('tabletModeStorageKey');
    expect(themeProvider).toContain('tabletMode');
    expect(themeProvider).toContain('setTabletMode');
    expect(themeProvider).toContain('profileApi.updatePreferences({ tabletMode: enabled })');
    expect(profilePage).toContain('Планшетный вид');
    expect(profilePage).toContain('aria-pressed={tabletMode}');
    expect(profilePage).toContain('style={{ minHeight: 44 }}');
  });
});
