import type { QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import type { DatabaseService } from '../../database/database.service';
import type { TransactionClient } from '../../database/database.types';
import { DailyDigestOrderReader } from './daily-digest-order-reader';

const orders = [
  {
    order_id: '12', order_name: 'К-12', order_date: '2026-09-20',
    planned_completion_date: '2026-09-23', client_name: 'Заказчик',
    order_status_name: 'Упакован', payment_status_name: 'Не оплачен',
    total_area: '2.75', production_status_id: '2', production_status_name: 'Упакован',
  },
  {
    order_id: '14', order_name: '14', order_date: '2026-09-21',
    planned_completion_date: '2026-09-23', client_name: null,
    order_status_name: 'Новый', payment_status_name: 'Оплачен',
    total_area: '1.25', production_status_id: null, production_status_name: null,
  },
];

const details = [
  { order_id: '12', detail_id: '101', detail_number: 1, basis_project: ' ПМЗ-2 ', production_status_id: '1', production_status_name: 'Распилен', milling_type_name: 'Модерн', material_name: 'МДФ 16мм' },
  { order_id: '12', detail_id: '102', detail_number: 2, basis_project: 'ПМЗ-2', production_status_id: null, production_status_name: 'Распилен', milling_type_name: 'Паз', material_name: 'МДФ 18мм' },
  { order_id: '12', detail_id: '103', detail_number: 3, basis_project: 'ПМЗ-3', production_status_id: null, production_status_name: 'Доставка', milling_type_name: 'Фрезеровка выборка', material_name: 'ЛДСП белая' },
  { order_id: '14', detail_id: '104', detail_number: 1, basis_project: null, production_status_id: null, production_status_name: null, milling_type_name: 'Модерн', material_name: null },
];

const statuses = [
  { production_status_id: 1, production_status_code: 'cut', production_status_name: 'Распилен', sort_order: 5, is_active: true },
  { production_status_id: 2, production_status_code: 'pack', production_status_name: 'Упакован', sort_order: 7, is_active: true },
  { production_status_id: 3, production_status_code: 'dispatch_a', production_status_name: 'Доставка', sort_order: 9, is_active: true },
  { production_status_id: 4, production_status_code: 'dispatch_b', production_status_name: 'Доставка', sort_order: 10, is_active: true },
];

function makeReader(input: { orderRows?: unknown[]; detailRows?: unknown[] } = {}) {
  const query = vi.fn(async (sql: string, _params: readonly unknown[] = []): Promise<{ rows: QueryResultRow[] }> => {
    if (sql.includes('FROM orders o')) return { rows: (input.orderRows ?? orders) as QueryResultRow[] };
    if (sql.includes('FROM order_details od')) return { rows: (input.detailRows ?? details) as QueryResultRow[] };
    if (sql.includes('FROM order_doweling_links odl')) {
      return { rows: [{ order_id: '12', doweling_order_link_id: '7', doweling_order_name: 'Дюбель-заказ' }] as QueryResultRow[] };
    }
    if (sql.includes('FROM production_status_events pse')) {
      return { rows: [{ order_id: '12', production_status_id: '1' }] as QueryResultRow[] };
    }
    if (sql.includes('FROM production_statuses')) return { rows: statuses as QueryResultRow[] };
    if (sql.includes('FROM app_settings')) {
      return {
        rows: [{
          is_active: true,
          value_json: {
            value: {
              status_codes_order: ['pack', 'cut'],
              letters_by_code: { pack: 'я', cut: 'ц' },
            },
          },
        }] as QueryResultRow[],
      };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const tx = { query } as unknown as TransactionClient;
  const transaction = vi.fn(async <T>(handler: (client: TransactionClient) => Promise<T>, _options?: unknown) => handler(tx));
  const reader = new DailyDigestOrderReader({ transaction } as unknown as DatabaseService);
  return { reader, query, transaction };
}

describe('DailyDigestOrderReader', () => {
  it('reads the exact non-deleted production orders for the date in a repeatable-read transaction', async () => {
    const { reader, query, transaction } = makeReader();
    const snapshot = await reader.read('2026-09-23');

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolation: 'repeatable read' });
    const orderQuery = query.mock.calls[0][0];
    expect(orderQuery).toContain("o.order_kind = 'production_order'");
    expect(orderQuery).toContain('o.delete_flag = false');
    expect(orderQuery).toContain('o.planned_completion_date = $1::date');
    expect(orderQuery).toContain('ORDER BY o.order_id ASC');
    expect(orderQuery).toContain('LIMIT $2');
    expect(query.mock.calls[0][1]).toEqual(['2026-09-23', 501]);
    expect(snapshot.orders.map((order) => order.orderId)).toEqual([12, 14]);
    expect(snapshot.totalArea).toBe(4);
    expect(snapshot.cardsPerMessage).toBe(2);
  });

  it('matches Calendar card aggregates and freezes configured stage order and letters', async () => {
    const { reader } = makeReader();
    const snapshot = await reader.read('2026-09-23');

    expect(snapshot.workflowDisplay).toMatchObject({
      displayOrderCodes: ['pack', 'cut', 'dispatch_a', 'dispatch_b'],
      codeToLetter: { pack: 'Я', cut: 'Ц' },
    });
    expect(snapshot.orders[0]).toMatchObject({
      orderId: 12,
      basisProjectDisplay: 'Дюбель-заказ',
      materials: [
        { fullName: 'МДФ 18мм', label: '18мм' },
        { fullName: 'ЛДСП белая', label: 'ЛДСП' },
      ],
      millingDisplay: 'Выборка',
      passedProductionCodes: ['cut', 'pack'],
      totalArea: 2.75,
    });
    expect(snapshot.orders[1]).toMatchObject({
      orderId: 14,
      basisProjectDisplay: null,
      materials: [],
      millingDisplay: 'Модерн',
      passedProductionCodes: [],
    });
  });

  it('requires every child/detail and doweling query to exclude soft-deleted rows', async () => {
    const { reader, query } = makeReader();
    await reader.read('2026-09-23');
    const detailQuery = query.mock.calls.find(([sql]) => sql.includes('FROM order_details od'))?.[0] ?? '';
    const dowelingQuery = query.mock.calls.find(([sql]) => sql.includes('FROM order_doweling_links odl'))?.[0] ?? '';
    expect(detailQuery).toContain('od.delete_flag = false');
    expect(dowelingQuery).toContain('odl.delete_flag = false');
  });

  it('fails visibly on the 501st order instead of truncating the day', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({ ...orders[0], order_id: index + 1 }));
    const { reader, query } = makeReader({ orderRows: rows });
    await expect(reader.read('2026-09-23')).rejects.toMatchObject({
      code: 'DAILY_DIGEST_ORDER_LIMIT_EXCEEDED',
      statusCode: 422,
      message: expect.stringContaining('не будет отправлено'),
    } satisfies Partial<ApiError>);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(['2026-02-30', '23.09.2026', '2026-9-23'])('rejects invalid business date %s before querying', async (date) => {
    const { reader, query } = makeReader();
    await expect(reader.read(date)).rejects.toMatchObject({ code: 'DAILY_DIGEST_DATE_INVALID' });
    expect(query).not.toHaveBeenCalled();
  });
});
