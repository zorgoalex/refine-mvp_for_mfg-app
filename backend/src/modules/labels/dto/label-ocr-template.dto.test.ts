import { describe, expect, it } from 'vitest';
import {
  createLabelOcrTemplateSchema,
  deleteLabelOcrTemplateSchema,
  updateLabelOcrTemplateSchema,
} from './label-ocr-template.dto';

describe('label-ocr-template dto', () => {
  const base = {
    name: 'Базис-бирка v1',
    rules: [{ field: 'order_number' }, { field: 'material' }, { field: 'dimensions' }],
    idempotencyKey: 'ocr-template-123456',
  };

  it('accepts a valid create payload', () => {
    const parsed = createLabelOcrTemplateSchema.parse(base);
    expect(parsed).toMatchObject({ name: 'Базис-бирка v1' });
    expect(parsed.sampleLines).toEqual([]);
    expect(parsed.isActive).toBe(true);
  });

  it('rejects empty rules', () => {
    expect(createLabelOcrTemplateSchema.safeParse({ ...base, rules: [] }).success).toBe(false);
  });

  it('rejects more than 30 rules', () => {
    const rules = Array.from({ length: 31 }, () => ({ field: 'ignore' }));
    expect(createLabelOcrTemplateSchema.safeParse({ ...base, rules }).success).toBe(false);
  });

  it('rejects an unknown field', () => {
    const rules = [{ field: 'bogus_field' }, { field: 'material' }, { field: 'dimensions' }];
    expect(createLabelOcrTemplateSchema.safeParse({ ...base, rules }).success).toBe(false);
  });

  it('rejects a single strong field (needs >=2)', () => {
    const rules = [{ field: 'order_number' }];
    expect(createLabelOcrTemplateSchema.safeParse({ ...base, rules }).success).toBe(false);
  });

  it('rejects two numeric strong fields with no anchor (no discriminant)', () => {
    const rules = [{ field: 'order_number' }, { field: 'detail_number' }];
    expect(createLabelOcrTemplateSchema.safeParse({ ...base, rules }).success).toBe(false);
  });

  it('accepts two strong fields including material (material is a discriminant)', () => {
    const rules = [{ field: 'order_number' }, { field: 'material' }];
    expect(createLabelOcrTemplateSchema.safeParse({ ...base, rules }).success).toBe(true);
  });

  it('accepts two numeric strong fields when one has an anchor', () => {
    const rules = [{ field: 'order_number', anchor: 'Зак' }, { field: 'detail_number' }];
    expect(createLabelOcrTemplateSchema.safeParse({ ...base, rules }).success).toBe(true);
  });

  it('rejects duplicate order_number field', () => {
    const rules = [{ field: 'order_number' }, { field: 'order_number' }, { field: 'material' }];
    expect(createLabelOcrTemplateSchema.safeParse({ ...base, rules }).success).toBe(false);
  });

  it('accepts duplicate ignore field', () => {
    const rules = [
      { field: 'order_number' },
      { field: 'material' },
      { field: 'ignore' },
      { field: 'ignore' },
    ];
    expect(createLabelOcrTemplateSchema.safeParse({ ...base, rules }).success).toBe(true);
  });

  it('rejects an anchor longer than 64 chars', () => {
    const rules = [
      { field: 'order_number', anchor: 'a'.repeat(65) },
      { field: 'detail_number' },
    ];
    expect(createLabelOcrTemplateSchema.safeParse({ ...base, rules }).success).toBe(false);
  });

  it('rejects an extra unknown top-level key (strict)', () => {
    expect(createLabelOcrTemplateSchema.safeParse({ ...base, extra: 'nope' }).success).toBe(false);
  });

  it('rejects an extra unknown rule key (strict)', () => {
    const rules = [{ field: 'order_number', bogus: true }, { field: 'material' }];
    expect(createLabelOcrTemplateSchema.safeParse({ ...base, rules }).success).toBe(false);
  });

  it('update schema requires version', () => {
    expect(updateLabelOcrTemplateSchema.safeParse(base).success).toBe(false);
    expect(updateLabelOcrTemplateSchema.safeParse({ ...base, version: 1 }).success).toBe(true);
  });

  it('update schema accepts reactivation/deactivation via isActive + version', () => {
    const parsed = updateLabelOcrTemplateSchema.safeParse({ ...base, version: 3, isActive: false });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.isActive).toBe(false);
      expect(parsed.data.version).toBe(3);
    }
  });

  it('delete schema requires version + idempotencyKey', () => {
    expect(deleteLabelOcrTemplateSchema.safeParse({ version: 1, idempotencyKey: 'delete-key-123' }).success).toBe(
      true,
    );
    expect(deleteLabelOcrTemplateSchema.safeParse({ version: 1 }).success).toBe(false);
  });
});
