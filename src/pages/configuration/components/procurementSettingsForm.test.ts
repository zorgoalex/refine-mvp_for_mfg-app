import { describe, expect, it } from 'vitest';
import { formatDateTime } from '../../../utils/dateFormat';
import type { ProcurementSettings } from '../../../api/types/procurementWorkspaceApi.types';
import {
  buildProcurementSettingsUpdate,
  extractProcurementConflictSettings,
  formValuesMatchSettings,
  formatProcurementSettingsUpdatedMeta,
  hasProcurementSettingsFormErrors,
  PROCUREMENT_SETTINGS_FORM_DEFAULTS,
  settingsToFormValues,
  validateProcurementSettingsForm,
  type ProcurementSettingsFormValues,
} from './procurementSettingsForm';

const SETTINGS: ProcurementSettings = {
  leadDays: 2,
  criticalDays: 3,
  soonDays: 7,
  wastePercent: 5,
  digestTime: '08:00',
  unallocatedAlertDays: 2,
  overdueWindowDays: 30,
  version: 4,
  updatedAt: '2026-09-20T05:00:00.000Z',
  updatedBy: { userId: 78, name: 'Алексей' },
};

describe('procurementSettingsForm', () => {
  it('converts settings to form values', () => {
    expect(settingsToFormValues(SETTINGS)).toEqual(PROCUREMENT_SETTINGS_FORM_DEFAULTS);
  });

  it('treats a hydrated draft that matches settings as clean, tolerating float noise in waste%', () => {
    const draft = settingsToFormValues(SETTINGS);
    expect(formValuesMatchSettings(draft, SETTINGS)).toBe(true);
    expect(formValuesMatchSettings({ ...draft, wastePercent: 5.0000000001 }, SETTINGS)).toBe(true);
    expect(formValuesMatchSettings({ ...draft, leadDays: 3 }, SETTINGS)).toBe(false);
    expect(formValuesMatchSettings({ ...draft, digestTime: '09:00' }, SETTINGS)).toBe(false);
  });

  it('validates the day-count fields as integers in range', () => {
    const draft = settingsToFormValues(SETTINGS);
    expect(hasProcurementSettingsFormErrors(validateProcurementSettingsForm(draft))).toBe(false);

    expect(validateProcurementSettingsForm({ ...draft, leadDays: -1 }).leadDays).toBeTruthy();
    expect(validateProcurementSettingsForm({ ...draft, leadDays: 61 }).leadDays).toBeTruthy();
    expect(validateProcurementSettingsForm({ ...draft, leadDays: 1.5 }).leadDays).toBeTruthy();
    expect(validateProcurementSettingsForm({ ...draft, leadDays: null }).leadDays).toBeTruthy();

    expect(validateProcurementSettingsForm({ ...draft, unallocatedAlertDays: 0 }).unallocatedAlertDays).toBeTruthy();
    expect(validateProcurementSettingsForm({ ...draft, unallocatedAlertDays: 31 }).unallocatedAlertDays).toBeTruthy();
    expect(validateProcurementSettingsForm({ ...draft, overdueWindowDays: 0 }).overdueWindowDays).toBeTruthy();
    expect(validateProcurementSettingsForm({ ...draft, overdueWindowDays: 366 }).overdueWindowDays).toBeTruthy();
  });

  it('requires criticalDays <= soonDays', () => {
    const draft = settingsToFormValues(SETTINGS);
    expect(validateProcurementSettingsForm({ ...draft, criticalDays: 8, soonDays: 7 }).criticalDays).toBeTruthy();
    expect(validateProcurementSettingsForm({ ...draft, criticalDays: 7, soonDays: 7 }).criticalDays).toBeUndefined();
  });

  it('validates wastePercent range and 2-decimal precision', () => {
    const draft = settingsToFormValues(SETTINGS);
    expect(validateProcurementSettingsForm({ ...draft, wastePercent: -1 }).wastePercent).toBeTruthy();
    expect(validateProcurementSettingsForm({ ...draft, wastePercent: 51 }).wastePercent).toBeTruthy();
    expect(validateProcurementSettingsForm({ ...draft, wastePercent: 5.123 }).wastePercent).toBeTruthy();
    expect(validateProcurementSettingsForm({ ...draft, wastePercent: 5.12 }).wastePercent).toBeUndefined();
    expect(validateProcurementSettingsForm({ ...draft, wastePercent: 0 }).wastePercent).toBeUndefined();
    expect(validateProcurementSettingsForm({ ...draft, wastePercent: 50 }).wastePercent).toBeUndefined();
  });

  it('validates digestTime as HH:MM', () => {
    const draft = settingsToFormValues(SETTINGS);
    expect(validateProcurementSettingsForm({ ...draft, digestTime: '8:00' }).digestTime).toBeTruthy();
    expect(validateProcurementSettingsForm({ ...draft, digestTime: '24:00' }).digestTime).toBeTruthy();
    expect(validateProcurementSettingsForm({ ...draft, digestTime: '' }).digestTime).toBeTruthy();
    expect(validateProcurementSettingsForm({ ...draft, digestTime: '23:59' }).digestTime).toBeUndefined();
  });

  it('builds the PUT payload with expectedVersion', () => {
    const draft: ProcurementSettingsFormValues = settingsToFormValues(SETTINGS);
    expect(buildProcurementSettingsUpdate(draft, SETTINGS.version)).toEqual({
      leadDays: 2,
      criticalDays: 3,
      soonDays: 7,
      wastePercent: 5,
      digestTime: '08:00',
      unallocatedAlertDays: 2,
      overdueWindowDays: 30,
      expectedVersion: 4,
    });
  });

  it('extracts current settings from a 409 conflict details payload', () => {
    expect(extractProcurementConflictSettings({ settings: SETTINGS })).toEqual(SETTINGS);
    expect(extractProcurementConflictSettings(null)).toBeNull();
    expect(extractProcurementConflictSettings({})).toBeNull();
    expect(extractProcurementConflictSettings('nope')).toBeNull();
  });

  it('formats the updated-by meta line', () => {
    const when = formatDateTime(SETTINGS.updatedAt);
    expect(formatProcurementSettingsUpdatedMeta(SETTINGS)).toBe(`Изменено: ${when} · Алексей`);
    expect(formatProcurementSettingsUpdatedMeta({ ...SETTINGS, updatedBy: null })).toBe(`Изменено: ${when}`);
  });
});
