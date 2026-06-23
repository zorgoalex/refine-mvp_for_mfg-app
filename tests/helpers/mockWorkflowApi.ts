import type { Page, Route } from '@playwright/test';

type Row = Record<string, any>;

export type WorkflowMockDb = Record<string, Row[]>;

export interface WorkflowMockApiOptions {
    onGraphqlQuery?: (query: string) => void;
    onGraphqlError?: (message: string, query: string) => void;
    graphqlErrorForQuery?: (query: string) => string | null | undefined;
    runtimeConfig?: false | Record<string, boolean>;
}

const AUTH_TOKEN =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwidXNlcm5hbWUiOiJhZG1pbiIsInJvbGUiOiJhZG1pbiIsImh0dHBzOi8vaGFzdXJhLmlvL2p3dC9jbGFpbXMiOnsiWC1IYXN1cmEtQWxsb3dlZC1Sb2xlcyI6WyJhZG1pbiJdLCJYLUhhc3VyYS1EZWZhdWx0LVJvbGUiOiJhZG1pbiIsIlgtSGFzdXJhLVVzZXItSWQiOiIxIn0sImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoyMDAwMDAwMDAwfQ.test';

const ID_COLUMNS: Record<string, string> = {
    app_settings: 'setting_id',
    client_phones: 'phone_id',
    clients: 'client_id',
    clients_analytics_view: 'client_id',
    doweling_orders: 'doweling_order_id',
    doweling_orders_view: 'doweling_order_id',
    edge_types: 'edge_type_id',
    employees: 'employee_id',
    film_types: 'film_type_id',
    films: 'film_id',
    material_types: 'material_type_id',
    materials: 'material_id',
    milling_types: 'milling_type_id',
    sheet_material_types: 'sheet_material_type_id',
    order_details: 'detail_id',
    order_doweling_links: 'order_doweling_link_id',
    order_resource_requirements: 'requirement_id',
    order_statuses: 'order_status_id',
    order_workshops: 'order_workshop_id',
    orders: 'order_id',
    orders_view: 'order_id',
    payment_statuses: 'payment_status_id',
    payment_types: 'type_paid_id',
    payments: 'payment_id',
    payments_view: 'payment_id',
    production_status_events: 'event_id',
    production_statuses: 'production_status_id',
    roles: 'role_id',
    requisition_statuses: 'requisition_status_id',
    resource_requirements_statuses: 'requirement_status_id',
    movements_statuses: 'movement_status_id',
    material_transaction_types: 'transaction_type_id',
    suppliers: 'supplier_id',
    transaction_direction: 'direction_type_id',
    units: 'unit_id',
    users: 'user_id',
    vendors: 'vendor_id',
    vlm_prompts: 'prompt_id',
    vlm_provider_models: 'provider_model_id',
    vlm_providers: 'provider_id',
    work_centers: 'workcenter_id',
    workshops: 'workshop_id',
};

const RESOURCES = Object.keys(ID_COLUMNS).sort((a, b) => b.length - a.length);

export function createWorkflowMockDb(): WorkflowMockDb {
    return {
        app_settings: [],
        clients: [
            {
                client_id: 1,
                client_name: 'Базовый клиент',
                is_active: true,
                notes: '',
                ref_key_1c: 'client-base',
            },
        ],
        client_phones: [
            {
                phone_id: 1,
                client_id: 1,
                phone_number: '+7 701 000 0001',
                phone_type: 'mobile',
                is_primary: true,
            },
        ],
        clients_analytics_view: [],
        doweling_orders: [],
        doweling_orders_view: [],
        edge_types: [
            {
                edge_type_id: 1,
                edge_type_name: 'р-1',
                sort_order: 10,
                description: '',
                is_active: true,
                ref_key_1c: 'edge-r1',
            },
        ],
        employees: [
            {
                employee_id: 1,
                full_name: 'Администратор Тестов',
                position: 'Менеджер',
                is_active: true,
                ref_key_1c: 'employee-admin',
            },
            {
                employee_id: 2,
                full_name: 'Мастер Тестов',
                position: 'Мастер',
                is_active: true,
                ref_key_1c: 'employee-master',
            },
        ],
        film_types: [
            {
                film_type_id: 1,
                film_type_name: 'ПВХ',
                is_active: true,
                ref_key_1c: 'film-type-pvc',
            },
            {
                film_type_id: 2,
                film_type_name: 'PET',
                is_active: true,
                ref_key_1c: 'film-type-pet',
            },
        ],
        films: [
            {
                film_id: 1,
                film_name: 'Белая матовая',
                film_type_id: 1,
                vendor_id: 1,
                film_texture: false,
                is_active: true,
            },
        ],
        material_types: [
            {
                material_type_id: 1,
                material_type_name: 'МДФ',
                sort_order: 10,
                is_active: true,
                ref_key_1c: 'material-type-mdf',
            },
            {
                material_type_id: 2,
                material_type_name: 'ЛДСП',
                sort_order: 20,
                is_active: true,
                ref_key_1c: 'material-type-ldsp',
            },
        ],
        materials: [
            {
                material_id: 1,
                material_name: 'МДФ 16 мм',
                unit_id: 1,
                material_type_id: 1,
                vendor_id: 1,
                default_supplier_id: 1,
                description: '',
                is_active: true,
                unit: {
                    unit_id: 1,
                    unit_code: 'sqm',
                    unit_name: 'Квадратный метр',
                    unit_symbol: 'м²',
                },
                material_type: {
                    material_type_id: 1,
                    material_type_name: 'МДФ',
                },
                vendor: {
                    vendor_id: 1,
                    vendor_name: 'Тестовый производитель',
                },
                default_supplier: {
                    supplier_id: 1,
                    supplier_name: 'Тестовый поставщик',
                },
            },
        ],
        milling_types: [
            {
                milling_type_id: 1,
                milling_type_name: 'Модерн',
                cost_per_sqm: 10000,
                sort_order: 10,
                description: '',
                is_active: true,
            },
        ],
        order_details: [],
        order_doweling_links: [],
        order_resource_requirements: [],
        material_transaction_types: [],
        order_statuses: [
            {
                order_status_id: 1,
                order_status_name: 'Новый',
                sort_order: 10,
                color: 'blue',
                is_active: true,
            },
        ],
        order_workshops: [],
        orders: [],
        orders_view: [],
        payment_statuses: [
            {
                payment_status_id: 1,
                payment_status_name: 'Не оплачено',
                sort_order: 10,
                color: 'red',
                is_active: true,
            },
            {
                payment_status_id: 2,
                payment_status_name: 'Частично оплачено',
                sort_order: 20,
                color: 'orange',
                is_active: true,
            },
            {
                payment_status_id: 3,
                payment_status_name: 'Оплачено',
                sort_order: 30,
                color: 'green',
                is_active: true,
            },
        ],
        payment_types: [
            {
                type_paid_id: 1,
                type_paid_name: 'Наличные',
                sort_order: 10,
                is_active: true,
            },
        ],
        payments: [],
        payments_view: [],
        production_status_events: [],
        production_statuses: [
            {
                production_status_id: 1,
                production_status_code: 'new',
                production_status_name: 'Новый',
                sort_order: 10,
                color: 'blue',
                is_active: true,
            },
            {
                production_status_id: 2,
                production_status_code: 'in_progress',
                production_status_name: 'В работе',
                sort_order: 20,
                color: 'orange',
                is_active: true,
            },
            {
                production_status_id: 3,
                production_status_code: 'done',
                production_status_name: 'Готово',
                sort_order: 30,
                color: 'green',
                is_active: true,
            },
        ],
        requisition_statuses: [
            {
                requisition_status_id: 1,
                requisition_status_name: 'Новая заявка',
                sort_order: 10,
                description: 'Базовый статус заявки',
                is_active: true,
            },
        ],
        movements_statuses: [
            {
                movement_status_id: 1,
                movement_status_code: 'draft',
                movement_status_name: 'Черновик',
                sort_order: 10,
                description: 'Базовый статус движения',
                is_active: true,
            },
        ],
        resource_requirements_statuses: [],
        roles: [
            {
                role_id: 1,
                role_name: 'admin',
                role_description: 'Administrator',
                is_active: true,
                ref_key_1c: 'role-admin',
            },
        ],
        suppliers: [
            {
                supplier_id: 1,
                supplier_name: 'Тестовый поставщик',
                is_active: true,
                ref_key_1c: 'supplier-main',
            },
            {
                supplier_id: 2,
                supplier_name: 'Резервный поставщик',
                is_active: true,
                ref_key_1c: 'supplier-reserve',
            },
        ],
        transaction_direction: [
            {
                direction_type_id: 1,
                direction_code: 'IN',
                direction_name: 'Приход',
                description: '',
                is_active: true,
            },
            {
                direction_type_id: 2,
                direction_code: 'OUT',
                direction_name: 'Расход',
                description: '',
                is_active: true,
            },
        ],
        units: [
            {
                unit_id: 1,
                unit_code: 'sqm',
                unit_name: 'Квадратный метр',
                unit_symbol: 'м²',
                decimals: 2,
                ref_key_1c: 'unit-sqm',
            },
            {
                unit_id: 2,
                unit_code: 'pcs',
                unit_name: 'Штука',
                unit_symbol: 'шт',
                decimals: 0,
                ref_key_1c: 'unit-pcs',
            },
        ],
        users: [
            {
                user_id: 1,
                username: 'admin',
                email: 'admin@example.invalid',
                full_name: 'Администратор Тестов',
                role_id: 1,
                role: {
                    role_id: 1,
                    role_name: 'admin',
                },
                employee_id: 1,
                employee: {
                    employee_id: 1,
                    full_name: 'Администратор Тестов',
                },
                is_active: true,
                last_login_at: null,
                ref_key_1c: 'user-admin',
                created_at: '2026-05-10T00:00:00+05:00',
                updated_at: '2026-05-10T00:00:00+05:00',
            },
        ],
        vendors: [
            {
                vendor_id: 1,
                vendor_name: 'Тестовый производитель',
                material_type_id: 1,
                is_active: true,
                ref_key_1c: 'vendor-main',
            },
            {
                vendor_id: 2,
                vendor_name: 'Второй производитель',
                material_type_id: 2,
                is_active: true,
                ref_key_1c: 'vendor-second',
            },
        ],
        vlm_prompts: [],
        vlm_provider_models: [],
        vlm_providers: [],
        workshops: [
            {
                workshop_id: 1,
                workshop_name: 'Основной цех',
                address: 'Тестовый адрес',
                responsible_employee_id: 1,
                is_active: true,
                ref_key_1c: 'workshop-main',
            },
            {
                workshop_id: 2,
                workshop_name: 'Финишный цех',
                address: 'Финишный адрес',
                responsible_employee_id: 2,
                is_active: true,
                ref_key_1c: 'workshop-finish',
            },
        ],
        work_centers: [],
        // Variant B: sheet_material_types is now the sole order-material reference.
        // Seeded with one cuttable type so the detail picker has an option.
        sheet_material_types: [
            {
                sheet_material_type_id: 1,
                name: 'МДФ 16 мм (Лист)',
                material_type_id: 1,
                unit_id: 1,
                thickness_mm: 16,
                width_mm: 2800,
                height_mm: 2070,
                is_active: true,
                is_cuttable: true,
                ref_key_1c: 'smt-mdf-16',
            },
        ],
    };
}

export async function setupWorkflowMockApi(
    page: Page,
    db = createWorkflowMockDb(),
    options: WorkflowMockApiOptions = {},
): Promise<WorkflowMockDb> {
    await page.addInitScript((token) => {
        localStorage.clear();
        localStorage.setItem('access_token', token);
        localStorage.setItem('refresh_token', 'mock-refresh-token');
        localStorage.setItem(
            'user',
            JSON.stringify({
                id: '1',
                user_id: 1,
                username: 'admin',
                role: 'admin',
                role_id: 1,
                // Variant B: include permissions so can('sheet_materials.view') returns true
                // even when backendAuth=false (legacy localStorage path). Without permissions
                // here, useSheetMaterialOptions.enabled stays false and the picker has no
                // options in mocked tests.
                permissions: [
                    'orders.view',
                    'orders.create',
                    'orders.update',
                    'orders.export',
                    'payments.view',
                    'payments.create',
                    'payments.update',
                    'payments.delete',
                    'clients.view',
                    'clients.create',
                    'clients.update',
                    'production.actions',
                    'settings.view',
                    'sheet_materials.view',
                    'sheet_materials.manage',
                ],
            }),
        );
    }, AUTH_TOKEN);

    await page.route(/\/api\/refresh$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                accessToken: AUTH_TOKEN,
                refreshToken: 'mock-refresh-token',
            }),
        });
    });

    await page.route(/\/api\/v1\/auth\/refresh$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                accessToken: AUTH_TOKEN,
                accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
                user: {
                    id: '1',
                    userId: 1,
                    username: 'admin',
                    role: 'admin',
                    roleId: 1,
                    permissions: [
                        'orders.view',
                        'orders.create',
                        'orders.update',
                        'orders.export',
                        'payments.view',
                        'payments.create',
                        'payments.update',
                        'payments.delete',
                        'clients.view',
                        'clients.create',
                        'clients.update',
                        'production.actions',
                        'settings.view',
                        // Variant B: admin has sheet_materials.view so the sheet picker renders.
                        'sheet_materials.view',
                        'sheet_materials.manage',
                    ],
                },
            }),
        });
    });

    await page.route(/\/api\/v1\/me$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                user: {
                    id: '1',
                    userId: 1,
                    username: 'admin',
                    role: 'admin',
                    roleId: 1,
                    permissions: [
                        'orders.view',
                        'orders.create',
                        'orders.update',
                        'orders.export',
                        'payments.view',
                        'payments.create',
                        'payments.update',
                        'payments.delete',
                        'clients.view',
                        'clients.create',
                        'clients.update',
                        'production.actions',
                        'settings.view',
                        // Variant B: admin has sheet_materials.view so the sheet picker renders.
                        'sheet_materials.view',
                        'sheet_materials.manage',
                    ],
                },
            }),
        });
    });

    if (options.runtimeConfig !== false) {
        await page.route(/\/runtime-config\.json$/, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    apiUrl: '',
                    features: {
                        backendAuth: process.env.VITE_USE_BACKEND_AUTH === 'true',
                        backendPermissions: process.env.VITE_USE_BACKEND_PERMISSIONS === 'true',
                        backendUsers: process.env.VITE_USE_BACKEND_USERS === 'true',
                        backendOrdersRead:
                            process.env.VITE_USE_BACKEND_ORDERS_READ === 'true' ||
                            process.env.VITE_USE_BACKEND_ORDERS === 'true',
                        // Variant B: orders write backend is on by default in mocks (sheet picker requires it).
                        backendOrdersWrite: true,
                        backendOrderExport: process.env.VITE_USE_BACKEND_ORDER_EXPORT === 'true',
                        backendVlm: process.env.VITE_USE_BACKEND_VLM === 'true',
                        backendPayments: process.env.VITE_USE_BACKEND_PAYMENTS === 'true',
                        backendProductionActions:
                            process.env.VITE_USE_BACKEND_PRODUCTION_ACTIONS === 'true',
                        backendClientPhones: process.env.VITE_USE_BACKEND_CLIENT_PHONES === 'true',
                        backendDeadlines: false,
                        backendReferences: false,
                        enableLegacyHasura: true,
                        // Variant B: enable sheet picker by default in mocked tests.
                        // The sheet picker requires backendOrdersWrite + sheetMaterialsReads.
                        // Tests that need the legacy (pre-034) path must explicitly pass
                        // { sheetMaterialsReads: false, backendOrdersWrite: false }.
                        sheetMaterialsReads: true,
                        ...options.runtimeConfig,
                    },
                }),
            });
        });
    }

    await page.route(/\/api\/order-export-to-drive$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                success: true,
                fileName: 'mock-order.xlsx',
                folder: 'mock-folder',
                xlsxUrl: 'https://example.test/mock-order.xlsx',
            }),
        });
    });

    await page.route(/\/api\/v1\/orders\/form-data$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(createOrderFormDataResponse(db)),
        });
    });

    // Variant B: backend orders write (POST /api/v1/orders, PUT /api/v1/orders/:id).
    // When backendOrdersWrite=true the order form sends the full command to REST, not GraphQL.
    // The mock creates records in db (matching the flat column names the test assertions expect)
    // and returns a minimal OrderDto so mapOrderDtoToFormValues can hydrate the store.
    await page.route(/\/api\/v1\/orders(?:\/\d+)?$/, async (route) => {
        const method = route.request().method();
        if (method !== 'POST' && method !== 'PUT') {
            await route.continue();
            return;
        }

        try {
            const body = JSON.parse(route.request().postData() || '{}');
            const header = body.header ?? {};
            const details: any[] = body.details ?? [];
            const payments: any[] = body.payments ?? [];

            const orderId = method === 'PUT'
                ? Number(route.request().url().match(/\/orders\/(\d+)$/)?.[1] ?? 0)
                : nextId(db, 'orders');

            const orderDate = header.orderDate ?? new Date().toISOString().slice(0, 10);

            // Upsert order
            const existingIndex = method === 'PUT'
                ? ensureRows(db, 'orders').findIndex((o) => o.order_id === orderId)
                : -1;

            // Compute totals from details
            const totalAmount = details.reduce((sum: number, d: any) => sum + (d.detailCost ?? 0), 0);
            const paidAmount = payments.reduce((sum: number, p: any) => sum + (p.amount ?? 0), 0);
            const partsCount = details.reduce((sum: number, d: any) => sum + (d.quantity ?? 0), 0);
            const totalArea = details.reduce((sum: number, d: any) => {
                const h = (d.height ?? 0) / 1000;
                const w = (d.width ?? 0) / 1000;
                return sum + h * w * (d.quantity ?? 0);
            }, 0);

            const orderRow: Row = {
                order_id: orderId,
                order_name: header.orderName ?? '',
                client_id: header.clientId ?? null,
                order_date: orderDate,
                order_status_id: header.orderStatusId ?? 1,
                payment_status_id: header.paymentStatusId ?? 1,
                production_status_id: header.productionStatusId ?? 1,
                priority: header.priority ?? 100,
                discount: header.discount ?? 0,
                surcharge: header.surcharge ?? 0,
                manager_id: header.managerId ?? null,
                material_id: header.materialId ?? null,
                sheet_material_type_id: header.sheetMaterialTypeId ?? null,
                milling_type_id: header.millingTypeId ?? null,
                edge_type_id: header.edgeTypeId ?? null,
                film_id: header.filmId ?? null,
                notes: header.notes ?? null,
                total_amount: totalAmount,
                final_amount: totalAmount,
                paid_amount: paidAmount,
                parts_count: partsCount,
                total_area: Math.round(totalArea * 1000) / 1000,
                delete_flag: false,
                version: 1,
            };

            if (existingIndex >= 0) {
                ensureRows(db, 'orders')[existingIndex] = orderRow;
            } else {
                ensureRows(db, 'orders').push(orderRow);
            }

            // Upsert details
            const existingDetailIds = new Set(
                ensureRows(db, 'order_details')
                    .filter((d: Row) => d.order_id === orderId)
                    .map((d: Row) => d.detail_id),
            );
            for (const d of details) {
                const detailId = d.id ?? nextId(db, 'order_details');
                const height = d.height ?? 0;
                const width = d.width ?? 0;
                const quantity = d.quantity ?? 0;
                const area = Math.round((height / 1000) * (width / 1000) * quantity * 1000) / 1000;
                const detailRow: Row = {
                    detail_id: detailId,
                    order_id: orderId,
                    detail_number: d.detailNumber ?? 1,
                    detail_name: d.detailName ?? null,
                    height,
                    width,
                    quantity,
                    area,
                    material_id: d.materialId ?? null,
                    sheet_material_type_id: d.sheetMaterialTypeId ?? null,
                    milling_type_id: d.millingTypeId ?? 1,
                    edge_type_id: d.edgeTypeId ?? 1,
                    film_id: d.filmId ?? null,
                    milling_cost_per_sqm: d.millingCostPerSqm ?? null,
                    detail_cost: d.detailCost ?? 0,
                    delete_flag: false,
                    version: 1,
                };
                const idx = ensureRows(db, 'order_details').findIndex((r: Row) => r.detail_id === detailId);
                if (idx >= 0) {
                    ensureRows(db, 'order_details')[idx] = detailRow;
                } else {
                    ensureRows(db, 'order_details').push(detailRow);
                }
                existingDetailIds.delete(detailId);
            }
            // Remove deleted details (not in the new list)
            if (existingDetailIds.size > 0) {
                db.order_details = ensureRows(db, 'order_details').filter(
                    (d: Row) => !existingDetailIds.has(d.detail_id),
                );
            }

            // Upsert payments
            const existingPaymentIds = new Set(
                ensureRows(db, 'payments')
                    .filter((p: Row) => p.order_id === orderId)
                    .map((p: Row) => p.payment_id),
            );
            for (const p of payments) {
                const paymentId = p.id ?? nextId(db, 'payments');
                const paymentRow: Row = {
                    payment_id: paymentId,
                    order_id: orderId,
                    type_paid_id: p.typePaidId ?? 1,
                    amount: p.amount ?? 0,
                    payment_date: p.paymentDate ?? orderDate,
                    notes: p.notes ?? null,
                };
                const idx = ensureRows(db, 'payments').findIndex((r: Row) => r.payment_id === paymentId);
                if (idx >= 0) {
                    ensureRows(db, 'payments')[idx] = paymentRow;
                } else {
                    ensureRows(db, 'payments').push(paymentRow);
                }
                existingPaymentIds.delete(paymentId);
            }
            if (existingPaymentIds.size > 0) {
                db.payments = ensureRows(db, 'payments').filter(
                    (p: Row) => !existingPaymentIds.has(p.payment_id),
                );
            }

            // Build the OrderDto response
            const orderDto = {
                header: {
                    orderId,
                    orderName: orderRow.order_name,
                    clientId: orderRow.client_id,
                    clientName: getRows(db, 'clients').find((c) => c.client_id === orderRow.client_id)?.client_name ?? null,
                    orderDate: orderRow.order_date,
                    priority: orderRow.priority,
                    orderStatusId: orderRow.order_status_id,
                    paymentStatusId: orderRow.payment_status_id,
                    productionStatusId: orderRow.production_status_id,
                    productionStatusFromDetailsEnabled: true,
                    discount: orderRow.discount,
                    surcharge: orderRow.surcharge,
                    managerId: orderRow.manager_id,
                    materialId: orderRow.material_id,
                    sheetMaterialTypeId: orderRow.sheet_material_type_id,
                    millingTypeId: orderRow.milling_type_id,
                    edgeTypeId: orderRow.edge_type_id,
                    filmId: orderRow.film_id,
                    notes: orderRow.notes,
                    version: orderRow.version,
                },
                details: ensureRows(db, 'order_details')
                    .filter((d: Row) => d.order_id === orderId)
                    .map((d: Row) => ({
                        id: d.detail_id,
                        orderId: d.order_id,
                        detailNumber: d.detail_number,
                        detailName: d.detail_name,
                        height: d.height,
                        width: d.width,
                        quantity: d.quantity,
                        area: d.area,
                        materialId: d.material_id,
                        sheetMaterialTypeId: d.sheet_material_type_id,
                        millingTypeId: d.milling_type_id,
                        edgeTypeId: d.edge_type_id,
                        filmId: d.film_id,
                        millingCostPerSqm: d.milling_cost_per_sqm,
                        detailCost: d.detail_cost,
                        priority: 100,
                    })),
                payments: ensureRows(db, 'payments')
                    .filter((p: Row) => p.order_id === orderId)
                    .map((p: Row) => ({
                        id: p.payment_id,
                        orderId: p.order_id,
                        typePaidId: p.type_paid_id,
                        amount: p.amount,
                        paymentDate: p.payment_date,
                        notes: p.notes,
                    })),
                workshops: [],
                requirements: [],
                dowelingLinks: [],
                primaryProject: null,
                projects: [],
                totals: {
                    totalAmount: orderRow.total_amount,
                    finalAmount: orderRow.final_amount,
                    paidAmount: orderRow.paid_amount,
                    partsCount: orderRow.parts_count,
                    totalArea: orderRow.total_area,
                    debtAmount: Math.max(0, orderRow.final_amount - orderRow.paid_amount),
                },
                version: orderRow.version,
            };

            await route.fulfill({
                status: method === 'POST' ? 201 : 200,
                contentType: 'application/json',
                body: JSON.stringify({ order: orderDto }),
            });
        } catch (error) {
            await route.fulfill({
                status: 500,
                contentType: 'application/json',
                body: JSON.stringify({ message: `Mock order save error: ${error}` }),
            });
        }
    });

    await page.route(/\/(v1\/graphql|undefined)$/, async (route) => {
        await fulfillGraphql(route, db, options);
    });

    return db;
}

function createOrderFormDataResponse(db: WorkflowMockDb) {
    return {
        clients: getRows(db, 'clients').map((row) => toIdName(row, 'client_id', 'client_name')),
        materials: getRows(db, 'materials').map((row) => ({
            ...toIdName(row, 'material_id', 'material_name'),
            unitId: toNullableNumber(row.unit_id),
        })),
        millingTypes: getRows(db, 'milling_types').map((row) => ({
            ...toIdName(row, 'milling_type_id', 'milling_type_name'),
            costPerSqm: toNullableNumber(row.cost_per_sqm),
        })),
        edgeTypes: getRows(db, 'edge_types').map((row) =>
            toIdName(row, 'edge_type_id', 'edge_type_name'),
        ),
        films: getRows(db, 'films').map((row) => toIdName(row, 'film_id', 'film_name')),
        orderStatuses: getRows(db, 'order_statuses').map((row) =>
            toStatusLookup(row, 'order_status_id', 'order_status_name'),
        ),
        paymentStatuses: getRows(db, 'payment_statuses').map((row) =>
            toStatusLookup(row, 'payment_status_id', 'payment_status_name'),
        ),
        paymentTypes: getRows(db, 'payment_types').map((row) =>
            toIdName(row, 'type_paid_id', 'type_paid_name'),
        ),
        productionStatuses: getRows(db, 'production_statuses').map((row) =>
            toStatusLookup(row, 'production_status_id', 'production_status_name'),
        ),
        workshops: getRows(db, 'workshops').map((row) =>
            toIdName(row, 'workshop_id', 'workshop_name'),
        ),
        employees: getRows(db, 'employees').map((row) => ({
            id: Number(row.employee_id),
            fullName: String(row.full_name),
        })),
        units: getRows(db, 'units').map((row) => ({
            id: Number(row.unit_id),
            code: String(row.unit_code),
            name: String(row.unit_name),
            symbol: row.unit_symbol === undefined || row.unit_symbol === null ? undefined : String(row.unit_symbol),
        })),
        // Variant B: sheetMaterialTypes replaces the legacy materials picker for order details.
        sheetMaterialTypes: getRows(db, 'sheet_material_types').map((row) => ({
            id: Number(row.sheet_material_type_id),
            name: String(row.name),
            widthMm: row.width_mm != null ? Number(row.width_mm) : null,
            heightMm: row.height_mm != null ? Number(row.height_mm) : null,
            isActive: Boolean(row.is_active),
            isCuttable: row.is_cuttable != null ? Boolean(row.is_cuttable) : true,
        })),
    };
}

function toIdName(row: Row, idField: string, nameField: string) {
    return {
        id: Number(row[idField]),
        name: String(row[nameField]),
    };
}

function toStatusLookup(row: Row, idField: string, nameField: string) {
    return {
        ...toIdName(row, idField, nameField),
        code: row.production_status_code ?? row.order_status_code ?? row.payment_status_code ?? null,
        color: row.color ?? null,
    };
}

function toNullableNumber(value: unknown) {
    return value === undefined || value === null ? null : Number(value);
}

async function fulfillGraphql(route: Route, db: WorkflowMockDb, options: WorkflowMockApiOptions) {
    const body = JSON.parse(route.request().postData() || '{}');
    const query = String(body.query || '');

    try {
        options.onGraphqlQuery?.(query);
        const forcedError = options.graphqlErrorForQuery?.(query);
        if (forcedError) {
            throw new Error(forcedError);
        }

        const data = handleGraphql(query, db);
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ data }),
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Mock GraphQL error';
        options.onGraphqlError?.(message, query);
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                errors: [
                    {
                        message,
                    },
                ],
            }),
        });
    }
}

function handleGraphql(query: string, db: WorkflowMockDb) {
    if (/\binsert_[a-z_]+_one\s*\(/.test(query)) {
        return handleInsert(query, db);
    }
    if (/\bupdate_[a-z_]+_by_pk\s*\(/.test(query)) {
        return handleUpdate(query, db);
    }
    if (/\bdelete_[a-z_]+_by_pk\s*\(/.test(query)) {
        return handleDelete(query, db);
    }

    const data: Record<string, any> = {};
    for (const resource of RESOURCES) {
        if (new RegExp(`\\b${resource}_aggregate\\b`).test(query)) {
            data[`${resource}_aggregate`] = {
                aggregate: { count: applyQuery(getRows(db, resource), query).length },
            };
        }

        if (new RegExp(`\\b${resource}\\s*(?:\\(|\\{)`).test(query)) {
            data[resource] = applyQuery(getRows(db, resource), query);
        }
    }

    return data;
}

function handleInsert(query: string, db: WorkflowMockDb) {
    const [, resource] = query.match(/insert_([a-z_]+)_one\s*\(/) || [];
    if (!resource) throw new Error(`Cannot parse insert resource: ${query}`);

    const record = {
        ...parseLiteral(extractBalancedLiteral(query, 'object:')),
        [idColumn(resource)]: nextId(db, resource),
    };

    if (resource === 'orders') {
        record.order_doweling_links = [];
        record.version = record.version ?? 0;
    }
    if (resource === 'order_details') {
        record.delete_flag = record.delete_flag ?? false;
        record.version = record.version ?? 0;
    }

    ensureRows(db, resource).push(record);

    return {
        [`insert_${resource}_one`]: getRows(db, resource).find(
            (row) => row[idColumn(resource)] === record[idColumn(resource)],
        ),
    };
}

function handleUpdate(query: string, db: WorkflowMockDb) {
    const [, resource] = query.match(/update_([a-z_]+)_by_pk\s*\(/) || [];
    if (!resource) throw new Error(`Cannot parse update resource: ${query}`);

    const idCol = idColumn(resource);
    const idMatch = query.match(new RegExp(`${idCol}\\s*:\\s*([^,}\\)\\s]+)`));
    const id = parseScalar(idMatch?.[1] || '');
    const patch = parseLiteral(extractBalancedLiteral(query, '_set:'));

    const rows = ensureRows(db, resource);
    const index = rows.findIndex((row) => sameId(row[idCol], id));
    if (index === -1) {
        throw new Error(`Cannot update missing ${resource}#${id}`);
    }

    rows[index] = { ...rows[index], ...patch };

    return {
        [`update_${resource}_by_pk`]: getRows(db, resource).find((row) => sameId(row[idCol], id)),
    };
}

function handleDelete(query: string, db: WorkflowMockDb) {
    const [, resource] = query.match(/delete_([a-z_]+)_by_pk\s*\(/) || [];
    if (!resource) throw new Error(`Cannot parse delete resource: ${query}`);

    const idCol = idColumn(resource);
    const idMatch = query.match(new RegExp(`${idCol}\\s*:\\s*([^,}\\)\\s]+)`));
    const id = parseScalar(idMatch?.[1] || '');
    const rows = ensureRows(db, resource);
    const index = rows.findIndex((row) => sameId(row[idCol], id));
    const [deleted] = index >= 0 ? rows.splice(index, 1) : [{ [idCol]: id }];

    return {
        [`delete_${resource}_by_pk`]: { [idCol]: deleted[idCol] },
    };
}

function applyQuery(rows: Row[], query: string): Row[] {
    let result = [...rows];

    for (const filter of parseFilters(query)) {
        result = result.filter((row) => matchesFilter(row, filter));
    }

    const sorter = parseSorter(query);
    if (sorter) {
        result.sort((a, b) => {
            const left = a[sorter.field];
            const right = b[sorter.field];
            if (left === right) return 0;
            if (left === undefined || left === null) return 1;
            if (right === undefined || right === null) return -1;
            return (left > right ? 1 : -1) * (sorter.order === 'desc' ? -1 : 1);
        });
    }

    const offset = Number(query.match(/offset:\s*(\d+)/)?.[1] || 0);
    const limitMatch = query.match(/limit:\s*(\d+)/);
    if (limitMatch) {
        return result.slice(offset, offset + Number(limitMatch[1]));
    }

    return offset > 0 ? result.slice(offset) : result;
}

function parseFilters(query: string) {
    return [...query.matchAll(/\{\s*([A-Za-z_][\w]*)\s*:\s*\{\s*_(eq|neq|gt|gte|lt|lte|in|ilike)\s*:\s*(\[[^\]]*\]|"[^"]*"|true|false|null|-?\d+(?:\.\d+)?)\s*\}\s*\}/g)].map(
        (match) => ({
            field: match[1],
            operator: match[2],
            value: parseScalar(match[3]),
        }),
    );
}

function matchesFilter(row: Row, filter: { field: string; operator: string; value: any }) {
    if (!(filter.field in row)) {
        return true;
    }

    const value = row[filter.field];
    switch (filter.operator) {
        case 'eq':
            return isIdField(filter.field) ? sameId(value, filter.value) : value === filter.value;
        case 'neq':
            return isIdField(filter.field) ? !sameId(value, filter.value) : value !== filter.value;
        case 'gt':
            return value > filter.value;
        case 'gte':
            return value >= filter.value;
        case 'lt':
            return value < filter.value;
        case 'lte':
            return value <= filter.value;
        case 'in':
            return (
                Array.isArray(filter.value) &&
                filter.value.some((item) => (isIdField(filter.field) ? sameId(value, item) : item === value))
            );
        case 'ilike': {
            const needle = String(filter.value).replaceAll('%', '').toLowerCase();
            return String(value || '').toLowerCase().includes(needle);
        }
        default:
            return true;
    }
}

function parseSorter(query: string): { field: string; order: 'asc' | 'desc' } | null {
    const match = query.match(/order_by:\s*\[\s*\{\s*([A-Za-z_][\w]*)\s*:\s*(asc|desc)\s*\}/);
    return match ? { field: match[1], order: match[2] as 'asc' | 'desc' } : null;
}

function getRows(db: WorkflowMockDb, resource: string): Row[] {
    if (resource !== 'orders_view') {
        return ensureRows(db, resource);
    }

    const generated = ensureRows(db, 'orders').map((order) => buildOrderView(order, db));
    const generatedIds = new Set(generated.map((row) => row.order_id));
    const explicit = ensureRows(db, 'orders_view').filter((row) => !generatedIds.has(row.order_id));
    return [...generated, ...explicit];
}

function buildOrderView(order: Row, db: WorkflowMockDb): Row {
    const client = db.clients.find((row) => row.client_id === order.client_id);
    const orderStatus = db.order_statuses.find((row) => row.order_status_id === order.order_status_id);
    const paymentStatus = db.payment_statuses.find((row) => row.payment_status_id === order.payment_status_id);
    const productionStatus = db.production_statuses.find(
        (row) => row.production_status_id === order.production_status_id,
    );

    return {
        ...order,
        client_name: client?.client_name || '',
        order_status_name: orderStatus?.order_status_name || '',
        payment_status_name: paymentStatus?.payment_status_name || '',
        production_status_name: productionStatus?.production_status_name || '',
        order_ref_key_1c: order.ref_key_1c || null,
        client_ref_key_1c: client?.ref_key_1c || null,
    };
}

function ensureRows(db: WorkflowMockDb, resource: string): Row[] {
    db[resource] ||= [];
    return db[resource];
}

function nextId(db: WorkflowMockDb, resource: string) {
    const idCol = idColumn(resource);
    const currentMax = ensureRows(db, resource).reduce((max, row) => Math.max(max, Number(row[idCol] || 0)), 0);
    return currentMax + 1;
}

function idColumn(resource: string) {
    return ID_COLUMNS[resource] || 'id';
}

function extractBalancedLiteral(query: string, marker: string) {
    const markerIndex = query.indexOf(marker);
    if (markerIndex === -1) throw new Error(`Cannot find literal marker ${marker}`);

    const start = query.indexOf('{', markerIndex);
    if (start === -1) throw new Error(`Cannot find literal start after ${marker}`);

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < query.length; index += 1) {
        const char = query[index];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
        } else if (char === '{') {
            depth += 1;
        } else if (char === '}') {
            depth -= 1;
            if (depth === 0) {
                return query.slice(start, index + 1);
            }
        }
    }

    throw new Error(`Cannot parse balanced literal after ${marker}`);
}

function parseLiteral(literal: string): Row {
    return Function(`"use strict"; return (${literal});`)();
}

function parseScalar(value: string): any {
    const trimmed = value.trim();
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (trimmed === 'null') return null;
    if (trimmed.startsWith('[')) {
        return trimmed
            .slice(1, -1)
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
            .map(parseScalar);
    }
    if (trimmed.startsWith('"')) return JSON.parse(trimmed);
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
    return trimmed;
}

function sameId(left: any, right: any) {
    return String(left) === String(right);
}

function isIdField(field: string) {
    return field === 'id' || field.endsWith('_id');
}
