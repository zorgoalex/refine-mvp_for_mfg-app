import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const editSource = readFileSync(resolve(process.cwd(), 'src/pages/doweling_orders/edit.tsx'), 'utf8');
const dataProviderSource = readFileSync(resolve(process.cwd(), 'src/utils/dataProvider.ts'), 'utf8');

describe('doweling order full edit form', () => {
  it('allows unlinking from an order directly in the edit form', () => {
    const orderField = editSource.split('label="Заказ"')[1]?.split('label="Дата заказа"')[0] ?? '';

    expect(orderField).toContain('allowClear');
    expect(orderField).not.toContain('required: true');
    expect(editSource).toContain('const nextOrderId = isActive ? toNullableNumber(values.order_id) : null');
    expect(editSource).toContain('order_id: nextOrderId');
  });

  it('syncs legacy order_id and order_doweling_links when saving', () => {
    expect(editSource).toContain('const syncDowelingLinks = async (nextOrderId: number | null)');
    expect(editSource).toContain('values: { delete_flag: true }');
    expect(editSource).toContain('resource: "order_doweling_links"');
    expect(editSource).toContain('doweling_order_id: dowelingOrderId');
    expect(editSource).toContain('await syncDowelingLinks(nextOrderId)');
  });

  it('supports deactivating a doweling order record', () => {
    expect(editSource).toContain('label="Активен"');
    expect(editSource).toContain('name="is_active"');
    expect(editSource).toContain('valuePropName="checked"');
    expect(editSource).toContain('delete_flag: !isActive');
  });

  it('keeps link soft-delete fields available to dataProvider filters and sync', () => {
    const linkFields = dataProviderSource.split('order_doweling_links: [')[1]?.split('],')[0] ?? '';

    expect(linkFields).toContain('"delete_flag"');
    expect(linkFields).toContain('"version"');
  });

  it('keeps full edit-only fields writable on doweling_orders', () => {
    const dowelingFields = dataProviderSource.split('doweling_orders: [')[1]?.split('],')[0] ?? '';

    expect(dowelingFields).toContain('"surcharge"');
    expect(dowelingFields).toContain('"ref_key_1c"');
    expect(dowelingFields).toContain('"delete_flag"');
  });
});
