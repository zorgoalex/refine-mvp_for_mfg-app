import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CurrencyInput, formatCurrencyInputFocusedValue } from './CurrencyInput';

describe('CurrencyInput', () => {
  it('edits integers without decimal zeroes and trims fractional zeroes', () => {
    expect(formatCurrencyInputFocusedValue(0, 2)).toBe('0');
    expect(formatCurrencyInputFocusedValue(12, 2)).toBe('12');
    expect(formatCurrencyInputFocusedValue(12.5, 2)).toBe('12,5');
  });

  it('preserves an explicitly typed decimal separator', () => {
    expect(formatCurrencyInputFocusedValue(12, 2, {
      userTyping: true,
      input: '12,',
    })).toBe('12,');
    expect(formatCurrencyInputFocusedValue(12, 2, {
      userTyping: true,
      input: '12.',
    })).toBe('12.');
  });

  it('keeps only missing draft values empty when requested', () => {
    const missingMarkup = renderToStaticMarkup(
      <CurrencyInput emptyWhenUnset value={undefined} />,
    );
    const zeroMarkup = renderToStaticMarkup(
      <CurrencyInput emptyWhenUnset value={0} />,
    );

    expect(missingMarkup).toContain('value=""');
    expect(zeroMarkup).toContain('value="0,00"');
  });

  it('preserves the existing blurred zero display by default', () => {
    const markup = renderToStaticMarkup(<CurrencyInput value={0} />);

    expect(markup).toContain('value="0,00"');
  });
});
