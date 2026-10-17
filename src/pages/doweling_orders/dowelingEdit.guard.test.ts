import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const editSource = readFileSync(resolve(process.cwd(), 'src/pages/doweling_orders/edit.tsx'), 'utf8');
const dataProviderSource = readFileSync(resolve(process.cwd(), 'src/utils/dataProvider.ts'), 'utf8');

describe('doweling order full edit form', () => {
  it('edits every order the doweling order is linked to (multi-select), unlinking included', () => {
    const orderField = editSource.split('label="Заказы"')[1]?.split('label="Дата заказа"')[0] ?? '';

    expect(orderField).toContain('mode="multiple"');
    expect(orderField).toContain('allowClear');
    expect(orderField).not.toContain('required: true');
    expect(editSource).toContain('order_ids: linkedOrderIds');
  });

  it('picks orders from orders_view (Hasura `orders` is ERP-admin-only since 0Б)', () => {
    expect(editSource).toMatch(/useSelect\(\{\s*resource: "orders_view",\s*optionLabel: "order_name"/);
    expect(editSource).not.toMatch(/resource: ["']orders["']/);
  });

  it('saves through the backend command with the loaded version, never through Hasura', () => {
    expect(editSource).toContain('dowelingApi.update(dowelingOrderId, request)');
    expect(editSource).toContain('expectedVersion: Number(record.version ?? 0)');
    expect(editSource).toContain('DOWELING_VERSION_CONFLICT');
    expect(editSource).toContain('DOWELING_LINKS_CONFLICT');
    expect(editSource).toContain('baseOrderIds: linkedOrderIds');
    // A legacy-only order (doweling_orders.order_id without a link) is shown and kept.
    expect(editSource).toContain('toNullableNumber(record?.order_id)');
    expect(editSource).not.toMatch(/useCreate|useUpdate|useFormWithHighlight|syncDowelingLinks/);
  });

  it('supports deactivating a doweling order record (an inactive one has no orders)', () => {
    expect(editSource).toContain('label="Активен"');
    expect(editSource).toContain('name="is_active"');
    expect(editSource).toContain('valuePropName="checked"');
    expect(editSource).toContain('if (!checked) form.setFieldsValue({ order_ids: [] })');
  });

  it('keeps link soft-delete fields available to dataProvider filters', () => {
    const linkFields = dataProviderSource.split('order_doweling_links: [')[1]?.split('],')[0] ?? '';

    expect(linkFields).toContain('"delete_flag"');
    expect(linkFields).toContain('"version"');
    expect(linkFields).not.toContain('"order {');
  });

  it('keeps full edit-only fields readable on doweling_orders (the card loads them)', () => {
    const dowelingFields = dataProviderSource.split('doweling_orders: [')[1]?.split('],')[0] ?? '';

    expect(dowelingFields).toContain('"surcharge"');
    expect(dowelingFields).toContain('"ref_key_1c"');
    expect(dowelingFields).toContain('"delete_flag"');
  });
});
