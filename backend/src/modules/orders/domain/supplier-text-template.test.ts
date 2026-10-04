import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STANDARD_SUPPLIER_TEXT_TEMPLATE, validateTemplate } from './supplier-text-template';

const fixtures = JSON.parse(readFileSync(new URL('./supplier-text-template.fixtures.json', import.meta.url), 'utf8')) as {
  parse: Array<{ template: string; scope: 'body' | 'line'; ok: boolean; code?: string }>;
};

describe('supplier text template validation (shared fixture with FE)', () => {
  it.each(fixtures.parse)('$template ($scope)', ({ template, scope, ok, code }) => {
    const error = validateTemplate(template, scope);
    if (ok) expect(error).toBeNull();
    else expect(error?.code).toBe(code);
  });

  it('the standard template is valid', () => {
    expect(validateTemplate(STANDARD_SUPPLIER_TEXT_TEMPLATE.body, 'body')).toBeNull();
    expect(validateTemplate(STANDARD_SUPPLIER_TEXT_TEMPLATE.line, 'line')).toBeNull();
  });
});
