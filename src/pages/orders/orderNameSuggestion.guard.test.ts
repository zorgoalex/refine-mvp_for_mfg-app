import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('order create name suggestion guard', () => {
  it('loads the backend suggestion without overwriting a user-entered name', () => {
    const source = readFileSync(
      new URL('./components/OrderForm.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('.getNextOrderName()');
    expect(source).toMatch(/if \(!store\.header\.order_name\?\.trim\(\)\)/);
    expect(source).toContain("store.updateHeaderField('order_name', suggestedOrderName)");
    expect(source).toContain('server still enforces uniqueness on save');
  });
});
