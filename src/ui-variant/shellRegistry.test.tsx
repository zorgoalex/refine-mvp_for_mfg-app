import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { hintDerivedShellState, startHintReboot, VariantWorkspaceLayout } from './shellRegistry';

vi.mock('./UiVariantProvider', () => ({
  useUiVariant: () => ({ variant: 'legacy' }),
}));

const hint = vi.hoisted(() => ({ derived: false }));
vi.mock('./uiVariantBootstrap', () => ({
  isUiVariantFromDeviceHint: () => hint.derived,
}));

describe('VariantWorkspaceLayout', () => {
  it('contains lazy shell suspension inside a loading boundary', () => {
    const html = renderToString(<VariantWorkspaceLayout />);

    expect(html).toContain('aria-label="Загрузка интерфейса"');
  });

  it('never mounts a shell in a hint-derived document: reboot once, then ask for a manual reload', () => {
    const fresh = { getItem: () => null };
    const used = { getItem: (key: string) => (key === 'erp.uiVariant.hintReboot' ? '1' : null) };
    const blocked = { getItem: () => { throw new Error('blocked'); } };

    expect(hintDerivedShellState(true, fresh)).toBe('reboot');
    expect(hintDerivedShellState(true, used)).toBe('manual');
    expect(hintDerivedShellState(true, blocked)).toBe('manual');
    expect(hintDerivedShellState(true, null)).toBe('manual');
    expect(hintDerivedShellState(false, fresh)).toBe('mount');
    expect(hintDerivedShellState(false, null)).toBe('mount');
  });

  it('falls back to the manual reload when the reboot mark cannot be written', () => {
    const reload = vi.fn();
    const full = { setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(startHintReboot(full, reload)).toBe('manual');
    expect(startHintReboot(null, reload)).toBe('manual');
    expect(reload).not.toHaveBeenCalled();

    const marks: string[] = [];
    expect(startHintReboot({ setItem: (key: string, value: string) => { marks.push(`${key}=${value}`); } }, reload)).toBe('reboot');
    expect(marks).toEqual(['erp.uiVariant.hintReboot=1']);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('renders the manual-reload state instead of the shell when the hint document cannot reboot', () => {
    hint.derived = true;
    try {
      // node test env has no sessionStorage: the reboot is impossible
      const html = renderToString(<VariantWorkspaceLayout />);
      expect(html).toContain('Обновить страницу');
      expect(html).not.toContain('aria-label="Загрузка интерфейса"');
    } finally {
      hint.derived = false;
    }
  });
});
