import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Пин инварианта корзины: НИ ОДИН write-путь не должен мутировать мягко
// удалённый заказ — все FOR UPDATE-загрузчики заказов фильтруют
// delete_flag = false (удалённый заказ даёт 404, единственный вход обратно —
// команда restore). Если пин упал — вы сняли фильтр или добавили новый
// загрузчик без него; чините загрузчик, не тест.

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('soft-deleted orders are not mutable (delete_flag pins)', () => {
  it('orders: loadOrderForUpdate locks only alive orders', () => {
    const src = read('./adapters/pg-order-transaction-manager.ts');
    expect(src).toMatch(
      /SELECT order_id, order_name, version, created_by, manager_id\s+FROM orders\s+WHERE order_id = \$1 AND delete_flag = false\s+AND order_kind = 'production_order'\s+FOR UPDATE/,
    );
  });

  it('production-actions: loadOrderForUpdate locks only alive orders', () => {
    const src = read('../production-actions/adapters/pg-production-action-repository.ts');
    expect(src).toMatch(
      /FROM orders\s+WHERE order_id = \$1 AND delete_flag = false\s+AND order_kind = 'production_order'\s+FOR UPDATE/,
    );
  });

  it('payments: loadOrdersForUpdate locks only alive orders', () => {
    const src = read('../payments/adapters/pg-payment-repository.ts');
    expect(src).toMatch(
      /FROM orders\s+WHERE order_id = ANY\(\$1::bigint\[\]\) AND delete_flag = false\s+ORDER BY order_id\s+FOR UPDATE/,
    );
  });
});
