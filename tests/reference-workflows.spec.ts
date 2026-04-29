import { expect, test, type Locator, type Page } from '@playwright/test';
import { setupWorkflowMockApi, type WorkflowMockDb } from './helpers/mockWorkflowApi';

type CatalogCase = {
    title: string;
    path: string;
    resource: string;
    idField: string;
    nameField: string;
    createName: string;
    updateName: string;
    fillCreate: (page: Page) => Promise<void>;
    fillUpdate?: (page: Page) => Promise<void>;
    expectedCreate?: Record<string, any>;
    expectedUpdate?: Record<string, any>;
};

const catalogCases: CatalogCase[] = [
    {
        title: 'типы обката',
        path: '/edge-types',
        resource: 'edge_types',
        idField: 'edge_type_id',
        nameField: 'edge_type_name',
        createName: 'E2E обкат R3',
        updateName: 'E2E обкат R3 обновлен',
        fillCreate: async (page) => {
            await page.locator('#edge_type_name').fill('E2E обкат R3');
            await page.locator('#sort_order').fill('25');
            await page.locator('#description').fill('Создано из workflow-теста');
            await page.locator('#ref_key_1c').fill('EDGE-E2E');
        },
        fillUpdate: async (page) => {
            await page.locator('#edge_type_name').fill('E2E обкат R3 обновлен');
            await page.locator('#is_active').uncheck();
        },
        expectedCreate: { sort_order: 25, description: 'Создано из workflow-теста', ref_key_1c: 'EDGE-E2E' },
        expectedUpdate: { is_active: false },
    },
    {
        title: 'типы материалов',
        path: '/material-types',
        resource: 'material_types',
        idField: 'material_type_id',
        nameField: 'material_type_name',
        createName: 'E2E тип материала',
        updateName: 'E2E тип материала обновлен',
        fillCreate: async (page) => {
            await page.locator('#material_type_name').fill('E2E тип материала');
            await page.locator('#sort_order').fill('35');
            await page.locator('#description').fill('Материал из workflow-теста');
        },
        fillUpdate: async (page) => {
            await page.locator('#material_type_name').fill('E2E тип материала обновлен');
            await page.locator('#is_active').uncheck();
        },
        expectedCreate: { sort_order: 35 },
        expectedUpdate: { is_active: false },
    },
    {
        title: 'типы фрезеровки',
        path: '/milling-types',
        resource: 'milling_types',
        idField: 'milling_type_id',
        nameField: 'milling_type_name',
        createName: 'E2E фрезеровка',
        updateName: 'E2E фрезеровка обновлена',
        fillCreate: async (page) => {
            await page.locator('#milling_type_name').fill('E2E фрезеровка');
            await page.locator('#cost_per_sqm').fill('12345');
            await page.locator('#sort_order').fill('45');
            await page.locator('#description').fill('Фрезеровка из workflow-теста');
        },
        fillUpdate: async (page) => {
            await page.locator('#milling_type_name').fill('E2E фрезеровка обновлена');
            await page.locator('#is_active').uncheck();
        },
        expectedCreate: { cost_per_sqm: 12345, sort_order: 45 },
        expectedUpdate: { is_active: false },
    },
    {
        title: 'типы пленки',
        path: '/film-types',
        resource: 'film_types',
        idField: 'film_type_id',
        nameField: 'film_type_name',
        createName: 'E2E тип пленки',
        updateName: 'E2E тип пленки обновлен',
        fillCreate: async (page) => {
            await page.locator('#film_type_name').fill('E2E тип пленки');
            await page.locator('#ref_key_1c').fill('FILM-TYPE-E2E');
        },
        fillUpdate: async (page) => {
            await page.locator('#film_type_name').fill('E2E тип пленки обновлен');
            await page.locator('#is_active').uncheck();
        },
        expectedCreate: { ref_key_1c: 'FILM-TYPE-E2E' },
        expectedUpdate: { is_active: false },
    },
    {
        title: 'типы оплат',
        path: '/payment-types',
        resource: 'payment_types',
        idField: 'type_paid_id',
        nameField: 'type_paid_name',
        createName: 'E2E тип оплаты',
        updateName: 'E2E тип оплаты обновлен',
        fillCreate: async (page) => {
            await page.locator('#type_paid_name').fill('E2E тип оплаты');
            await page.locator('#sort_order').fill('55');
            await page.locator('#ref_key_1c').fill('PAY-TYPE-E2E');
        },
        fillUpdate: async (page) => {
            await page.locator('#type_paid_name').fill('E2E тип оплаты обновлен');
            await page.locator('#is_active').uncheck();
        },
        expectedCreate: { sort_order: 55, ref_key_1c: 'PAY-TYPE-E2E' },
        expectedUpdate: { is_active: false },
    },
    {
        title: 'поставщики',
        path: '/suppliers',
        resource: 'suppliers',
        idField: 'supplier_id',
        nameField: 'supplier_name',
        createName: 'E2E поставщик',
        updateName: 'E2E поставщик обновлен',
        fillCreate: async (page) => {
            await page.locator('#supplier_name').fill('E2E поставщик');
            await page.locator('#address').fill('Алматы, тестовый адрес');
            await page.locator('#contact_person').fill('Контакт E2E');
            await page.locator('#phone').fill('+7 701 555 1212');
            await page.locator('#description').fill('Поставщик из workflow-теста');
        },
        fillUpdate: async (page) => {
            await page.locator('#supplier_name').fill('E2E поставщик обновлен');
            await page.locator('#is_active').uncheck();
        },
        expectedCreate: { phone: '+7 701 555 1212' },
        expectedUpdate: { is_active: false },
    },
    {
        title: 'производители',
        path: '/vendors',
        resource: 'vendors',
        idField: 'vendor_id',
        nameField: 'vendor_name',
        createName: 'E2E производитель',
        updateName: 'E2E производитель обновлен',
        fillCreate: async (page) => {
            await page.locator('#vendor_name').fill('E2E производитель');
            await selectAntdOption(page, formItem(page, 'Тип материала'), 'МДФ');
            await page.locator('#contact_info').fill('vendor@example.test');
        },
        fillUpdate: async (page) => {
            await page.locator('#vendor_name').fill('E2E производитель обновлен');
            await page.locator('#is_active').uncheck();
        },
        expectedCreate: { material_type_id: 1, contact_info: 'vendor@example.test' },
        expectedUpdate: { is_active: false },
    },
    {
        title: 'единицы измерения',
        path: '/units',
        resource: 'units',
        idField: 'unit_id',
        nameField: 'unit_name',
        createName: 'E2E единица',
        updateName: 'E2E единица обновлена',
        fillCreate: async (page) => {
            await page.locator('#unit_code').fill('e2e');
            await page.locator('#unit_name').fill('E2E единица');
            await page.locator('#unit_symbol').fill('e2e');
            await page.locator('#decimals').fill('3');
        },
        fillUpdate: async (page) => {
            await page.locator('#unit_name').fill('E2E единица обновлена');
        },
        expectedCreate: { unit_code: 'e2e', unit_symbol: 'e2e', decimals: 3 },
    },
    {
        title: 'пленки',
        path: '/films',
        resource: 'films',
        idField: 'film_id',
        nameField: 'film_name',
        createName: 'E2E пленка',
        updateName: 'E2E пленка обновлена',
        fillCreate: async (page) => {
            await page.locator('#film_name').fill('E2E пленка');
            await selectAntdOption(page, formItem(page, 'Film Type'), 'ПВХ');
            await selectAntdOption(page, formItem(page, 'Производитель'), 'Тестовый производитель');
            await page.locator('#film_texture').check();
        },
        fillUpdate: async (page) => {
            await page.locator('#film_name').fill('E2E пленка обновлена');
            await page.locator('#is_active').uncheck();
        },
        expectedCreate: { film_type_id: 1, vendor_id: 1, film_texture: true },
        expectedUpdate: { is_active: false },
    },
    {
        title: 'материалы',
        path: '/materials',
        resource: 'materials',
        idField: 'material_id',
        nameField: 'material_name',
        createName: 'E2E материал',
        updateName: 'E2E материал обновлен',
        fillCreate: async (page) => {
            await page.locator('#material_name').fill('E2E материал');
            await selectAntdOption(page, formItem(page, 'Unit'), 'Квадратный метр');
            await selectAntdOption(page, formItem(page, 'Material Type'), 'МДФ');
            await selectAntdOption(page, formItem(page, 'Vendor'), 'Тестовый производитель');
            await selectAntdOption(page, formItem(page, 'Supplier'), 'Тестовый поставщик');
            await page.locator('#description').fill('Материал из workflow-теста');
        },
        fillUpdate: async (page) => {
            await page.locator('#material_name').fill('E2E материал обновлен');
            await page.locator('#is_active').uncheck();
        },
        expectedCreate: { unit_id: 1, material_type_id: 1, vendor_id: 1, default_supplier_id: 1 },
        expectedUpdate: { is_active: false },
    },
    {
        title: 'сотрудники',
        path: '/employees',
        resource: 'employees',
        idField: 'employee_id',
        nameField: 'full_name',
        createName: 'E2E сотрудник',
        updateName: 'E2E сотрудник обновлен',
        fillCreate: async (page) => {
            await page.locator('#full_name').fill('E2E сотрудник');
            await page.locator('#position').fill('Тестировщик справочников');
            await page.locator('#note').fill('Создано из workflow-теста');
        },
        fillUpdate: async (page) => {
            await page.locator('#full_name').fill('E2E сотрудник обновлен');
            await page.locator('#is_active').uncheck();
        },
        expectedCreate: { position: 'Тестировщик справочников' },
        expectedUpdate: { is_active: false },
    },
    {
        title: 'цеха',
        path: '/workshops',
        resource: 'workshops',
        idField: 'workshop_id',
        nameField: 'workshop_name',
        createName: 'E2E цех',
        updateName: 'E2E цех обновлен',
        fillCreate: async (page) => {
            await page.locator('#workshop_name').fill('E2E цех');
            await page.locator('#address').fill('Адрес E2E цеха');
            await selectAntdOption(page, formItem(page, 'Ответственный сотрудник'), 'Администратор Тестов');
        },
        fillUpdate: async (page) => {
            await page.locator('#workshop_name').fill('E2E цех обновлен');
            await page.locator('#is_active').uncheck();
        },
        expectedCreate: { responsible_employee_id: 1 },
        expectedUpdate: { is_active: false },
    },
    {
        title: 'участки цехов',
        path: '/work-centers',
        resource: 'work_centers',
        idField: 'workcenter_id',
        nameField: 'workcenter_name',
        createName: 'E2E участок',
        updateName: 'E2E участок обновлен',
        fillCreate: async (page) => {
            await page.locator('#workcenter_code').fill('E2E-WC');
            await page.locator('#workcenter_name').fill('E2E участок');
            await selectAntdOption(page, formItem(page, 'Цех'), 'Основной цех');
        },
        fillUpdate: async (page) => {
            await page.locator('#workcenter_name').fill('E2E участок обновлен');
            await page.locator('#is_active').uncheck();
        },
        expectedCreate: { workcenter_code: 'E2E-WC', workshop_id: 1 },
        expectedUpdate: { is_active: false },
    },
    {
        title: 'направления движения',
        path: '/transaction-direction',
        resource: 'transaction_direction',
        idField: 'direction_type_id',
        nameField: 'direction_name',
        createName: 'E2E направление',
        updateName: 'E2E направление обновлено',
        fillCreate: async (page) => {
            await page.locator('#direction_code').fill('E2E-DIR');
            await page.locator('#direction_name').fill('E2E направление');
            await page.locator('#description').fill('Направление из workflow-теста');
        },
        fillUpdate: async (page) => {
            await page.locator('#direction_name').fill('E2E направление обновлено');
            await page.locator('#is_active').uncheck();
        },
        expectedCreate: { direction_code: 'E2E-DIR' },
        expectedUpdate: { is_active: false },
    },
    {
        title: 'типы движений материалов',
        path: '/material-transaction-types',
        resource: 'material_transaction_types',
        idField: 'transaction_type_id',
        nameField: 'transaction_type_name',
        createName: 'E2E движение материала',
        updateName: 'E2E движение материала обновлено',
        fillCreate: async (page) => {
            await page.locator('#transaction_type_name').fill('E2E движение материала');
            await selectAntdOption(page, formItem(page, 'Direction'), 'Приход');
            await page.locator('#sort_order').fill('65');
            await page.locator('#description').fill('Тип движения из workflow-теста');
        },
        fillUpdate: async (page) => {
            await page.locator('#transaction_type_name').fill('E2E движение материала обновлено');
            await page.locator('#is_active').uncheck();
        },
        expectedCreate: { direction_type_id: 1, affects_stock: true, requires_document: false, sort_order: 65 },
        expectedUpdate: { is_active: false },
    },
];

test.describe('Reference workflows', () => {
    test.setTimeout(120000);

    test('creates and updates all non-status catalogs', async ({ page }) => {
        const db = await setupWorkflowMockApi(page);

        for (const catalog of catalogCases) {
            await test.step(catalog.title, async () => {
                await createAndUpdateCatalog(page, db, catalog);
            });
        }
    });

    test('creates a client with primary phone', async ({ page }) => {
        const db = await setupWorkflowMockApi(page);

        await page.goto('/clients/create');
        await page.locator('#client_name').fill('E2E клиент с телефоном');
        await page.locator('#notes').fill('Проверка справочника клиентов');
        await page.locator('#ref_key_1c').fill('CLIENT-E2E');

        const phonesCard = page.locator('.ant-card').filter({ hasText: 'Телефоны' });
        await phonesCard.getByRole('button', { name: 'Добавить' }).click();

        const phoneDialog = page.getByRole('dialog', { name: 'Добавить телефон' });
        await phoneDialog.locator('#phone_number').fill('+7 701 123 4567');
        await phoneDialog.getByLabel('Основной номер').check();
        await phoneDialog.getByRole('button', { name: 'Добавить' }).click();

        await expect(phonesCard.getByText('+7 701 123 4567')).toBeVisible();
        await expect(phonesCard.getByText('Основной')).toBeVisible();

        await page.getByRole('button', { name: 'Сохранить' }).click();

        await expect
            .poll(() => db.clients.find((row) => row.client_name === 'E2E клиент с телефоном')?.client_id)
            .toBeTruthy();

        const client = db.clients.find((row) => row.client_name === 'E2E клиент с телефоном')!;
        expect(client).toMatchObject({
            is_active: true,
            notes: 'Проверка справочника клиентов',
            ref_key_1c: 'CLIENT-E2E',
        });

        await expect
            .poll(() => db.client_phones.find((row) => row.client_id === client.client_id))
            .toMatchObject({
                phone_number: '+7 701 123 4567',
                phone_type: 'mobile',
                is_primary: true,
            });
    });
});

async function createAndUpdateCatalog(page: Page, db: WorkflowMockDb, catalog: CatalogCase) {
    await page.goto(`${catalog.path}/create`);
    await catalog.fillCreate(page);
    await page.getByRole('button', { name: 'Сохранить' }).click();

    await expect
        .poll(() => db[catalog.resource].find((row) => row[catalog.nameField] === catalog.createName)?.[catalog.idField])
        .toBeTruthy();
    await settleNavigation(page);

    const created = db[catalog.resource].find((row) => row[catalog.nameField] === catalog.createName)!;
    expect(created).toMatchObject({
        [catalog.nameField]: catalog.createName,
        ...(catalog.expectedCreate || {}),
    });

    await page.goto(`${catalog.path}/edit/${created[catalog.idField]}`);
    const nameInput = page.locator(`#${catalog.nameField}`);
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toHaveValue(catalog.createName);
    await catalog.fillUpdate?.(page);
    if (!catalog.fillUpdate) {
        await page.locator(`#${catalog.nameField}`).fill(catalog.updateName);
    }
    await page.getByRole('button', { name: 'Сохранить' }).click();

    await expect
        .poll(() => db[catalog.resource].find((row) => row[catalog.idField] === created[catalog.idField]))
        .toMatchObject({
            [catalog.nameField]: catalog.updateName,
            ...(catalog.expectedUpdate || {}),
        });
    await settleNavigation(page);
}

function formItem(page: Page, label: string) {
    return page.locator('.ant-form-item').filter({ hasText: label }).first();
}

async function selectAntdOption(page: Page, formItemLocator: Locator, optionText: string) {
    await formItemLocator.locator('.ant-select').first().click();
    const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
    await dropdown.locator('.ant-select-item-option').filter({ hasText: optionText }).first().click();
}

async function settleNavigation(page: Page) {
    await page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(150);
}
