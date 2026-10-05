import { formatDateTime } from '../../../utils/dateFormat';
import type {
  ProcurementSettings,
  ProcurementSettingsUpdate,
} from '../../../api/types/procurementWorkspaceApi.types';

/**
 * /configuration «Закупки» tab — form <-> DTO conversion and validation.
 * Kept free of React/antd so it can be unit-tested under the node Vitest
 * environment (no DOM) without dynamically importing the .tsx component.
 */
export interface ProcurementSettingsFormValues {
  leadDays: number | null;
  criticalDays: number | null;
  soonDays: number | null;
  wastePercent: number | null;
  digestTime: string;
  unallocatedAlertDays: number | null;
  overdueWindowDays: number | null;
}

export const PROCUREMENT_SETTINGS_FORM_DEFAULTS: ProcurementSettingsFormValues = {
  leadDays: 2,
  criticalDays: 3,
  soonDays: 7,
  wastePercent: 5,
  digestTime: '08:00',
  unallocatedAlertDays: 2,
  overdueWindowDays: 30,
};

export function settingsToFormValues(settings: ProcurementSettings): ProcurementSettingsFormValues {
  return {
    leadDays: settings.leadDays,
    criticalDays: settings.criticalDays,
    soonDays: settings.soonDays,
    wastePercent: settings.wastePercent,
    digestTime: settings.digestTime,
    unallocatedAlertDays: settings.unallocatedAlertDays,
    overdueWindowDays: settings.overdueWindowDays,
  };
}

/** Ant Design's InputNumber/TimePicker round-trip can introduce float noise; round waste% before comparing. */
function roundWaste(value: number | null): number | null {
  return value == null ? null : Math.round(value * 100) / 100;
}

export function formValuesMatchSettings(
  values: ProcurementSettingsFormValues,
  settings: ProcurementSettings,
): boolean {
  return (
    values.leadDays === settings.leadDays
    && values.criticalDays === settings.criticalDays
    && values.soonDays === settings.soonDays
    && roundWaste(values.wastePercent) === roundWaste(settings.wastePercent)
    && values.digestTime === settings.digestTime
    && values.unallocatedAlertDays === settings.unallocatedAlertDays
    && values.overdueWindowDays === settings.overdueWindowDays
  );
}

export interface ProcurementSettingsFormErrors {
  leadDays?: string;
  criticalDays?: string;
  soonDays?: string;
  wastePercent?: string;
  digestTime?: string;
  unallocatedAlertDays?: string;
  overdueWindowDays?: string;
}

const DIGEST_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function isIntInRange(value: number | null, min: number, max: number): boolean {
  return value != null && Number.isInteger(value) && value >= min && value <= max;
}

/** Mirrors backend/src/modules/orders/http/procurement-workspace.controller.ts `settingsSchema`. */
export function validateProcurementSettingsForm(
  values: ProcurementSettingsFormValues,
): ProcurementSettingsFormErrors {
  const errors: ProcurementSettingsFormErrors = {};

  if (!isIntInRange(values.leadDays, 0, 60)) {
    errors.leadDays = 'Введите целое число от 0 до 60';
  }
  if (!isIntInRange(values.criticalDays, 0, 60)) {
    errors.criticalDays = 'Введите целое число от 0 до 60';
  }
  if (!isIntInRange(values.soonDays, 0, 60)) {
    errors.soonDays = 'Введите целое число от 0 до 60';
  }
  if (
    !errors.criticalDays && !errors.soonDays
    && values.criticalDays != null && values.soonDays != null
    && values.criticalDays > values.soonDays
  ) {
    errors.criticalDays = '«Срочно» не может быть больше «Скоро»';
  }

  if (
    values.wastePercent == null
    || !Number.isFinite(values.wastePercent)
    || values.wastePercent < 0
    || values.wastePercent > 50
  ) {
    errors.wastePercent = 'Введите число от 0 до 50';
  } else {
    const rounded = Math.round(values.wastePercent * 100) / 100;
    if (Math.abs(rounded - values.wastePercent) > 1e-9) {
      errors.wastePercent = 'Не больше 2 знаков после запятой';
    }
  }

  if (!DIGEST_TIME_PATTERN.test(values.digestTime ?? '')) {
    errors.digestTime = 'Формат ЧЧ:ММ';
  }

  if (!isIntInRange(values.unallocatedAlertDays, 1, 30)) {
    errors.unallocatedAlertDays = 'Введите целое число от 1 до 30';
  }

  if (!isIntInRange(values.overdueWindowDays, 1, 365)) {
    errors.overdueWindowDays = 'Введите целое число от 1 до 365';
  }

  return errors;
}

export function hasProcurementSettingsFormErrors(errors: ProcurementSettingsFormErrors): boolean {
  return Object.values(errors).some((message) => Boolean(message));
}

export function buildProcurementSettingsUpdate(
  values: ProcurementSettingsFormValues,
  expectedVersion: number,
): ProcurementSettingsUpdate {
  return {
    leadDays: values.leadDays as number,
    criticalDays: values.criticalDays as number,
    soonDays: values.soonDays as number,
    wastePercent: values.wastePercent as number,
    digestTime: values.digestTime,
    unallocatedAlertDays: values.unallocatedAlertDays as number,
    overdueWindowDays: values.overdueWindowDays as number,
    expectedVersion,
  };
}

/** Backend 409 PROCUREMENT_SETTINGS_VERSION_CONFLICT returns `details.settings` = current settings. */
export function extractProcurementConflictSettings(details: unknown): ProcurementSettings | null {
  if (!details || typeof details !== 'object') return null;
  const settings = (details as { settings?: unknown }).settings;
  if (!settings || typeof settings !== 'object') return null;
  return settings as ProcurementSettings;
}

export function formatProcurementSettingsUpdatedMeta(settings: ProcurementSettings): string {
  const when = formatDateTime(settings.updatedAt);
  return settings.updatedBy ? `Изменено: ${when} · ${settings.updatedBy.name}` : `Изменено: ${when}`;
}
