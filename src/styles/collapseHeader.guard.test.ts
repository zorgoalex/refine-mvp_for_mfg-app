import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Node-тест-env без jsdom: стилевой контракт фиксируем source-text guard'ом.
 * Стандарт высоты спойлеров ГЛОБАЛЬНЫЙ: заголовок Collapse вдвое ниже
 * antd-дефолта (46px → ~24px), значения совпадают с проверенным
 * .compact-collapse (форма заказа). Новые спойлеры получают стандарт
 * автоматически — без классов.
 */
const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8');

describe('global compact collapse header', () => {
  it('глобальное правило: заголовок спойлера 24px (в два раза ниже дефолта)', () => {
    // без классов — применяется ко ВСЕМ .ant-collapse-header приложения
    const rule = appCss.match(/^\.ant-collapse > \.ant-collapse-item > \.ant-collapse-header \{[\s\S]*?\}/m);
    expect(rule?.[0]).toBeTruthy();
    expect(rule?.[0]).toContain('min-height: 24px');
    expect(rule?.[0]).toMatch(/padding: 4px 12px/);
    expect(rule?.[0]).toMatch(/line-height: 1\.2/);
  });

  it('иконка-стрелка уменьшена под новую высоту', () => {
    expect(appCss).toMatch(/^\.ant-collapse \.ant-collapse-arrow \{[\s\S]*?font-size: 10px/m);
    // НИКАКИХ overrides сверх проверенного .compact-collapse baseline
    // (critic: глобальный height на expand-icon — непроверенное изобретение)
    const iconRule = appCss.match(/^\.ant-collapse \.ant-collapse-expand-icon \{[\s\S]*?\}/m);
    expect(iconRule?.[0]).toBeTruthy();
    expect(iconRule?.[0]).not.toContain('height');
  });

  it('глобальный стандарт = точная копия проверенного .compact-collapse', () => {
    const globalHeader = appCss.match(/^\.ant-collapse > \.ant-collapse-item > \.ant-collapse-header \{([\s\S]*?)\}/m)?.[1];
    const legacyHeader = appCss.match(/^\.compact-collapse \.ant-collapse-header \{([\s\S]*?)\}/m)?.[1];
    expect(globalHeader?.trim()).toBe(legacyHeader?.trim());
    const globalIcon = appCss.match(/^\.ant-collapse \.ant-collapse-expand-icon \{([\s\S]*?)\}/m)?.[1];
    const legacyIcon = appCss.match(/^\.compact-collapse \.ant-collapse-expand-icon \{([\s\S]*?)\}/m)?.[1];
    expect(globalIcon?.trim()).toBe(legacyIcon?.trim());
    const globalArrow = appCss.match(/^\.ant-collapse \.ant-collapse-arrow \{([\s\S]*?)\}/m)?.[1];
    const legacyArrow = appCss.match(/^\.compact-collapse \.ant-collapse-arrow \{([\s\S]*?)\}/m)?.[1];
    expect(globalArrow?.trim()).toBe(legacyArrow?.trim());
  });
});
