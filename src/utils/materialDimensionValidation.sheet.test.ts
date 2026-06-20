import { describe, it, expect } from 'vitest';
import { validateSheetDimensions } from './materialDimensionValidation';

const sheet = { name: 'МДФ 16', widthMm: 2800, heightMm: 2070 };

describe('validateSheetDimensions (SP3 UX mirror)', () => {
  it('passes when the detail fits the sheet in some orientation', () => {
    expect(validateSheetDimensions(2000, 1000, sheet).isValid).toBe(true);
    // orientation-agnostic: 2700x2000 fits a 2800x2070 sheet
    expect(validateSheetDimensions(2000, 2700, sheet).isValid).toBe(true);
  });

  it('fails when the detail exceeds the sheet', () => {
    const res = validateSheetDimensions(2900, 1000, sheet);
    expect(res.isValid).toBe(false);
    expect(res.errorMessage).toContain('не помещается');
  });

  it('is a no-op when dimensions or sheet dims are missing', () => {
    expect(validateSheetDimensions(null, 1000, sheet).isValid).toBe(true);
    expect(validateSheetDimensions(2000, 1000, null).isValid).toBe(true);
    expect(
      validateSheetDimensions(2000, 1000, { widthMm: null, heightMm: null }).isValid,
    ).toBe(true);
  });
});
