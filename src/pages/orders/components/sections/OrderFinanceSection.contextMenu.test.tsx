import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, 'OrderFinanceSection.tsx'), 'utf8');

describe('OrderFinanceSection final amount context menu', () => {
  it('uses React/AntD state instead of imperative DOM menu construction', () => {
    expect(source).toContain('Dropdown');
    expect(source).toContain('finalAmountContextMenu');
    expect(source).not.toContain("document.createElement('div')");
    expect(source).not.toContain('menu.innerHTML');
    expect(source).not.toContain("document.querySelectorAll('.final-amount-context-menu')");
    expect(source).not.toContain('document.body.appendChild(menu)');
  });
});
