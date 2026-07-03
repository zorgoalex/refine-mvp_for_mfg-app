import { describe, expect, it } from 'vitest';
import {
  createLabelQrTemplateSchema,
  updateLabelQrTemplateSchema,
} from './label-qr-template.dto';

describe('label-qr-template dto', () => {
  const base = {
    name: 'Деталь',
    contentTemplate: '{bazis.detail_id}|{bazis.name}',
    errorCorrection: 'M',
    defaultSizeMm: 20,
    idempotencyKey: 'qr-template-123456',
  };

  it('accepts a valid create payload', () => {
    expect(createLabelQrTemplateSchema.parse(base)).toMatchObject({ name: 'Деталь' });
  });

  it('rejects empty content template', () => {
    expect(createLabelQrTemplateSchema.safeParse({ ...base, contentTemplate: '' }).success).toBe(false);
  });

  it('rejects non-positive size', () => {
    expect(createLabelQrTemplateSchema.safeParse({ ...base, defaultSizeMm: 0 }).success).toBe(false);
  });

  it('rejects bad error correction', () => {
    expect(createLabelQrTemplateSchema.safeParse({ ...base, errorCorrection: 'Z' }).success).toBe(false);
  });

  it('update schema requires version', () => {
    expect(updateLabelQrTemplateSchema.safeParse(base).success).toBe(false);
    expect(updateLabelQrTemplateSchema.safeParse({ ...base, version: 1 }).success).toBe(true);
  });
});
