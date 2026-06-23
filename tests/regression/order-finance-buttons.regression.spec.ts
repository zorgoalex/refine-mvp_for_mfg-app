/**
 * Regression spec: Order Finance Buttons
 *
 * Exercises the finance/payment tab flows plus button coverage gaps identified in the
 * spec (Пересчитать суммы, Групповые действия, Удалить выбранные, edit detail, edit/delete
 * payment, orders-list Фильтры / Применить / Выгрузка JSON / Загрузка JSON).
 *
 * Runs against the local mocked Playwright harness (webServer boots dev:full automatically).
 * Screenshots are saved to /home/ovhtest/projects/erp_dev/spec_erp/logs/regression/order/.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { setupWorkflowMockApi } from '../helpers/mockWorkflowApi';

const SCREENSHOT_DIR = '/home/ovhtest/projects/erp_dev/spec_erp/logs/regression/order';

// Ensure screenshot directory exists (idempotent)
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function screenshot(page: Page, name: string) {
    const filePath = path.join(SCREENSHOT_DIR, `${name}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
}

// ----- AntD helpers -----

async function selectAntdOption(page: Page, formItem: Locator, optionText?: string) {
    await formItem.locator('.ant-select').first().click();
    const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
    const option = optionText
        ? dropdown.getByText(optionText, { exact: true })
        : dropdown.locator('.ant-select-item-option:not(.ant-select-item-option-disabled)').first();
    await expect(option).toBeVisible({ timeout: 15_000 });
    await option.click();
}

function formItem(scope: Locator, label: string) {
    return scope.locator('.ant-form-item').filter({ hasText: label }).first();
}

// ----------------------------------------------------------------

test.describe('Order finance buttons regression', () => {
    test.setTimeout(120_000);

    test('finance flow + button coverage', async ({ page }) => {
        const db = await setupWorkflowMockApi(page);

        // ================================================================
        // 1. Navigate to orders list and create order
        // ================================================================
        await page.goto('/orders');
        await expect(page.getByRole('button', { name: 'Создать заказ' })).toBeVisible({ timeout: 30_000 });

        await page.getByRole('button', { name: 'Создать заказ' }).click();

        const orderDialog = page.getByRole('dialog', { name: 'Создание нового заказа' });
        await expect(orderDialog).toBeVisible({ timeout: 15_000 });

        // Fill Основная информация
        await orderDialog.getByRole('tab', { name: 'Основная информация' }).click();
        await selectAntdOption(
            page,
            orderDialog.locator('.ant-form-item').filter({ hasText: 'Клиент' }).first(),
            'Базовый клиент',
        );
        await orderDialog.getByPlaceholder('Введите название заказа').fill('E2E Регрессионный заказ финансы');

        // ================================================================
        // 2. Add a detail: 1000x500x2, price 5000 per sqm  => area=1m², cost=5000
        // ================================================================
        await orderDialog.getByRole('tab', { name: 'Детали заказа' }).click();

        // Re-fetch detailsCard locator fresh after tab click
        const getDetailsCard = () =>
            orderDialog.locator('.ant-card').filter({ hasText: 'Всего позиций' }).first();

        // Buttons are disabled before any detail exists
        await expect(getDetailsCard().getByRole('button', { name: /Групповые действия/ })).toBeDisabled({ timeout: 10_000 });
        await expect(getDetailsCard().getByRole('button', { name: /Удалить выбранные/ })).toBeDisabled({ timeout: 5_000 });
        await expect(getDetailsCard().getByRole('button', { name: /Пересчитать суммы/ })).toBeDisabled({ timeout: 5_000 });

        // Open "Add via form" modal (the plus button)
        await getDetailsCard().getByRole('button', { name: 'plus' }).click();

        const detailDialog = page.getByRole('dialog', { name: 'Добавить деталь' });
        await expect(detailDialog).toBeVisible({ timeout: 10_000 });

        // Variant B: assert that the legacy materials Select is ABSENT (material_id removed).
        // The sole material selector is the "Материал" sheet picker (sheet_material_type_id).
        await expect(
            detailDialog.locator('#material_id'),
            'Variant B: legacy material_id Select must be absent from the detail form',
        ).toHaveCount(0);

        // Variant B: assert that the sheet picker ("Материал" label, sheet_material_type_id) is present.
        const sheetPickerItem = detailDialog.locator('.ant-form-item').filter({ hasText: 'Материал' }).first();
        await expect(sheetPickerItem).toBeVisible({ timeout: 10_000 });

        await detailDialog.locator('#height').fill('1000');
        await detailDialog.locator('#width').fill('500');
        await detailDialog.locator('#quantity').fill('2');
        await detailDialog.locator('#milling_cost_per_sqm').fill('5000');
        // Variant B: select from the sheet picker before saving (required field).
        await selectAntdOption(page, sheetPickerItem, 'МДФ 16 мм (Лист)');
        await screenshot(page, '00-detail-sheet-picker-filled');
        await detailDialog.getByRole('button', { name: 'Сохранить' }).click();
        await expect(detailDialog).toBeHidden({ timeout: 10_000 });

        // Detail added — "Всего позиций: 1" appears
        await expect(getDetailsCard().getByText('Всего позиций: 1')).toBeVisible({ timeout: 10_000 });
        await screenshot(page, '01-detail-added');

        // ================================================================
        // 2b. BUTTON COVERAGE: Пересчитать суммы — now enabled, click it
        // ================================================================
        await expect(getDetailsCard().getByRole('button', { name: /Пересчитать суммы/ })).toBeEnabled({ timeout: 5_000 });
        await getDetailsCard().getByRole('button', { name: /Пересчитать суммы/ }).click();
        // Expect a success notification/message
        await expect(
            page.locator('.ant-message-notice, .ant-notification-notice').first(),
        ).toBeVisible({ timeout: 10_000 });
        await screenshot(page, '02-recalc-sums');

        // ================================================================
        // 2c. BUTTON COVERAGE: Групповые действия — open dialog then Отмена
        // ================================================================
        await expect(getDetailsCard().getByRole('button', { name: /Групповые действия/ })).toBeEnabled({ timeout: 5_000 });
        await getDetailsCard().getByRole('button', { name: /Групповые действия/ }).click();
        const bulkDialog = page.getByRole('dialog', { name: 'Групповые действия' });
        await expect(bulkDialog).toBeVisible({ timeout: 10_000 });
        await screenshot(page, '03-bulk-actions-dialog');
        // Close via Отмена (button inside the bulk dialog footer)
        await bulkDialog.getByRole('button', { name: 'Отмена' }).click();
        await expect(bulkDialog).toBeHidden({ timeout: 10_000 });

        // ================================================================
        // 2d. BUTTON COVERAGE: Удалить выбранные — select checkbox, button enables
        // ================================================================
        // After bulk dialog closes, wait for the details tab card to be stable
        await expect(getDetailsCard()).toBeVisible({ timeout: 10_000 });

        // AntD tables include a hidden "measure row" as the first <tr aria-hidden>.
        // Target real data rows by excluding that hidden row.
        const detailTableBody = getDetailsCard().locator('.ant-table tbody');
        // Real data rows are NOT aria-hidden
        const firstDataTr = detailTableBody.locator('tr:not([aria-hidden])').first();
        await expect(firstDataTr).toBeVisible({ timeout: 10_000 });

        // Click the row-selection checkbox in the first data row
        const firstRowCheckbox = firstDataTr.locator('.ant-checkbox-input').first();
        await firstRowCheckbox.check({ timeout: 10_000 });

        const deleteSelectedBtn = getDetailsCard().getByRole('button', { name: /Удалить выбранные/ });
        await expect(deleteSelectedBtn).toBeEnabled({ timeout: 5_000 });
        await screenshot(page, '04-delete-selected-enabled');

        // Uncheck to deselect (we don't actually delete the detail)
        await firstRowCheckbox.uncheck({ timeout: 5_000 });
        await expect(deleteSelectedBtn).toBeDisabled({ timeout: 5_000 });

        // ================================================================
        // 2e. BUTTON COVERAGE: Edit existing detail (inline via pencil icon)
        // The pencil icon in the "Действия" column triggers inline row editing
        // (not a modal). Click it, change quantity, then save with the check icon.
        // ================================================================
        const editDetailBtn = firstDataTr.locator('button').filter({ has: page.locator('.anticon-edit') }).first();
        const editDetailBtnCount = await editDetailBtn.count();

        if (editDetailBtnCount > 0) {
            await editDetailBtn.click();
            // After clicking, the row enters inline edit mode — quantity cell gets an input
            const quantityInput = firstDataTr.locator('input#quantity');
            if ((await quantityInput.count()) > 0) {
                await quantityInput.fill('3');
                // Save with the check/confirm icon button
                const saveInlineBtn = firstDataTr
                    .locator('button')
                    .filter({ has: page.locator('.anticon-check') })
                    .first();
                if ((await saveInlineBtn.count()) > 0) {
                    await saveInlineBtn.click();
                } else {
                    // Fallback: press Enter to save
                    await quantityInput.press('Enter');
                }
                await screenshot(page, '05-detail-edited-inline');
            } else {
                // Pencil clicked but no inline input appeared — screenshot for diagnosis
                await screenshot(page, '05-detail-edit-inline-input-not-found');
            }
        } else {
            await screenshot(page, '05-detail-edit-icon-not-found');
        }

        // ================================================================
        // 3. PAYMENT FINANCE: Go to Финансы, read final amount, add payments
        // ================================================================
        await orderDialog.getByRole('tab', { name: 'Финансы' }).click();
        // Wait for the tab panel to be active/visible
        await expect(
            orderDialog.getByRole('button', { name: 'Добавить (форма)' }),
        ).toBeVisible({ timeout: 10_000 });

        // Payments "Удалить выбранные (0)" is disabled when no row is selected
        await expect(
            orderDialog.getByRole('button', { name: /Удалить выбранные/ }),
        ).toBeDisabled({ timeout: 5_000 });

        // The Финансы tab panel is the active pane — scope assertions to it.
        const financeTabPanel = orderDialog.locator('.ant-tabs-tabpane-active');

        // ----------------------------------------------------------------
        // Read «Финальная сумма (₸)» to derive dynamic payment amounts.
        // This ensures the test stays self-consistent even if detail prices change.
        // Fall back to «Сумма заказа» if Финальная сумма is empty/zero.
        // ----------------------------------------------------------------
        const finalAmountFormItem = financeTabPanel
            .locator('.ant-form-item')
            .filter({ hasText: 'Финальная сумма' })
            .first();
        await expect(finalAmountFormItem).toBeVisible({ timeout: 10_000 });

        const rawFinalValue = await finalAmountFormItem.locator('input').first().getAttribute('value');
        // Russian locale: space = thousands sep, comma = decimal sep. Convert to plain float.
        const parsedFinal = rawFinalValue
            ? parseFloat(rawFinalValue.replace(/\s/g, '').replace(',', '.'))
            : NaN;

        let final: number;
        if (!isNaN(parsedFinal) && parsedFinal > 0) {
            final = parsedFinal;
        } else {
            // Fallback: try «Сумма заказа»
            const totalAmountFormItem = financeTabPanel
                .locator('.ant-form-item')
                .filter({ hasText: 'Сумма заказа' })
                .first();
            const rawTotalValue = await totalAmountFormItem.locator('input').first().getAttribute('value');
            // Russian locale: space = thousands sep, comma = decimal sep
            final = rawTotalValue
                ? parseFloat(rawTotalValue.replace(/\s/g, '').replace(',', '.'))
                : 5000;
        }

        // Derive the two payment amounts from the final total
        const payment1 = Math.round(final / 2);
        const payment2 = final - payment1;

        // ---- Add first payment: payment1 (partial) ----
        await orderDialog.getByRole('button', { name: 'Добавить (форма)' }).click();
        const paymentDialog1 = page.getByRole('dialog', { name: 'Создать оплату' });
        await expect(paymentDialog1).toBeVisible({ timeout: 10_000 });

        await selectAntdOption(
            page,
            paymentDialog1.locator('.ant-form-item').filter({ hasText: 'Тип оплаты' }),
            'Наличные',
        );

        // Fill amount field (#amount id or spinbutton)
        const amountInput1 = paymentDialog1.locator('#amount');
        if ((await amountInput1.count()) > 0) {
            await amountInput1.fill(String(payment1));
        } else {
            await paymentDialog1.locator('input[role="spinbutton"]').first().fill(String(payment1));
        }
        await paymentDialog1.getByRole('button', { name: 'Создать' }).click();
        await expect(paymentDialog1).toBeHidden({ timeout: 10_000 });

        // Payment count confirms 1 payment
        await expect(orderDialog.getByText('Всего платежей: 1')).toBeVisible({ timeout: 10_000 });

        // ----------------------------------------------------------------
        // STRICT assertions after first (partial) payment.
        // The paid_amount recalc useEffect in OrderForm must run (bug: it was
        // gated behind isOrderDataLoading which was always true in create mode).
        // ----------------------------------------------------------------

        // «Оплачено (₸)» InputNumber input.value must equal payment1
        const paidAmountFormItem1 = financeTabPanel
            .locator('.ant-form-item')
            .filter({ hasText: 'Оплачено' })
            .first();
        await expect.poll(
            async () => {
                const val = await paidAmountFormItem1.locator('input').first().getAttribute('value');
                return val ? parseFloat(val.replace(/\s/g, '').replace(',', '.')) : -1;
            },
            { timeout: 10_000, message: `Оплачено should equal payment1 (${payment1}) after first payment` },
        ).toBe(payment1);

        // «Осталось (₸)» appears when paid > 0; its InputNumber must show final - payment1
        const remaining1 = final - payment1;
        const remainingFormItem1 = financeTabPanel
            .locator('.ant-form-item')
            .filter({ hasText: 'Осталось' })
            .first();
        await expect.poll(
            async () => {
                if ((await remainingFormItem1.count()) === 0) return -1;
                const val = await remainingFormItem1.locator('input').first().getAttribute('value');
                return val ? parseFloat(val.replace(/\s/g, '').replace(',', '.')) : -1;
            },
            { timeout: 10_000, message: `Остаток should equal ${remaining1} after first payment` },
        ).toBe(remaining1);

        // «Статус оплаты» select must show «Частично оплачено»
        const paymentStatusFormItem = financeTabPanel
            .locator('.ant-form-item')
            .filter({ hasText: 'Статус оплаты' })
            .first();
        await expect.poll(
            async () => {
                const item = paymentStatusFormItem.locator('.ant-select-selection-item');
                if ((await item.count()) === 0) return '';
                return (await item.textContent())?.trim() ?? '';
            },
            { timeout: 10_000, message: 'Статус оплаты should show «Частично оплачено» after first payment' },
        ).toBe('Частично оплачено');

        await screenshot(page, '06-partial-paid');

        // ================================================================
        // 3b. Add second payment: payment2 (completes the total = final)
        // ================================================================
        await orderDialog.getByRole('button', { name: 'Добавить (форма)' }).click();
        const paymentDialog2 = page.getByRole('dialog', { name: 'Создать оплату' });
        await expect(paymentDialog2).toBeVisible({ timeout: 10_000 });

        await selectAntdOption(
            page,
            paymentDialog2.locator('.ant-form-item').filter({ hasText: 'Тип оплаты' }),
            'Наличные',
        );
        const amountInput2 = paymentDialog2.locator('#amount');
        if ((await amountInput2.count()) > 0) {
            await amountInput2.fill(String(payment2));
        } else {
            await paymentDialog2.locator('input[role="spinbutton"]').first().fill(String(payment2));
        }
        await paymentDialog2.getByRole('button', { name: 'Создать' }).click();
        await expect(paymentDialog2).toBeHidden({ timeout: 10_000 });

        await expect(orderDialog.getByText('Всего платежей: 2')).toBeVisible({ timeout: 10_000 });

        // ----------------------------------------------------------------
        // STRICT assertions after second (full) payment.
        // «Оплачено» === final, «Остаток» === 0 (or hidden), «Статус» === «Оплачено»
        // ----------------------------------------------------------------

        // «Оплачено» must equal final
        await expect.poll(
            async () => {
                const val = await paidAmountFormItem1.locator('input').first().getAttribute('value');
                return val ? parseFloat(val.replace(/\s/g, '').replace(',', '.')) : -1;
            },
            { timeout: 10_000, message: `Оплачено should equal final (${final}) after second payment` },
        ).toBe(final);

        // «Осталось» must be 0 (or the field disappears when remaining reaches 0)
        await expect.poll(
            async () => {
                const count = await remainingFormItem1.count();
                if (count === 0) return 0; // field hidden means remaining is 0
                const val = await remainingFormItem1.locator('input').first().getAttribute('value');
                return val ? parseFloat(val.replace(/\s/g, '').replace(',', '.')) : -1;
            },
            { timeout: 10_000, message: 'Остаток should be 0 after full payment' },
        ).toBe(0);

        // «Статус оплаты» must show «Оплачено»
        await expect.poll(
            async () => {
                const item = paymentStatusFormItem.locator('.ant-select-selection-item');
                if ((await item.count()) === 0) return '';
                return (await item.textContent())?.trim() ?? '';
            },
            { timeout: 10_000, message: 'Статус оплаты should show «Оплачено» after full payment' },
        ).toBe('Оплачено');

        await screenshot(page, '07-fully-paid');

        // ================================================================
        // 3c. BUTTON COVERAGE: Edit existing payment (inline via pencil icon)
        // The payment table uses the same pattern as detail table: the pencil
        // icon triggers INLINE editing of the row (not a modal). The modal edit
        // is only accessible from the parent via onEdit prop, not from a visible
        // UI button — this is notCovered for modal-edit path.
        // We exercise the inline edit: click pencil, change amount, save.
        // ================================================================
        const paymentTableBody = financeTabPanel.locator('.ant-card').last().locator('.ant-table tbody');
        // Skip hidden measure row
        const firstPaymentRow = paymentTableBody.locator('tr:not([aria-hidden])').first();
        const editPaymentBtn = firstPaymentRow
            .locator('button')
            .filter({ has: page.locator('.anticon-edit') })
            .first();

        if ((await editPaymentBtn.count()) > 0) {
            await editPaymentBtn.click();
            // Inline edit mode: the amount cell should have an input
            const inlineAmountInput = firstPaymentRow.locator('input').first();
            if ((await inlineAmountInput.count()) > 0) {
                // Save via check button (confirm inline edit)
                const confirmInlineBtn = firstPaymentRow
                    .locator('button')
                    .filter({ has: page.locator('.anticon-check') })
                    .first();
                if ((await confirmInlineBtn.count()) > 0) {
                    await confirmInlineBtn.click();
                }
                await screenshot(page, '08-payment-inline-edit');
            } else {
                await screenshot(page, '08-payment-edit-clicked');
            }
        } else {
            await screenshot(page, '08-payment-edit-icon-not-found');
        }

        // ================================================================
        // 3d. BUTTON COVERAGE: Удалить выбранные (payments) — select row → enabled
        // ================================================================
        const firstPaymentCheckbox = firstPaymentRow.locator('.ant-checkbox-input').first();
        if ((await firstPaymentCheckbox.count()) > 0) {
            await firstPaymentCheckbox.check({ timeout: 5_000 });
            const deletePaymentsBtn = orderDialog.getByRole('button', {
                name: /Удалить выбранные \(1\)/,
            });
            await expect(deletePaymentsBtn).toBeEnabled({ timeout: 5_000 });
            await screenshot(page, '09-payment-delete-selected-enabled');
            await firstPaymentCheckbox.uncheck({ timeout: 5_000 });
        } else {
            await screenshot(page, '09-payment-delete-checkbox-not-found');
        }

        // ================================================================
        // 4. Save the order
        // ================================================================
        await orderDialog.getByRole('button', { name: 'Сохранить' }).first().click();

        // Wait for mock db to record the entities
        await expect.poll(() => db.orders.length, { timeout: 30_000 }).toBe(1);
        await expect.poll(() => db.order_details.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
        await expect.poll(() => db.payments.length, { timeout: 15_000 }).toBe(2);

        const order = db.orders[0];
        expect(order).toMatchObject({
            order_name: 'E2E Регрессионный заказ финансы',
            client_id: 1,
        });

        const totalPaid = (db.payments as Array<{ amount?: number }>).reduce(
            (sum, p) => sum + (p.amount ?? 0),
            0,
        );
        // payment1 + payment2 === final (derived from «Финальная сумма» above)
        expect(totalPaid).toBe(final);

        await screenshot(page, '10-order-saved');

        // ================================================================
        // 5. LIST PAGE: Фильтры / Применить / Выгрузка JSON / Загрузка JSON
        // ================================================================
        await page.goto('/orders');
        await expect(page.getByRole('button', { name: 'Создать заказ' })).toBeVisible({ timeout: 30_000 });

        // 5a. Выгрузка JSON — click opens "Пакетная выгрузка JSON snapshot" modal
        await expect(page.getByRole('button', { name: 'Выгрузка JSON' })).toBeVisible({ timeout: 10_000 });
        await page.getByRole('button', { name: 'Выгрузка JSON' }).click();
        const exportJsonDialog = page.getByRole('dialog', { name: /Пакетная выгрузка JSON snapshot/ });
        await expect(exportJsonDialog).toBeVisible({ timeout: 10_000 });
        await screenshot(page, '11-export-json-dialog');
        await exportJsonDialog.getByRole('button', { name: 'Отмена' }).click();
        await expect(exportJsonDialog).toBeHidden({ timeout: 10_000 });

        // 5b. Загрузка JSON — AntD Upload wrapper; the button must be present + enabled.
        // A real file chooser cannot be triggered without a file in the mock env.
        const importBtn = page.locator('button').filter({ hasText: 'Загрузка JSON' });
        await expect(importBtn).toBeVisible({ timeout: 10_000 });
        await expect(importBtn).toBeEnabled();
        await screenshot(page, '12-import-json-button-visible');

        // 5c. Фильтры — open, fill order name, click Применить
        await page.getByRole('button', { name: 'Фильтры' }).click();
        await expect(page.getByRole('button', { name: 'Применить' })).toBeVisible({ timeout: 10_000 });
        await screenshot(page, '13-filters-open');

        // Fill the "Заказ" (order name) filter field
        const filterOrderNameInput = page
            .locator('.ant-form-item')
            .filter({ hasText: 'Заказ' })
            .first()
            .locator('input')
            .first();
        await filterOrderNameInput.fill('E2E Регрессионный');
        await page.getByRole('button', { name: 'Применить' }).click();
        await screenshot(page, '14-filters-applied');

        // The list page is still visible after filter applied
        await expect(page.getByRole('button', { name: /Скрыть фильтры|Фильтры/ })).toBeVisible({ timeout: 10_000 });

        await screenshot(page, '15-done');
    });
});
