import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createWorkflowMockDb, setupWorkflowMockApi } from './helpers/mockWorkflowApi';

test.setTimeout(120_000);

test.use({
  actionTimeout: 15_000,
  ...(process.env.PLAYWRIGHT_BASE_URL ? { baseURL: process.env.PLAYWRIGHT_BASE_URL } : {}),
});

const boardStyles = readFileSync('src/pages/orderStatusBoard/orderStatusBoard.css', 'utf8');

for (const action of ['Печать', 'Экспорт в PDF']) {
  test(`${action}: visible order and details in the generated PDF with MDF CSS loaded`, async ({ page, context }, testInfo) => {
    const db = createWorkflowMockDb();
    db.orders.push({
      order_id: 501, order_name: '501-PRINT', client_id: 1, manager_id: 1,
      order_date: '2026-09-05', planned_completion_date: '2026-09-10',
      order_status_id: 1, payment_status_id: 2, production_status_id: 1,
      final_amount: 12000, total_amount: 12000, paid_amount: 4500,
      discount: 0, surcharge: 0, priority: 100, parts_count: 2, total_area: 1,
      delete_flag: false, version: 1,
    });
    db.order_details.push({
      detail_id: 1, order_id: 501, detail_number: 1, detail_name: 'Фасад печатный',
      height: 1000, width: 500, quantity: 2, area: 1, milling_type_id: 1,
      material_id: null, sheet_material_type_id: 1, delete_flag: false, version: 1,
    });
    await setupWorkflowMockApi(page, db, { uiVariant: 'legacy' });
    // Capture the real react-to-print document at the native print boundary.
    // No dialog in headless Chromium; PDF rendering below uses this exact HTML/CSS.
    await page.addInitScript(() => {
      new MutationObserver(() => {
        const frame = document.querySelector<HTMLIFrameElement>('#printWindow');
        if (!frame?.contentWindow) return;
        frame.contentWindow.print = () => {
          document.documentElement.dataset.printHtml = frame.contentDocument!.documentElement.outerHTML;
          document.documentElement.dataset.printTitle = frame.contentDocument!.title;
        };
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto('/orders/show/501', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('501-PRINT').first()).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.order-print-view')).toHaveCount(1);
    await expect(page.locator('.order-print-view')).toBeHidden();
    await page.addStyleTag({ content: boardStyles });
    if (action === 'Печать') {
      await page.getByRole('button', { name: /Печать$/ }).click();
    } else {
      await page.getByRole('button', { name: 'Ещё действия', exact: true }).click();
      await page.getByRole('menuitem', { name: /Экспорт в PDF$/ }).click();
    }
    await expect(page.locator('html')).toHaveAttribute('data-print-title', 'Заказ-501');
    const html = await page.locator('html').getAttribute('data-print-html');
    expect(html).not.toContain('.cnc-print-board');
    const printPage = await context.newPage();
    await printPage.setContent(html!);
    await printPage.emulateMedia({ media: 'print' });
    await expect(printPage.locator('.order-print-view')).toBeVisible();
    await expect(printPage.locator('.details-table')).toBeVisible();
    const pdf = await printPage.pdf({ preferCSSPageSize: true, printBackground: true });
    await testInfo.attach('order.pdf', { body: pdf, contentType: 'application/pdf' });
    const document = await getDocument({ data: new Uint8Array(pdf), useSystemFonts: true }).promise;
    const text = (await (await document.getPage(1)).getTextContent()).items
      .map(item => 'str' in item ? item.str : '').join(' ');
    expect(text).toContain('501');
    expect(text).toContain('1000');
    expect(text).toContain('500');
    await document.destroy();
    await printPage.close();
    await expect(page.locator('#printWindow')).toHaveCount(0);
  });
}
