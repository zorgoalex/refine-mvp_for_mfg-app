import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const listSource = readFileSync(resolve(process.cwd(), 'src/pages/clients/list.tsx'), 'utf8');

describe('clients list filters', () => {
  it('has the reference filter bar like the other references', () => {
    expect(listSource).toContain('<ReferenceFilterBar storageKey="clients"');
    expect(listSource).toContain('activeField: true');
    expect(listSource).toContain('search: { field: "client_name"');
  });

  it('filters columns from the header (distinct values) instead of the fixed antd lists', () => {
    expect(listSource).toContain('useReferenceHeaderFilters(table, CLIENTS_HEADER_FILTERS)');
    expect(listSource).toContain('{...columnFilter("person_type")}');
    expect(listSource).not.toContain('{ text: "Неактивен", value: false }');
  });

  it('keeps the «go to client» jump search', () => {
    expect(listSource).toContain('findClientByName(clientName)');
    expect(listSource).toContain('placeholder="Перейти к клиенту"');
  });
});
