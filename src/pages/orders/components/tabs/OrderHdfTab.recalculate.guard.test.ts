import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('OrderHdfTab HDF recalculation action', () => {
  it('wires an explicit recalculate action from the HDF tab to the backend endpoint', () => {
    const tab = readFileSync(new URL('./OrderHdfTab.tsx', import.meta.url), 'utf8');
    const routes = readFileSync(new URL('../../../../api/apiRoutes.ts', import.meta.url), 'utf8');
    const api = readFileSync(new URL('../../../../api/ordersApi.ts', import.meta.url), 'utf8');
    const controller = readFileSync(
      new URL('../../../../../backend/src/modules/orders/http/orders.controller.ts', import.meta.url),
      'utf8',
    );
    const service = readFileSync(
      new URL('../../../../../backend/src/modules/orders/application/order-transaction.service.ts', import.meta.url),
      'utf8',
    );

    expect(tab).toContain('Пересчитать ХДФ');
    expect(tab).toContain('ordersApi.recalculateHdf(orderId)');
    expect(tab).toContain('Сначала сохраните изменения заказа');
    expect(tab).toContain('Устарело = расчёт был сделан до изменения настроек ХДФ');
    expect(routes).toContain('recalculateHdf: (orderId: number)');
    expect(api).toContain('async recalculateHdf(orderId: number)');
    expect(controller).toContain("@Post(':orderId/recalculate-hdf')");
    expect(service).toContain('async recalculateHdf(command: RecalculateOrderHdfCommand)');
  });
});
