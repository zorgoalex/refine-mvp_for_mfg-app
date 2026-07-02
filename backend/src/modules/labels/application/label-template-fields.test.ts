import { describe, expect, it } from 'vitest';
import { extractLabelTemplateFieldIds, renderLabelTemplateString, validateQrTemplateElement } from './label-template-fields';

describe('label template field helpers', () => {
  it('extracts unique placeholders from a custom string template', () => {
    expect(extractLabelTemplateFieldIds('{order.order_name}|{bazis.detail_id}|{order.order_name}')).toEqual([
      'order.order_name',
      'bazis.detail_id',
    ]);
  });

  it('renders placeholders from row values and leaves literals untouched', () => {
    expect(renderLabelTemplateString('{order.order_name}|{bazis.detail_id}|{missing}', {
      'order.order_name': 'ORDER-42',
      'bazis.detail_id': 60044,
    })).toBe('ORDER-42|60044|');
  });

  it('rejects qr templates that reference fields outside built-in and custom schema fields', () => {
    expect(() =>
      validateQrTemplateElement(
        {
          elementKey: 'qr-1',
          kind: 'qr',
          sourceField: null,
          staticText: null,
          xMm: 1,
          yMm: 1,
          widthMm: 20,
          heightMm: 20,
          style: { qrTemplate: '{unknown.field}' },
          condition: {},
        },
        { 'custom.client': { type: 'string', sourceField: 'order.client_name' } },
        0,
      ),
    ).toThrow(/LABEL_FIELD_BINDING_INVALID|unknown\.field/);
  });

  it('rejects qr elements with a missing template', () => {
    expectQrValidationError(() =>
      validateQrTemplateElement(
        {
          elementKey: 'qr-empty',
          kind: 'qr',
          xMm: 1,
          yMm: 1,
          widthMm: 20,
          heightMm: 20,
          style: {},
        },
        {},
        2,
      ),
    {
      statusCode: 422,
      code: 'LABEL_QR_TEMPLATE_EMPTY',
      details: { elementIndex: 2 },
    });
  });

  it('rejects qr elements with invalid error correction', () => {
    expectQrValidationError(() =>
      validateQrTemplateElement(
        {
          elementKey: 'qr-ec',
          kind: 'qr',
          xMm: 1,
          yMm: 1,
          widthMm: 20,
          heightMm: 20,
          style: { qrTemplate: '{bazis.detail_id}', qrErrorCorrection: 'Z' },
        },
        {},
        1,
      ),
    {
      statusCode: 422,
      code: 'LABEL_QR_ERROR_CORRECTION_INVALID',
      details: { elementIndex: 1, value: 'Z' },
    });
  });

  it('rejects qr elements that are smaller than the minimum supported size', () => {
    expectQrValidationError(() =>
      validateQrTemplateElement(
        {
          elementKey: 'qr-small',
          kind: 'qr',
          xMm: 1,
          yMm: 1,
          widthMm: 7.9,
          heightMm: 8,
          style: { qrTemplate: '{bazis.detail_id}' },
        },
        {},
        4,
      ),
    {
      statusCode: 422,
      code: 'LABEL_QR_SIZE_TOO_SMALL',
      details: { elementIndex: 4, minSideMm: 7.9, minimumMm: 8 },
    });
  });

  it('accepts qr templates that reference custom schema fields', () => {
    expect(() =>
      validateQrTemplateElement(
        {
          elementKey: 'qr-custom',
          kind: 'qr',
          xMm: 1,
          yMm: 1,
          widthMm: 12,
          heightMm: 12,
          style: {
            qrTemplate: '{custom.client}|{order.order_name}',
            qrErrorCorrection: 'H',
          },
        },
        { 'custom.client': { type: 'string', sourceField: 'order.client_name' } },
        0,
      ),
    ).not.toThrow();
  });
});

function expectQrValidationError(action: () => void, expected: Record<string, unknown>): void {
  try {
    action();
    throw new Error('Expected QR validation to throw');
  } catch (error) {
    expect(error).toMatchObject(expected);
  }
}
