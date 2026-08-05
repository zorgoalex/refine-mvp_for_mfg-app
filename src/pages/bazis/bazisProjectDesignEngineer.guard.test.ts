import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const view = readFileSync(new URL('./BazisProjectViewPage.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../../api/bazisApi.ts', import.meta.url), 'utf8');

describe('Bazis project design engineer card guard', () => {
  it('shows an active employee selector in the summary and persists through the backend command', () => {
    expect(view).toContain('label="Конструктор"');
    expect(view).toContain("resource: 'employees'");
    expect(view).toContain("field: 'is_active'");
    expect(view).toContain('queryOptions: { enabled: canManage }');
    expect(view).toContain('bazisApi.setProjectDesignEngineer');
    expect(api).toContain('projectDesignEngineer');
  });

  it('keeps visible provenance for XML, manual and unmatched values', () => {
    expect(view).toContain('Заполнен из XML');
    expect(view).toContain('Выбран вручную');
    expect(view).toContain('нет однозначного совпадения в сотрудниках');
  });
});
