import { expect, test } from '@playwright/test';
import { setupWorkflowMockApi } from './helpers/mockWorkflowApi';

test.use({
  ...(process.env.PLAYWRIGHT_BASE_URL
    ? { baseURL: process.env.PLAYWRIGHT_BASE_URL }
    : {}),
});

test.setTimeout(60_000);

test('first quick payment keeps the order form on the Finance tab', async ({ page }) => {
  const db = await setupWorkflowMockApi(page);

  db.orders.push({
    order_id: 420,
    order_name: 'E2E-Тест быстрое добавление оплаты',
    client_id: 1,
    manager_id: 1,
    order_date: '2026-07-17',
    planned_completion_date: '2026-07-27',
    order_status_id: 1,
    payment_status_id: 1,
    production_status_id: 1,
    production_status_from_details_enabled: true,
    total_amount: 1000,
    final_amount: 1000,
    paid_amount: 0,
    discount: 0,
    surcharge: 0,
    priority: 100,
    delete_flag: false,
    version: 1,
    created_at: '2026-07-17T00:00:00+05:00',
    updated_at: '2026-07-17T00:00:00+05:00',
  });

  await page.goto('/orders/edit/420');

  const financeTab = page.getByRole('tab', { name: 'Финансы', exact: true });
  await financeTab.click();
  await expect(financeTab).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('button', { name: 'Быстрое добавление' }).click();

  await expect(financeTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Быстрое добавление' })).toBeVisible();
  await expect(page.getByRole('row').filter({ has: page.getByRole('spinbutton') })).toHaveCount(1);
});
