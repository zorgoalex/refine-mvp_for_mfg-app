import { ApiError } from '../../../common/errors/api-error';
import { LabelFieldBindingError } from '../errors/labels.errors';
import { isSupportedFieldBinding } from './bazis-field-catalog';
import type { LabelTemplateElementInput } from './labels.types';

const QR_ERROR_CORRECTION_LEVELS = new Set(['L', 'M', 'Q', 'H']);
const QR_MINIMUM_SIDE_MM = 8;
const PLACEHOLDER_PATTERN = /\{([^{}]+)\}/g;

export function extractLabelTemplateFieldIds(template: string): string[] {
  const fieldIds = new Set<string>();

  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const fieldId = match[1]?.trim();
    if (!fieldId || fieldIds.has(fieldId)) {
      continue;
    }
    fieldIds.add(fieldId);
  }

  return [...fieldIds];
}

export function renderLabelTemplateString(
  template: string,
  values: Record<string, string | number | boolean | null | undefined>,
): string {
  return template.replaceAll(PLACEHOLDER_PATTERN, (_match, fieldId: string) => {
    const value = values[fieldId.trim()];
    return value == null ? '' : String(value);
  });
}

export function readQrTemplate(style: Record<string, unknown> | null | undefined): string {
  return typeof style?.qrTemplate === 'string' ? style.qrTemplate.trim() : '';
}

export function readQrErrorCorrection(style: Record<string, unknown> | null | undefined): 'L' | 'M' | 'Q' | 'H' {
  const value = style?.qrErrorCorrection;
  const level = typeof value === 'string' ? value.trim().toUpperCase() : '';

  if (!level) {
    return 'M';
  }
  if (level === 'L' || level === 'M' || level === 'Q' || level === 'H') {
    return level;
  }

  throw new ApiError(422, 'LABEL_QR_ERROR_CORRECTION_INVALID', 'QR error correction level is invalid', {
    value,
    supportedValues: [...QR_ERROR_CORRECTION_LEVELS],
  });
}

export function validateQrTemplateElement(
  element: LabelTemplateElementInput,
  customFieldSchema: Record<string, unknown>,
  index: number,
): void {
  if (element.kind !== 'qr') {
    return;
  }

  const template = readQrTemplate(element.style);
  if (!template) {
    throw new ApiError(422, 'LABEL_QR_TEMPLATE_EMPTY', 'QR label element requires a template', {
      elementIndex: index,
    });
  }

  const minSideMm = Math.min(element.widthMm, element.heightMm);
  if (minSideMm < QR_MINIMUM_SIDE_MM) {
    throw new ApiError(422, 'LABEL_QR_SIZE_TOO_SMALL', 'QR label element is too small', {
      elementIndex: index,
      minSideMm,
      minimumMm: QR_MINIMUM_SIDE_MM,
    });
  }

  try {
    readQrErrorCorrection(element.style);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'LABEL_QR_ERROR_CORRECTION_INVALID') {
      throw new ApiError(error.statusCode, error.code, error.message, {
        ...error.details,
        elementIndex: index,
      });
    }
    throw error;
  }

  for (const fieldId of extractLabelTemplateFieldIds(template)) {
    if (!isSupportedFieldBinding(fieldId, customFieldSchema)) {
      const error = new LabelFieldBindingError(fieldId);
      error.message = `${error.code}: ${fieldId}`;
      throw error;
    }
  }
}
