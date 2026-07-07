import { describe, it, expect } from 'vitest';
import { buildGqlInput } from './dataProvider';

// Regression: the "Видимость таблиц для юзеров" config tab saves a
// navigation.resource_visibility_by_role matrix into app_settings.value_json.
// The matrix keys are Refine resource names, some of which contain hyphens
// (e.g. "cut-jobs"). The old builder inlined the jsonb blob into the GraphQL
// document and stripped quotes from every key, producing `cut-jobs: {...}` —
// an invalid GraphQL Name — so Hasura returned 400 "not a valid graphql query".
// jsonb/object columns must now be passed as typed `$variables` instead.
describe('buildGqlInput passes jsonb objects as GraphQL variables', () => {
  it('emits a $variable for an object column with GraphQL-invalid keys', () => {
    const { literal, varHeader, varValues } = buildGqlInput({
      setting_key: 'navigation.resource_visibility_by_role',
      value_json: { 'cut-jobs': { admin: true }, orders_view: { worker: false } },
      is_active: true,
    });

    // The hyphenated key never appears unquoted in the query text.
    expect(literal).not.toContain('cut-jobs');
    expect(literal).toContain('value_json: $v0');
    // Scalars stay inlined.
    expect(literal).toContain('setting_key: "navigation.resource_visibility_by_role"');
    expect(literal).toContain('is_active: true');
    // Variable is declared as jsonb and carries the raw object with keys intact.
    expect(varHeader).toBe('($v0: jsonb)');
    expect(varValues).toEqual({
      v0: { 'cut-jobs': { admin: true }, orders_view: { worker: false } },
    });
  });

  it('routes arrays-of-objects to a variable but keeps scalar arrays inline', () => {
    const objArr = buildGqlInput({ steps: [{ id: 1 }, { id: 2 }] });
    expect(objArr.varHeader).toBe('($v0: jsonb)');
    expect(objArr.literal).toContain('steps: $v0');

    const scalarArr = buildGqlInput({ tags: [1, 2, 3] });
    expect(scalarArr.varHeader).toBe('');
    expect(scalarArr.literal).toContain('tags: [1,2,3]');
  });

  it('inlines a plain scalar payload with no variables', () => {
    const { literal, varHeader, varValues } = buildGqlInput({
      role_name: 'Оператор',
      is_active: false,
    });
    expect(varHeader).toBe('');
    expect(varValues).toEqual({});
    expect(literal).toContain('role_name: "Оператор"');
    expect(literal).toContain('is_active: false');
  });
});
