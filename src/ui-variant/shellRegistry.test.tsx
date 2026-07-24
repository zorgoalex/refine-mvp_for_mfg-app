import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { VariantWorkspaceLayout } from './shellRegistry';

vi.mock('./UiVariantProvider', () => ({
  useUiVariant: () => ({ variant: 'legacy' }),
}));

describe('VariantWorkspaceLayout', () => {
  it('contains lazy shell suspension inside a loading boundary', () => {
    const html = renderToString(<VariantWorkspaceLayout />);

    expect(html).toContain('aria-label="Загрузка интерфейса"');
  });
});
