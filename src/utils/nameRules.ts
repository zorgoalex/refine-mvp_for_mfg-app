import { humanNameError, REFERENCE_NAME_LIMITS } from '../../backend/src/shared/human-name';

/** Optional emptiness is left to the field's required rule. */
export function nameRule(field: string, maxOverride?: number, minOverride?: number) {
  const [min, max] = REFERENCE_NAME_LIMITS[field] ?? [1, 200];
  return {
    validator: (_rule: unknown, value: unknown): Promise<void> => {
      if (value == null || value === '') return Promise.resolve();
      const error = typeof value !== 'string' ? 'Введите название' : humanNameError(value, maxOverride ?? max, minOverride ?? min);
      return error ? Promise.reject(new Error(error)) : Promise.resolve();
    },
  };
}
