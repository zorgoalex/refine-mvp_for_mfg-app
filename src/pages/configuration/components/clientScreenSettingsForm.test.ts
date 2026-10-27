import { describe, expect, it } from 'vitest';
import { CLIENT_SCREEN_CODES, CLIENT_SCREEN_DEFAULT_VISIBLE_CODES } from '../../clientScreen/clientScreenRegistry';
import {
  extractConflictSettings,
  formFromSettings,
  isDirty,
  setDefaults,
  setEnabled,
  showAll,
  toPayload,
  toggleCode,
  toggleTab,
} from './clientScreenSettingsForm';

const settings = { enabled: true, visibleCodes: ['tab.basic', 'summary.number'], version: 3, updatedAt: '2026-10-04T00:00:00Z' };

describe('clientScreenSettingsForm', () => {
  it('normalizes codes when loading', () => {
    expect(formFromSettings({ enabled: false, visibleCodes: ['tab.basic', 'x', 'summary.number', 'tab.basic'] })).toEqual({
      enabled: false,
      codes: ['summary.number', 'tab.basic'],
    });
  });

  it('toggles a code keeping registry order, and is idempotent when explicit', () => {
    let s = formFromSettings(settings);
    s = toggleCode(s, 'basic.client');
    expect(s.codes).toEqual(['summary.number', 'tab.basic', 'basic.client']);
    expect(toggleCode(s, 'basic.client', true)).toBe(s);
    s = toggleCode(s, 'basic.client');
    expect(s.codes).toEqual(['summary.number', 'tab.basic']);
  });

  it('unchecking a tab keeps its field values', () => {
    let s = formFromSettings({ ...settings, visibleCodes: ['tab.basic', 'basic.client'] });
    s = toggleTab(s, 'tab.basic', false);
    expect(s.codes).toEqual(['basic.client']);
    s = toggleTab(s, 'tab.basic', true);
    expect(s.codes).toEqual(['tab.basic', 'basic.client']);
  });

  it('sets defaults and shows all without saving', () => {
    const s = formFromSettings(settings);
    expect(setDefaults(s).codes).toEqual([...CLIENT_SCREEN_DEFAULT_VISIBLE_CODES]);
    expect(showAll(s).codes).toEqual([...CLIENT_SCREEN_CODES]);
    expect(setDefaults(s).enabled).toBe(true);
  });

  it('detects dirty state for the switch and for codes', () => {
    const s = formFromSettings(settings);
    expect(isDirty(s, settings)).toBe(false);
    expect(isDirty(setEnabled(s, false), settings)).toBe(true);
    expect(isDirty(toggleCode(s, 'tab.dates'), settings)).toBe(true);
    expect(isDirty(toggleCode(toggleCode(s, 'tab.dates'), 'tab.dates'), settings)).toBe(false);
  });

  it('builds a normalized payload with expectedVersion', () => {
    expect(toPayload(formFromSettings(settings), 3)).toEqual({
      enabled: true,
      visibleCodes: ['summary.number', 'tab.basic'],
      expectedVersion: 3,
    });
  });

  it('extracts conflict settings and rejects malformed details', () => {
    expect(extractConflictSettings({ settings })?.version).toBe(3);
    expect(extractConflictSettings({})).toBeNull();
    expect(extractConflictSettings(undefined)).toBeNull();
    expect(extractConflictSettings({ settings: { enabled: 1 } })).toBeNull();
  });
});
