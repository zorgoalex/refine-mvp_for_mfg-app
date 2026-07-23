import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CurrencyInput } from './CurrencyInput';

describe('CurrencyInput', () => {
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
