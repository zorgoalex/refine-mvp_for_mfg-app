import { expect, test } from '@playwright/test';
import { setupWorkflowMockApi } from './helpers/mockWorkflowApi';

test('new order survives reload; explicit discard still clears it', async ({ page }) => {
  test.setTimeout(180_000);
  const db = await setupWorkflowMockApi(page, undefined, { runtimeConfig: false });
  await page.route(/\/runtime-config\.json$/, route => route.fulfill({ json: {
    apiUrl: '', hasuraUrl: '/v1/graphql',
    features: { backendAuth: false, backendPermissions: false, backendOrdersRead: false,
      backendOrdersWrite: true, backendReferences: false, enableLegacyHasura: true, sheetMaterialsReads: true },
    rollouts: { orderLifecycleV2: { enabled: true, percent: 100, allocationSalt: 'draft-test', configVersion: 'draft-test-v1' } },
  } }));
  await page.route(/\/api\/v1\/orders\/name-suggestion$/, route => route.fulfill({ json: { suggestedOrderName: '777' } }));
  await page.route(/\/api\/v1\/me\/preferences\/reference-usage$/, route => route.fulfill({ json: { preferences: {} } }));
  await page.goto('/orders');
  const create = page.locator('main button, .ant-layout-content button').filter({ hasText: 'Создать заказ' }).last();
  await create.click();
  const order = page.getByRole('dialog', { name: 'Создание нового заказа' });
  await expect(order).toBeVisible();
  await order.getByRole('tab', { name: 'Основная информация', exact: true }).click();
  await order.getByPlaceholder('Введите название заказа').fill('Unsaved browser draft');
  await order.getByRole('tab', { name: 'Детали заказа', exact: true }).click();
  for (let i = 1; i <= 3; i += 1) {
    await order.getByRole('button').filter({ has: page.locator('.anticon-plus') }).first().click();
    const detail = page.getByRole('dialog', { name: 'Добавить деталь', exact: true });
    await detail.locator('#height').fill(String(600 + i * 10));
    await detail.locator('#width').fill(String(400 + i * 10));
    await detail.locator('#quantity').fill(String(i));
    await detail.locator('#milling_cost_per_sqm').fill('10000');
    await detail.locator('#detail_name').fill('Draft detail ' + i);
    const material = detail.locator('.ant-select').filter({ has: page.locator('#sheet_material_type_id') });
    if (!(await material.locator('.ant-select-selection-item').count())) {
      await material.locator('.ant-select-selector').click();
      await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
    }
    await detail.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(detail).not.toBeVisible();
  }
  const expectDraft = async () => {
    await expect(order).toBeVisible();
    for (const height of [610, 620, 630]) {
      await expect(order.locator('td').filter({ hasText: new RegExp(`^${height}(?:[,.]00)?$`) }).first()).toBeVisible();
    }
    await order.getByRole('tab', { name: 'Основная информация', exact: true }).click();
    await expect(order.getByPlaceholder('Введите название заказа')).toHaveValue('Unsaved browser draft');
    await order.getByRole('tab', { name: 'Детали заказа', exact: true }).click();
  };
  await expectDraft();
  page.on('dialog', dialog => dialog.accept());
  await page.reload();
  await create.click();
  await order.getByRole('tab', { name: 'Детали заказа', exact: true }).click();
  await expectDraft();
  await order.locator('.ant-modal-close').click();
  const confirm = page.getByRole('dialog').filter({ hasText: 'Закрыть форму и удалить несохранённые данные?' });
  await confirm.getByRole('button', { name: 'Продолжить работу', exact: true }).click();
  await expectDraft();
  await order.locator('.ant-modal-close').click();
  await confirm.getByRole('button', { name: 'Закрыть без сохранения', exact: true }).click();
  await expect(order).not.toBeVisible();
  await create.click();
  await order.getByRole('tab', { name: 'Основная информация', exact: true }).click();
  await expect(order.getByPlaceholder('Введите название заказа')).not.toHaveValue('Unsaved browser draft');
  expect(db.orders).toEqual([]);
  expect(db.order_details).toEqual([]);
});
