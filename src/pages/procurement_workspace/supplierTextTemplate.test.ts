import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSupplierCopyText } from './supplierRequestsHelpers';
import {
  pickSupplierTextTemplate,
  renderSupplierText,
  renderSupplierTextForCard,
  STANDARD_SUPPLIER_TEXT_TEMPLATE,
  supplierCopySource,
  validateTemplate,
  type SupplierTextLineValues,
  type SupplierTextValues,
} from './supplierTextTemplate';

const fixtures = JSON.parse(readFileSync(resolve(process.cwd(), 'backend/src/modules/orders/domain/supplier-text-template.fixtures.json'), 'utf8')) as {
  parse: Array<{ template: string; scope: 'body' | 'line'; ok: boolean; code?: string }>;
  render: Array<{ name: string; body: string; line: string; values: SupplierTextValues; lines: SupplierTextLineValues[]; expected: string }>;
};

describe('supplier text templates (shared fixture with backend)', () => {
  it.each(fixtures.parse)('validates $template ($scope)', ({ template, scope, ok, code }) => {
    const error = validateTemplate(template, scope);
    if (ok) expect(error).toBeNull();
    else expect(error?.code).toBe(code);
  });

  it.each(fixtures.render)('renders: $name', ({ body, line, values, lines, expected }) => {
    expect(renderSupplierText({ body, line }, values, lines)).toBe(expected);
  });

  it('«Стандартный» gives exactly the previous copy text', () => {
    const base = {
      requestNumber: '26-0001', supplierName: 'Мебель-Трейд', createdAt: '2026-10-01T10:00:00Z', sentAt: null,
      lineItems: [
        { name: 'МДФ 16мм', quantity: 2, unit: 'sheet' },
        { name: 'Плёнка', quantity: 12.5, unit: 'lm' },
      ],
    };
    for (const card of [
      { ...base, expectedDate: '2026-10-05', comment: "Срочно\nдо обеда" },
      { ...base, expectedDate: null, comment: null },
      { ...base, expectedDate: null, comment: 'Коммент {номер}' },
    ]) {
      const typed = card as unknown as Parameters<typeof buildSupplierCopyText>[0] & Parameters<typeof renderSupplierTextForCard>[1];
      expect(renderSupplierTextForCard(STANDARD_SUPPLIER_TEXT_TEMPLATE, typed)).toBe(buildSupplierCopyText(typed));
    }
  });
});

describe('supplier copy source', () => {
  const t = (templateId: number, isDefault = false) => ({ templateId, name: `T${templateId}`, body: '{номер}', lineTemplate: '{материал}', isDefault });
  it('picks stored, then default, then first', () => {
    expect(pickSupplierTextTemplate([t(1), t(2, true)], 1)?.templateId).toBe(1);
    expect(pickSupplierTextTemplate([t(1), t(2, true)], 9)?.templateId).toBe(2);
    expect(pickSupplierTextTemplate([t(3), t(4)], null)?.templateId).toBe(3);
    expect(pickSupplierTextTemplate([], null)).toBeNull();
  });
  it('legacy without capability; fallback on error; no substitution on denied', () => {
    expect(supplierCopySource(undefined, { status: 'error' }, null)).toEqual({ kind: 'legacy' });
    expect(supplierCopySource(false, { status: 'ready', templates: [t(1)] }, null)).toEqual({ kind: 'legacy' });
    expect(supplierCopySource(true, { status: 'error' }, null).kind).toBe('fallback');
    expect(supplierCopySource(true, { status: 'denied' }, null).kind).toBe('denied');
    expect(supplierCopySource(true, { status: 'loading' }, null).kind).toBe('loading');
    expect(supplierCopySource(true, { status: 'ready', templates: [] }, null).kind).toBe('fallback');
    expect(supplierCopySource(true, { status: 'ready', templates: [t(1, true)] }, null)).toMatchObject({ kind: 'template', template: { templateId: 1 } });
  });
});
