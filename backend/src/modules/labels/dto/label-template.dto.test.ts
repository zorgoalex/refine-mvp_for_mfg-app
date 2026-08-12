import { describe, expect, it } from 'vitest';
import { createLabelTemplateSchema, updateLabelTemplateSchema } from './label-template.dto';

const base = {
  name: 'Тест шаблон',
  canvasWidthMm: 85,
  canvasHeightMm: 88,
  dpi: 203,
  defaultExportFormats: ['png'],
  customFieldSchema: {},
  idempotencyKey: 'test-label-template-1',
};

describe('label template DTO advanced element contract', () => {
  it('accepts activation/deactivation flags on create and update payloads', () => {
    expect(createLabelTemplateSchema.parse({ ...base, isActive: false }).isActive).toBe(false);
    expect(updateLabelTemplateSchema.parse({ ...base, version: 2, isActive: true }).isActive).toBe(true);
  });

  it('accepts strict typography/editor metadata and if/else v1', () => {
    const parsed = createLabelTemplateSchema.parse({
      ...base,
      elements: [{
        elementKey: 'conditional',
        kind: 'text',
        sourceField: 'detail.detail_name',
        xMm: 1,
        yMm: 2,
        widthMm: 30,
        heightMm: 6,
        style: {
          typography: { version: 1, fontSizePt: 12, fontWeight: 'bold', italic: true },
          editor: { version: 1, boundsMode: 'manual', groupId: 'group-1' },
        },
        condition: {
          type: 'if_else',
          version: 1,
          when: { field: 'detail.material_name', op: 'equals', value: 'МДФ' },
          then: { type: 'field', field: 'detail.detail_name' },
          else: { type: 'text', value: 'Другая деталь' },
        },
      }],
    });

    expect(parsed.elements[0].condition).toMatchObject({ type: 'if_else', version: 1 });
  });

  it.each([
    { typography: { version: 1, fontSizePt: 0, fontWeight: 'bold', italic: false } },
    { typography: { version: 2, fontSizePt: 12, fontWeight: 'normal', italic: false } },
    { editor: { version: 1, boundsMode: 'manual', groupId: { bad: true } } },
    { editor: { version: 1, boundsMode: 'other' } },
    { futureStyle: { version: 2, payload: true } },
  ])('rejects invalid strict style metadata: %j', (style) => {
    expect(() => createLabelTemplateSchema.parse({
      ...base,
      elements: [{ elementKey: 'x', kind: 'text', staticText: 'X', xMm: 0, yMm: 0, widthMm: 10, heightMm: 5, style }],
    })).toThrow();
  });

  it.each([
    { type: 'if_else', version: 2, when: { field: 'detail.detail_name', op: 'exists' }, then: { type: 'current' }, else: { type: 'hidden' } },
    { type: 'if_else', version: 1, when: { field: 'detail.detail_name', op: 'exists', value: 'forbidden' }, then: { type: 'current' }, else: { type: 'hidden' } },
    { type: 'if_else', version: 1, when: { field: 'detail.detail_name', op: 'equals' }, then: { type: 'current' }, else: { type: 'hidden' } },
    { type: 'if_else', version: 1, when: { field: 'detail.detail_name', op: 'equals', value: {} }, then: { type: 'current' }, else: { type: 'hidden' } },
    { type: 'if_else', version: 1, when: { field: 'detail.detail_name', op: 'exists' }, then: { type: 'field' }, else: { type: 'hidden' } },
  ])('rejects invalid if/else shape: %j', (condition) => {
    expect(() => createLabelTemplateSchema.parse({
      ...base,
      elements: [{ elementKey: 'x', kind: 'text', staticText: 'X', xMm: 0, yMm: 0, widthMm: 10, heightMm: 5, condition }],
    })).toThrow();
  });

  it('preserves strict legacy visibility condition writes', () => {
    const parsed = createLabelTemplateSchema.parse({
      ...base,
      elements: [{
        elementKey: 'legacy',
        kind: 'text',
        staticText: 'X',
        xMm: 0,
        yMm: 0,
        widthMm: 10,
        heightMm: 5,
        condition: { field: 'detail.detail_name', op: 'not_empty' },
      }],
    });
    expect(parsed.elements[0].condition).toEqual({ field: 'detail.detail_name', op: 'not_empty' });
  });

  it('rejects unknown unversioned condition write shapes', () => {
    expect(() => createLabelTemplateSchema.parse({
      ...base,
      elements: [{
        elementKey: 'legacy-unknown',
        kind: 'text',
        staticText: 'X',
        xMm: 0,
        yMm: 0,
        widthMm: 10,
        heightMm: 5,
        condition: { pluginCondition: 'unknown' },
      }],
    })).toThrow();
  });

  it('preserves grandfathered unversioned style keys', () => {
    const parsed = createLabelTemplateSchema.parse({
      ...base,
      elements: [{
        elementKey: 'legacy-style',
        kind: 'text',
        staticText: 'X',
        xMm: 0,
        yMm: 0,
        widthMm: 10,
        heightMm: 5,
        style: { fontSize: 11, pluginLegacyMarker: { keep: true } },
      }],
    });
    expect(parsed.elements[0].style).toEqual({ fontSize: 11, pluginLegacyMarker: { keep: true } });
  });

  it('accepts one adaptive cut-map placeholder with strict v1 style', () => {
    const parsed = createLabelTemplateSchema.parse({
      ...base,
      elements: [{
        elementKey: 'cut-map',
        kind: 'cut_map',
        sourceField: null,
        staticText: null,
        xMm: 2,
        yMm: 3,
        widthMm: 45,
        heightMm: 22,
        style: {
          cutMap: {
            version: 1,
            fit: 'contain',
            highlightFill: '#ffd666',
            highlightStroke: '#d4380d',
            flipHorizontal: true,
            flipVertical: false,
          },
        },
      }],
    });
    expect(parsed.elements[0]).toMatchObject({ kind: 'cut_map', widthMm: 45, heightMm: 22 });
    expect(parsed.elements[0].style?.cutMap).toMatchObject({ flipHorizontal: true, flipVertical: false });
  });

  it.each([
    { version: 2, fit: 'contain', highlightFill: '#ffd666', highlightStroke: '#d4380d' },
    { version: 1, fit: 'stretch', highlightFill: '#ffd666', highlightStroke: '#d4380d' },
    { version: 1, fit: 'contain', highlightFill: 'yellow', highlightStroke: '#d4380d' },
    { version: 1, fit: 'contain', highlightFill: '#ffd666', highlightStroke: '#d4380d', flipHorizontal: 'yes' },
    { version: 1, fit: 'contain', highlightFill: '#ffd666', highlightStroke: '#d4380d', mirrorX: true },
  ])('rejects malformed cut-map style: %j', (cutMap) => {
    expect(() => createLabelTemplateSchema.parse({
      ...base,
      elements: [{
        elementKey: 'cut-map',
        kind: 'cut_map',
        sourceField: null,
        staticText: null,
        xMm: 2,
        yMm: 3,
        widthMm: 45,
        heightMm: 22,
        style: { cutMap },
      }],
    })).toThrow();
  });
});
