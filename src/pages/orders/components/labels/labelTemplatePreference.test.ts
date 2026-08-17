import { describe, expect, it } from 'vitest';
import type { LabelTemplate } from '../../../../api/types/labelsApi.types';
import {
  appendBlankLabelOnPrintPreferenceKey,
  labelTemplatePreferenceKey,
  loadAppendBlankLabelOnPrintPreference,
  loadLabelTemplatePreference,
  parseAppendBlankLabelOnPrintPreference,
  parseLabelTemplatePreference,
  resolvePreferredLabelTemplateId,
  saveAppendBlankLabelOnPrintPreference,
  saveLabelTemplatePreference,
} from './labelTemplatePreference';

describe('label template preference', () => {
  it('stores template choice under a per-user key', () => {
    const storage = memoryStorage();

    saveLabelTemplatePreference('u1', 10, storage);
    saveLabelTemplatePreference('u2', 20, storage);

    expect(storage.getItem(labelTemplatePreferenceKey('u1'))).toBe('10');
    expect(storage.getItem(labelTemplatePreferenceKey('u2'))).toBe('20');
    expect(loadLabelTemplatePreference('u1', storage)).toBe(10);
    expect(loadLabelTemplatePreference('u2', storage)).toBe(20);
  });

  it('stores append-blank-label print choice under a per-user key', () => {
    const storage = memoryStorage();

    expect(loadAppendBlankLabelOnPrintPreference('u1', storage)).toBe(false);

    saveAppendBlankLabelOnPrintPreference('u1', true, storage);
    saveAppendBlankLabelOnPrintPreference('u2', false, storage);

    expect(storage.getItem(appendBlankLabelOnPrintPreferenceKey('u1'))).toBe('true');
    expect(storage.getItem(appendBlankLabelOnPrintPreferenceKey('u2'))).toBe('false');
    expect(loadAppendBlankLabelOnPrintPreference('u1', storage)).toBe(true);
    expect(loadAppendBlankLabelOnPrintPreference('u2', storage)).toBe(false);
  });

  it('uses saved template only when it exists in the available modal templates', () => {
    const storage = memoryStorage();
    saveLabelTemplatePreference('u1', 30, storage);

    expect(resolvePreferredLabelTemplateId('u1', [
      labelTemplate(10, true),
      labelTemplate(30, false),
    ], storage)).toBe(30);

    expect(resolvePreferredLabelTemplateId('u1', [
      labelTemplate(10, true),
      labelTemplate(20, false),
    ], storage)).toBe(10);
  });

  it('ignores invalid stored values and storage failures', () => {
    const brokenStorage = {
      getItem() {
        throw new Error('storage unavailable');
      },
      setItem() {
        throw new Error('storage unavailable');
      },
    };

    expect(parseLabelTemplatePreference('')).toBeNull();
    expect(parseLabelTemplatePreference('0')).toBeNull();
    expect(parseLabelTemplatePreference('abc')).toBeNull();
    expect(parseAppendBlankLabelOnPrintPreference('true')).toBe(true);
    expect(parseAppendBlankLabelOnPrintPreference('false')).toBe(false);
    expect(parseAppendBlankLabelOnPrintPreference('1')).toBeNull();
    expect(loadLabelTemplatePreference('u1', brokenStorage)).toBeNull();
    expect(loadAppendBlankLabelOnPrintPreference('u1', brokenStorage)).toBe(false);
    expect(() => saveLabelTemplatePreference('u1', 10, brokenStorage)).not.toThrow();
    expect(() => saveAppendBlankLabelOnPrintPreference('u1', true, brokenStorage)).not.toThrow();
  });
});

function labelTemplate(labelTemplateId: number, isActive: boolean): LabelTemplate {
  return {
    labelTemplateId,
    name: `Шаблон ${labelTemplateId}`,
    description: null,
    version: 1,
    isActive,
    canvasWidthMm: 58,
    canvasHeightMm: 40,
    dpi: 203,
    defaultExportFormats: [],
    customFieldSchema: {},
    fieldCatalogSnapshot: {},
    elements: [],
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
