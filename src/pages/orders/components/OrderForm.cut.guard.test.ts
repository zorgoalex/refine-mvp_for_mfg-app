import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('./OrderForm.tsx', import.meta.url)), 'utf8');

describe('OrderForm embedded cut tab guards', () => {
  it('adds a cut.view-gated embedded cut tab for saved orders', () => {
    expect(source).toContain('import { CutPage }');
    expect(source).toContain("featureFlags.useBackendCut && can('cut.view')");
    expect(source).toContain("key: 'cut'");
    expect(source).toContain("label: 'Раскрой'");
    expect(source).toContain('<CutPage embeddedOrderId={header.order_id} />');
    expect(source).toContain("disabled: mode === 'create' && !header.order_id");
  });
});
