import { describe, expect, it } from 'vitest';

import { findReferenceId, normalizeReferenceName } from './useImportValidation';

describe('reference matching', () => {
  it('matches material names with optional spaces before millimeters', () => {
    const materials = [
      { id: 1, name: 'МДФ 16мм' },
      { id: 2, name: 'МДФ 18 мм' },
    ];

    expect(findReferenceId('МДФ 16 мм', materials)).toBe(1);
    expect(findReferenceId('МДФ 18мм', materials)).toBe(2);
  });

  it('normalizes e/yo spelling for reference names', () => {
    expect(normalizeReferenceName('Плёнка матовая')).toBe('пленка матовая');
  });
});
