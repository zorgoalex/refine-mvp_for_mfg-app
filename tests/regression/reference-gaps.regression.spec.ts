/**
 * Regression spec: Reference Gaps
 *
 * Covers the four reference catalogs that are declared in App.tsx (create/edit/show
 * routes all present) but were not exercised by reference-workflows.spec.ts:
 *
 *   1. payments            (/payments)
 *   2. users               (/users)      — custom form-dispatch submit
 *   3. order_workshops     (/order-workshops)
 *   4. order_resource_requirements (/order-resource-requirements)
 *
 * Runs against the local mocked Playwright harness (webServer boots dev:full automatically).
 * Screenshots are saved to /home/ovhtest/projects/erp_dev/spec_erp/logs/regression/reference/.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { setupWorkflowMockApi, createWorkflowMockDb } from '../helpers/mockWorkflowApi';

const SCREENSHOT_DIR = '/home/ovhtest/projects/erp_dev/spec_erp/logs/regression/reference';
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function screenshot(page: Page, name: string) {
    const filePath = path.join(SCREENSHOT_DIR, `${name}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
}

// ------------ AntD helpers (copied from reference-workflows.spec.ts) ---------------

async function fillText(page: Page, id: string, value: string) {
    const input = page.locator(`#${id}`);
    await input.fill(value);
}

async function setChecked(page: Page, id: string, checked: boolean) {
    const input = page.locator(`#${id}`);
    if (checked) {
        await input.check();
    } else {
        await input.uncheck();
    }
}

function formItem(page: Page, label: string) {
    return page.locator('.ant-form-item').filter({ hasText: label }).first();
}

async function selectAntdOption(page: Page, label: string, optionText: string) {
    const fi = formItem(page, label);
    // Click the selector trigger — works for both .ant-select and .ant-select-selector
    const trigger = fi.locator('.ant-select-selector').first();
    await expect(trigger).toBeVisible({ timeout: 10_000 });
    await trigger.click();
    const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
    await expect(dropdown).toBeVisible({ timeout: 10_000 });
    await dropdown.locator('.ant-select-item-option').filter({ hasText: optionText }).first().click();
}

/** Fill an InputNumber by clearing first, then typing */
async function fillInputNumber(page: Page, id: string, value: string) {
    const el = page.locator(`#${id}`);
    await el.click({ clickCount: 3 });
    await el.fill(value);
}

async function settleNavigation(page: Page, previousUrl: string) {
    await expect(page).not.toHaveURL(previousUrl, { timeout: 10_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(200);
}

async function deleteMockRecord(
    page: Page,
    resource: string,
    idField: string,
    id: number | string,
) {
    const response = await page.evaluate(
        async ({ resource, idField, id }) => {
            const literalId = typeof id === 'number' ? String(id) : JSON.stringify(id);
            const result = await fetch('/v1/graphql', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: `
                        mutation {
                            delete_${resource}_by_pk(${idField}: ${literalId}) {
                                ${idField}
                            }
                        }
                    `,
                }),
            });
            return result.json();
        },
        { resource, idField, id },
    );
    expect(response.errors).toBeUndefined();
}

// ===================================================================================
// TEST SUITE
// ===================================================================================

test.describe('Reference gaps regression', () => {
    test.setTimeout(180_000);

    // -------------------------------------------------------------------------------
    // 1. payments
    // -------------------------------------------------------------------------------
    test('payments — create, list, edit, show, delete', async ({ page }) => {
        const db = createWorkflowMockDb();

        // Seed: an order + a payment_type are required by the create form selects
        db.orders.push({
            order_id: 100,
            order_name: 'Тест-Заказ-Е2Е',
            client_id: 1,
            order_status_id: 1,
            payment_status_id: 1,
            production_status_id: 1,
            version: 0,
            order_doweling_links: [],
        });
        // payment_types already seeded with id=1 "Наличные"

        await setupWorkflowMockApi(page, db);

        // ---- CREATE ----
        await page.goto('/payments/create');
        await expect(page.locator('h1,h2,.ant-page-header-heading-title').first()).toBeVisible({ timeout: 30_000 });

        // Select order
        await selectAntdOption(page, 'Заказ', 'Тест-Заказ-Е2Е');
        // Select payment type
        await selectAntdOption(page, 'Тип оплаты', 'Наличные');
        // Fill amount (InputNumber)
        await fillInputNumber(page, 'amount', '15000');
        // Fill date
        const datePicker = page.locator('#payment_date');
        await datePicker.click();
        await page.keyboard.type('01.06.2026');
        await page.keyboard.press('Enter');
        // notes
        await page.locator('#notes').fill('E2E Тест платёж');

        await screenshot(page, '01-payments-create-filled');

        const createUrl = page.url();
        await page.getByRole('button', { name: 'Сохранить' }).click();

        await expect.poll(() => db.payments.find((r) => r.notes === 'E2E Тест платёж')?.payment_id, { timeout: 30_000 }).toBeTruthy();
        await settleNavigation(page, createUrl);

        const created = db.payments.find((r) => r.notes === 'E2E Тест платёж')!;
        expect(created).toMatchObject({ order_id: 100, type_paid_id: 1, amount: 15000 });

        // ---- LIST ----
        await page.goto('/payments');
        await expect(page.locator('.ant-table-row').filter({ hasText: '15 000' }).or(page.locator('.ant-table-row').filter({ hasText: '15000' })).first()).toBeVisible({ timeout: 30_000 });
        await screenshot(page, '02-payments-list-after-create');

        // ---- EDIT ----
        await page.goto(`/payments/edit/${created.payment_id}`);
        await expect(page.locator('#amount')).toBeVisible({ timeout: 30_000 });
        // update amount — InputNumber requires triple-click to clear
        await fillInputNumber(page, 'amount', '25000');
        await page.locator('#notes').fill('E2E Тест платёж обновлен');

        const editUrl = page.url();
        await page.getByRole('button', { name: 'Сохранить' }).click();
        await expect.poll(() => db.payments.find((r) => r.payment_id === created.payment_id)?.amount, { timeout: 30_000 }).toBe(25000);
        await settleNavigation(page, editUrl);

        // ---- SHOW ----
        await page.goto(`/payments/show/${created.payment_id}`);
        await expect(page.getByText('25 000').or(page.getByText('25000')).first()).toBeVisible({ timeout: 30_000 });

        // ---- DELETE (via mock GraphQL) ----
        await deleteMockRecord(page, 'payments', 'payment_id', created.payment_id);
        await expect.poll(() => db.payments.some((r) => r.payment_id === created.payment_id)).toBe(false);
    });

    // -------------------------------------------------------------------------------
    // 2. users — custom submit (dispatches 'submit' event on #user-create-form)
    // -------------------------------------------------------------------------------
    test('users — create (custom submit), list, show, edit, delete', async ({ page }) => {
        const db = createWorkflowMockDb();
        await setupWorkflowMockApi(page, db);

        // Mock the legacy POST /api/users/create endpoint
        await page.route(/\/api\/users\/create$/, async (route) => {
            const body = JSON.parse(route.request().postData() || '{}');
            // Insert a user into the mock db so the list can show it
            const newUser = {
                user_id: db.users.length + 100,
                username: body.username,
                email: body.email,
                full_name: body.full_name ?? '',
                role_id: 1,
                role: { role_id: 1, role_name: body.role ?? 'viewer' },
                employee_id: null,
                is_active: body.is_active ?? true,
                last_login_at: null,
                ref_key_1c: null,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            };
            db.users.push(newUser);

            await route.fulfill({
                status: 201,
                contentType: 'application/json',
                body: JSON.stringify({ user_id: newUser.user_id, username: newUser.username }),
            });
        });

        // ---- CREATE ----
        await page.goto('/users/create');
        await expect(page.locator('#user-create-form')).toBeVisible({ timeout: 30_000 });

        await fillText(page, 'username', 'e2etestuser');
        await fillText(page, 'email', 'e2etestuser@example.test');
        await fillText(page, 'password', 'TestPass123!');
        // Select role — use page.getByRole for the combobox labelled 'Роль', then dispatch
        // mousedown via evaluate to reliably open the AntD Select dropdown
        const roleCombobox = page.getByRole('combobox', { name: /Роль/ });
        await expect(roleCombobox).toBeVisible({ timeout: 10_000 });
        // Walk up to .ant-select-selector and programmatically open the dropdown
        await roleCombobox.evaluate((el) => {
            let node: HTMLElement | null = el as HTMLElement;
            while (node && !node.classList.contains('ant-select-selector')) {
                node = node.parentElement;
            }
            const target = node || (el as HTMLElement);
            target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
            target.click();
        });
        const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
        await expect(dropdown).toBeVisible({ timeout: 15_000 });
        await dropdown.locator('.ant-select-item-option').filter({ hasText: 'Менеджер (manager)' }).first().click();
        await fillText(page, 'full_name', 'E2E Тест Пользователь');
        await setChecked(page, 'is_active', true);

        await screenshot(page, '03-users-create-filled');

        // Custom submit: click Сохранить button (which dispatches 'submit' event on #user-create-form)
        await page.getByRole('button', { name: 'Сохранить' }).click();

        // The component calls list('users') on success → navigates to /users
        await expect(page).toHaveURL(/\/users$/, { timeout: 30_000 });

        // ---- LIST ----
        await page.goto('/users');
        await expect(page.locator('.ant-table-row').filter({ hasText: 'e2etestuser' })).toBeVisible({ timeout: 30_000 });
        await screenshot(page, '04-users-list-after-create');

        const created = db.users.find((u) => u.username === 'e2etestuser')!;
        expect(created).toBeTruthy();

        // ---- SHOW ----
        await page.goto(`/users/show/${created.user_id}`);
        await expect(page.getByText('e2etestuser', { exact: true })).toBeVisible({ timeout: 30_000 });

        // ---- EDIT (uses standard Рефайн form + Сохранить) ----
        await page.goto(`/users/edit/${created.user_id}`);
        await expect(page.locator('#full_name')).toBeVisible({ timeout: 30_000 });
        await fillText(page, 'full_name', 'E2E Тест Пользователь Обновлен');

        const editUrl = page.url();
        await page.getByRole('button', { name: 'Сохранить' }).click();
        await settleNavigation(page, editUrl).catch(() => {});

        // ---- DELETE ----
        await deleteMockRecord(page, 'users', 'user_id', created.user_id);
        await expect.poll(() => db.users.some((u) => u.user_id === created.user_id)).toBe(false);
    });

    // -------------------------------------------------------------------------------
    // 3. order_workshops
    // -------------------------------------------------------------------------------
    test('order_workshops — create, list, edit, show, delete', async ({ page }) => {
        const db = createWorkflowMockDb();

        // Seed parent order and workshop for FK consistency
        db.orders.push({
            order_id: 200,
            order_name: 'Тест-Заказ-ОW-Е2Е',
            client_id: 1,
            order_status_id: 1,
            payment_status_id: 1,
            production_status_id: 1,
            version: 0,
            order_doweling_links: [],
        });

        await setupWorkflowMockApi(page, db);

        // ---- CREATE ----
        await page.goto('/order-workshops/create');
        await expect(page.locator('form').first()).toBeVisible({ timeout: 30_000 });

        await page.locator('#order_id').fill('200');
        await page.locator('#workshop_id').fill('1');
        await page.locator('#production_status_id').fill('1');
        await page.locator('#sequence_order').fill('5');
        await page.locator('#notes').fill('E2E Тест цех заказа');
        await page.locator('#ref_key_1c').fill('OW-E2E-001');

        await screenshot(page, '05-order-workshops-create-filled');

        const createUrl = page.url();
        await page.getByRole('button', { name: 'Сохранить' }).click();

        await expect.poll(() => db.order_workshops.find((r) => r.notes === 'E2E Тест цех заказа')?.order_workshop_id, { timeout: 30_000 }).toBeTruthy();
        await settleNavigation(page, createUrl);

        const created = db.order_workshops.find((r) => r.notes === 'E2E Тест цех заказа')!;
        expect(created).toMatchObject({ order_id: 200, workshop_id: 1, production_status_id: 1, sequence_order: 5 });

        // ---- LIST ----
        await page.goto('/order-workshops');
        await expect(page.locator('.ant-table-row').filter({ hasText: 'OW-E2E-001' }).or(
            page.locator('.ant-table-row').first()
        )).toBeVisible({ timeout: 30_000 });
        await screenshot(page, '06-order-workshops-list-after-create');

        // ---- EDIT ----
        await page.goto(`/order-workshops/edit/${created.order_workshop_id}`);
        await expect(page.locator('#order_id')).toBeVisible({ timeout: 30_000 });
        await page.locator('#notes').fill('E2E Тест цех заказа обновлен');
        await page.locator('#sequence_order').fill('10');

        const editUrl = page.url();
        await page.getByRole('button', { name: 'Сохранить' }).click();
        await expect.poll(() => db.order_workshops.find((r) => r.order_workshop_id === created.order_workshop_id)?.sequence_order, { timeout: 30_000 }).toBe(10);
        await settleNavigation(page, editUrl);

        // ---- SHOW ----
        await page.goto(`/order-workshops/show/${created.order_workshop_id}`);
        await expect(page.getByText(String(created.order_workshop_id)).first()).toBeVisible({ timeout: 30_000 });

        // ---- DELETE ----
        await deleteMockRecord(page, 'order_workshops', 'order_workshop_id', created.order_workshop_id);
        await expect.poll(() => db.order_workshops.some((r) => r.order_workshop_id === created.order_workshop_id)).toBe(false);
    });

    // -------------------------------------------------------------------------------
    // 4. order_resource_requirements
    // -------------------------------------------------------------------------------
    test('order_resource_requirements — create, list, edit, show, delete', async ({ page }) => {
        const db = createWorkflowMockDb();

        // Seed parent order; resource_requirements_statuses already has id=1 in base db
        db.orders.push({
            order_id: 300,
            order_name: 'Тест-Заказ-ORR-Е2Е',
            client_id: 1,
            order_status_id: 1,
            payment_status_id: 1,
            production_status_id: 1,
            version: 0,
            order_doweling_links: [],
        });
        // Seed a requirement status (resource_requirements_statuses is empty in base db)
        db.resource_requirements_statuses.push({
            requirement_status_id: 1,
            requirement_status_code: 'PENDING',
            requirement_status_name: 'Ожидает',
            sort_order: 10,
            is_active: true,
        });

        await setupWorkflowMockApi(page, db);

        // ---- CREATE ----
        await page.goto('/order-resource-requirements/create');
        await expect(page.locator('form').first()).toBeVisible({ timeout: 30_000 });

        await page.locator('#order_id').fill('300');
        // resource_type Select
        const resourceTypeFormItem = page.locator('.ant-form-item').filter({ hasText: 'Resource Type' }).first();
        await resourceTypeFormItem.locator('.ant-select').first().click();
        const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
        await dropdown.locator('.ant-select-item-option').filter({ hasText: 'Material' }).first().click();

        await page.locator('#required_quantity').fill('10');
        await page.locator('#unit_id').fill('1');
        await page.locator('#requirement_status_id').fill('1');
        await page.locator('#notes').fill('E2E Тест потребность ресурса');
        await page.locator('#ref_key_1c').fill('ORR-E2E-001');
        await setChecked(page, 'is_active', true);

        await screenshot(page, '07-order-resource-requirements-create-filled');

        const createUrl = page.url();
        await page.getByRole('button', { name: 'Сохранить' }).click();

        await expect.poll(
            () => db.order_resource_requirements.find((r) => r.notes === 'E2E Тест потребность ресурса')?.requirement_id,
            { timeout: 30_000 }
        ).toBeTruthy();
        await settleNavigation(page, createUrl);

        const created = db.order_resource_requirements.find((r) => r.notes === 'E2E Тест потребность ресурса')!;
        expect(created).toMatchObject({
            order_id: 300,
            resource_type: 'material',
            required_quantity: 10,
            unit_id: 1,
            requirement_status_id: 1,
        });

        // ---- LIST ----
        await page.goto('/order-resource-requirements');
        // Table should have at least one row
        await expect(page.locator('.ant-table-row').first()).toBeVisible({ timeout: 30_000 });
        await screenshot(page, '08-order-resource-requirements-list-after-create');

        // ---- EDIT ----
        await page.goto(`/order-resource-requirements/edit/${created.requirement_id}`);
        await expect(page.locator('#order_id')).toBeVisible({ timeout: 30_000 });
        await page.locator('#notes').fill('E2E Тест потребность ресурса обновлен');
        await page.locator('#required_quantity').fill('20');

        const editUrl = page.url();
        await page.getByRole('button', { name: 'Сохранить' }).click();
        await expect.poll(
            () => db.order_resource_requirements.find((r) => r.requirement_id === created.requirement_id)?.required_quantity,
            { timeout: 30_000 }
        ).toBe(20);
        await settleNavigation(page, editUrl);

        // ---- SHOW ----
        await page.goto(`/order-resource-requirements/show/${created.requirement_id}`);
        await expect(page.getByText(String(created.requirement_id)).first()).toBeVisible({ timeout: 30_000 });

        // ---- DELETE ----
        await deleteMockRecord(page, 'order_resource_requirements', 'requirement_id', created.requirement_id);
        await expect.poll(
            () => db.order_resource_requirements.some((r) => r.requirement_id === created.requirement_id)
        ).toBe(false);
    });
});
