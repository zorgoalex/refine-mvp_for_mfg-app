import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync('src/pages/orders/components/OrderCreateModal.tsx', 'utf8');

describe('order create modal draft safety', () => {
  it('does not close from backdrop or Escape', () => {
    expect(source).toContain('maskClosable={false}');
    expect(source).toContain('keyboard={false}');
  });

  it('keeps OrderForm mounted while minimized and exposes a restore control', () => {
    expect(source).not.toContain('destroyOnClose');
    expect(source).toContain('open={open && !isMinimized}');
    expect(source).toContain('open && isMinimized');
    expect(source).toContain('Развернуть форму создания заказа');
  });

  it('switches to the orders workspace before restore', () => {
    expect(source).toContain("navigate('/orders')");
    expect(source).toContain('setIsMinimized(false)');
  });

  it('confirms explicit dirty-draft discard', () => {
    expect(source).toContain('getState().isDirty');
    expect(source).toContain('Закрыть форму и удалить несохранённые данные?');
  });
});
