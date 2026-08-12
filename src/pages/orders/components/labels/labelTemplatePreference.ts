import type { LabelTemplate } from '../../../../api/types/labelsApi.types';

interface LabelTemplatePreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function labelTemplatePreferenceKey(userId: string | number): string {
  return `labels:generate-template:v1:${userId}`;
}

export function parseLabelTemplatePreference(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function loadLabelTemplatePreference(
  userId: string | number,
  storage?: LabelTemplatePreferenceStorage,
): number | null {
  try {
    const targetStorage = storage ?? globalThis.localStorage;
    return parseLabelTemplatePreference(targetStorage?.getItem(labelTemplatePreferenceKey(userId)));
  } catch {
    return null;
  }
}

export function saveLabelTemplatePreference(
  userId: string | number,
  templateId: number,
  storage?: LabelTemplatePreferenceStorage,
): void {
  if (!Number.isInteger(templateId) || templateId <= 0) return;
  try {
    const targetStorage = storage ?? globalThis.localStorage;
    targetStorage?.setItem(labelTemplatePreferenceKey(userId), String(templateId));
  } catch {
    // Private mode or exhausted quota: keep current in-memory choice.
  }
}

export function resolvePreferredLabelTemplateId(
  userId: string | number,
  templates: LabelTemplate[],
  storage?: LabelTemplatePreferenceStorage,
): number | null {
  const savedTemplateId = loadLabelTemplatePreference(userId, storage);
  if (savedTemplateId && templates.some((template) => template.labelTemplateId === savedTemplateId)) {
    return savedTemplateId;
  }
  return templates.find((template) => template.isActive)?.labelTemplateId ?? templates[0]?.labelTemplateId ?? null;
}
