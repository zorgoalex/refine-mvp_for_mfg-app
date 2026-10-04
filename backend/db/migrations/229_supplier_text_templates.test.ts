import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STANDARD_SUPPLIER_TEXT_TEMPLATE } from '../../src/modules/orders/domain/supplier-text-template';

const sql = readFileSync(new URL('./229_supplier_text_templates.sql', import.meta.url), 'utf8');

describe('229_supplier_text_templates migration', () => {
  it('creates the table with one active default and unique active names', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.supplier_request_text_templates/);
    expect(sql).toMatch(/uq_srtt_active_name[\s\S]*WHERE deleted_at IS NULL/);
    expect(sql).toMatch(/uq_srtt_one_default[\s\S]*WHERE is_default AND deleted_at IS NULL/);
  });

  it('seeds «Стандартный» exactly as the domain standard template, as default, only into an empty table', () => {
    const body = STANDARD_SUPPLIER_TEXT_TEMPLATE.body.replace(/\n/g, '\\n');
    expect(sql).toContain(`E'${body}'`);
    expect(sql).toContain(`'${STANDARD_SUPPLIER_TEXT_TEMPLATE.line}'`);
    expect(sql).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM public\.supplier_request_text_templates\)/);
  });
});
