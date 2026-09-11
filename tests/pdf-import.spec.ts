import { expect, test } from '@playwright/test';
import { createWorkflowMockDb, setupWorkflowMockApi } from './helpers/mockWorkflowApi';

test.setTimeout(180_000);
test.use({ actionTimeout: 45_000 });

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 600 }]) {
  test.describe(`${viewport.width}px PDF import`, () => {
    test.use({ viewport });

    test('scrolls to the last mapping and fills the existing empty order rows', async ({ page, context }) => {
      // A real PDF with three distinct layouts exercises parsing and the actual wizard.
      const pdfPage = await context.newPage();
      await pdfPage.setContent(`<style>
        @page { size: A3 landscape; margin: 30px; }
        section { break-after: page; }
        table { width: 1400px; table-layout: fixed; border-collapse: collapse; font: 12px Arial; }
        td, th { padding: 10px 0; text-align: left; }
      </style>${[1, 2, 3].map(index => `<section><table>
        <tr>${['Наименование', 'Кол-во', 'Длина', 'Ширина', 'Материал', 'Поле A', 'Поле B', `Тест поле ${index}`]
          .map(label => `<th>${label}</th>`).join('')}</tr>
        <tr>${[`E2E-panel-${index}`, '2', '700', '400', 'МДФ 16 мм (Лист)', 'A', 'B', `E2E-note-${index}`]
          .map(value => `<td>${value}</td>`).join('')}</tr>
      </table></section>`).join('')}`);
      const pdf = await pdfPage.pdf({ preferCSSPageSize: true });
      await pdfPage.close();

      const db = createWorkflowMockDb();
      db.orders.push({ order_id: 501, order_name: 'E2E PDF import', client_id: 1, manager_id: 1,
        order_date: '2026-09-11', order_status_id: 1, payment_status_id: 2,
        final_amount: 0, total_amount: 0, paid_amount: 0, discount: 0, surcharge: 0,
        priority: 100, parts_count: 0, total_area: 0, delete_flag: false, version: 1 });
      await setupWorkflowMockApi(page, db, { runtimeConfig: { pdfImportLayoutPatterns: true } });
      await page.route('**/api/v1/me/preferences/reference-usage', route => route.fulfill({
        json: { preferences: { recentReferences: {} } },
      }));
      await page.route('**/api/v1/orders/name-suggestion*', route => route.fulfill({
        json: { suggestedOrderName: 'E2E PDF import' },
      }));
      await page.route('**/pdf-table-patterns/match', route => route.fulfill({ json: { results: [] } }));
      await page.route('**/pdf-table-patterns', route => route.fulfill({ json: {} }));
      await page.goto('/orders');
      if (viewport.width < 600) {
        await page.getByRole('button', { name: /Действия и фильтры/ }).click({ timeout: 60_000 });
      }
      await page.getByRole('button', { name: 'Создать заказ' }).click({ timeout: 60_000 });
      const detailsTab = page.getByRole('tab', { name: 'Детали заказа', exact: true });
      await expect(detailsTab).toBeVisible({ timeout: 60_000 });
      if (await detailsTab.getAttribute('aria-selected') !== 'true') await detailsTab.click();
      await page.getByRole('button', { name: 'Импорт деталей из файла', exact: true }).click();
      await page.getByRole('menuitem', { name: /Импорт из PDF/ }).click();
      const dialog = page.getByRole('dialog', { name: /Импорт деталей из PDF/ });
      await dialog.locator('input[type="file"]').setInputFiles({ name: 'E2E-mapping.pdf', mimeType: 'application/pdf', buffer: pdf });
      await dialog.getByRole('button', { name: /Далее/ }).click();
      await expect(dialog.getByText('Неизвестная структура PDF', { exact: true })).toBeVisible();
      const lastRow = dialog.getByRole('row').filter({ hasText: 'Тест поле 3' });
      await expect(lastRow).toHaveCount(1);

      // Wheel input must scroll the wizard content, without moving its footer.
      const next = dialog.getByRole('button', { name: /Далее/ });
      const footerBefore = await next.boundingBox();
      const body = dialog.locator('.ant-modal-body');
      const bounds = (await body.boundingBox())!;
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.wheel(0, 5000);
      await expect(lastRow).toBeInViewport();
      expect(await dialog.getByTestId('pdf-import-step-scroll').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      await expect(next).toBeInViewport();
      expect((await next.boundingBox())!.y).toBeCloseTo(footerBefore!.y, 0);
      const modalBounds = (await dialog.boundingBox())!;
      expect(modalBounds.y + modalBounds.height).toBeLessThanOrEqual(viewport.height);
      await lastRow.locator('.ant-select').click();
      await page.locator('.ant-select-dropdown:visible').getByTitle('Примечание', { exact: true }).click();
      await expect(lastRow).toContainText('Примечание');
      await next.click();
      await dialog.getByRole('button', { name: 'Импортировать (3 шт)', exact: true }).click();
      await expect(dialog).not.toBeVisible();

      const details = await page.evaluate(() => {
        const key = Object.keys(sessionStorage).find(key => key.startsWith('order-form-storage:') && key.endsWith(':order:new'));
        return JSON.parse(sessionStorage.getItem(key!)!).state.details;
      });
      expect(details).toHaveLength(20);
      expect(details.slice(0, 3).map((row: { detail_number: number }) => row.detail_number)).toEqual([1, 2, 3]);
      expect(details.slice(0, 3).every((row: { is_placeholder: boolean }) => row.is_placeholder === false)).toBe(true);
      expect(details[2].note).toBe('E2E-note-3');
      expect(details.slice(3).every((row: { is_placeholder: boolean }) => row.is_placeholder === true)).toBe(true);
    });
  });
}
