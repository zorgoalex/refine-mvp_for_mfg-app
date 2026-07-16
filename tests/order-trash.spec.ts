/**
 * Order trash E2E (mocked-local).
 *
 * Runs against the local mocked Playwright harness (webServer boots `dev:full`
 * automatically unless PLAYWRIGHT_SKIP_WEB_SERVER=true). Reuses the shared
 * workflow mock API and overrides only the backend-auth/runtime-config and the
 * `/api/v1/orders*` routes needed for soft-delete/trash coverage.
 */

import { expect, test, type Page, type Route } from '@playwright/test';
import type { OrderDto, OrderListItemDto, OrderListResponse } from '../src/api/types/orderApi.types';
import { createWorkflowMockDb, setupWorkflowMockApi } from './helpers/mockWorkflowApi';

const DEFAULT_PERMISSIONS = [
    'orders.view',
    'orders.create',
    'orders.update',
    'orders.delete',
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
];

test.describe('Order trash (mocked-local)', () => {
    test.setTimeout(90_000);

    test('order card deletes via Popconfirm and redirects to /orders', async ({ page }) => {
        await setupOrderTrashApp(page);

        await page.route(/\/api\/v1\/orders\/101(?:\?.*)?$/, async (route) => {
            const method = route.request().method();
            if (method === 'GET') {
                await fulfillJson(route, { order: buildOrderDto({ orderId: 101, orderName: '2501' }) });
                return;
            }
            if (method === 'DELETE') {
                await fulfillJson(route, { success: true, orderId: 101, requestId: 'req-delete-101' });
                return;
            }

            await fulfillJson(route, { error: { code: 'UNEXPECTED_METHOD', message: method } }, 500);
        });

        await page.route(/\/api\/v1\/orders(?:\?.*)?$/, async (route) => {
            await fulfillJson(route, createListResponse([]));
        });

        await page.goto('/orders/show/101');
        await expect(page.getByRole('button', { name: 'Удалить' })).toBeVisible({ timeout: 30_000 });

        await page.getByRole('button', { name: 'Удалить' }).click();
        const popover = page.locator('.ant-popover').filter({ hasText: 'Удалить заказ №2501?' }).last();
        await expect(popover).toBeVisible();
        await popover.getByRole('button', { name: 'Удалить' }).click();

        await expect(page).toHaveURL(/\/orders$/, { timeout: 30_000 });
        await expect(page.getByText('Заказ перемещён в корзину')).toBeVisible({ timeout: 10_000 });
    });

    test('trash page restores a deleted order and refetch removes the row', async ({ page }) => {
        await setupOrderTrashApp(page);

        // Флаг вместо счётчика вызовов: React 18 StrictMode в dev дублирует
        // effect-fetch, поэтому список должен пустеть только ПОСЛЕ restore.
        let restored = false;
        await page.route(/\/api\/v1\/orders(?:\?.*)?$/, async (route) => {
            const url = new URL(route.request().url());
            expect(url.searchParams.get('deleted')).toBe('true');
            await fulfillJson(
                route,
                createListResponse(
                    restored
                        ? []
                        : [
                              buildTrashListItem({
                                  orderId: 201,
                                  orderName: '2502',
                                  fullNumber: '2502',
                                  deletedByName: 'Иван Петров',
                              }),
                          ],
                ),
            );
        });

        await page.route(/\/api\/v1\/orders\/201\/restore$/, async (route) => {
            restored = true;
            await fulfillJson(route, {
                order: buildOrderDto({ orderId: 201, orderName: '2502' }),
                requestId: 'req-restore-201',
            });
        });

        await page.goto('/orders/trash');
        const row = page.getByRole('row', { name: /2502/ }).first();
        await expect(row).toBeVisible({ timeout: 30_000 });
        // antd thead отдаёт ячейки ролью cell, не columnheader
        await expect(page.locator('thead').getByText('Удалён', { exact: true })).toBeVisible();
        await expect(page.locator('thead').getByText('Кем', { exact: true })).toBeVisible();
        await expect(row).toContainText('Иван Петров');

        await row.getByRole('button', { name: 'Восстановить' }).click();
        const popover = page.locator('.ant-popover').filter({ hasText: 'Восстановить заказ №2502?' }).last();
        await expect(popover).toBeVisible();
        await popover.getByRole('button', { name: 'Восстановить' }).click();

        await expect(page.getByRole('row', { name: /2502/ })).toHaveCount(0, { timeout: 30_000 });
        await expect(page.getByText('Заказ восстановлен')).toBeVisible({ timeout: 10_000 });
    });

    test('restore conflict retries with suggested order name and a fresh Idempotency-Key', async ({ page }) => {
        await setupOrderTrashApp(page);

        const idempotencyKeys: string[] = [];
        const restoreBodies: string[] = [];
        let restoreCalls = 0;
        // Пустой список только ПОСЛЕ успешного restore (StrictMode double-fetch).
        let restored = false;

        await page.route(/\/api\/v1\/orders(?:\?.*)?$/, async (route) => {
            await fulfillJson(
                route,
                createListResponse(
                    restored
                        ? []
                        : [
                              buildTrashListItem({
                                  orderId: 202,
                                  orderName: '2503',
                                  fullNumber: '2503',
                                  deletedByName: 'Мария Иванова',
                                  version: 7,
                              }),
                          ],
                ),
            );
        });

        await page.route(/\/api\/v1\/orders\/202\/restore$/, async (route) => {
            restoreCalls += 1;
            idempotencyKeys.push(route.request().headers()['idempotency-key'] ?? '');
            restoreBodies.push(route.request().postData() ?? '');

            if (restoreCalls === 1) {
                await fulfillJson(
                    route,
                    {
                        error: {
                            code: 'ORDER_NAME_DUPLICATE',
                            message: 'Номер заказа уже занят',
                            requestId: 'req-restore-202-conflict',
                            details: {
                                existingOrderId: 555,
                                suggestedOrderName: '2561',
                            },
                        },
                    },
                    409,
                );
                return;
            }

            restored = true;
            await fulfillJson(route, {
                order: buildOrderDto({ orderId: 202, orderName: '2561', version: 8 }),
                requestId: 'req-restore-202-ok',
            });
        });

        await page.goto('/orders/trash');
        const row = page.getByRole('row', { name: /2503/ }).first();
        await expect(row).toBeVisible({ timeout: 30_000 });

        await row.getByRole('button', { name: 'Восстановить' }).click();
        const popover = page.locator('.ant-popover').filter({ hasText: 'Восстановить заказ №2503?' }).last();
        await popover.getByRole('button', { name: 'Восстановить' }).click();

        const confirmModal = page.getByRole('dialog').filter({ hasText: 'Восстановить как 2561' });
        await expect(confirmModal).toBeVisible({ timeout: 10_000 });
        await confirmModal.getByRole('button', { name: 'Восстановить' }).click();

        await expect(page.getByText('Заказ восстановлен как 2561')).toBeVisible({ timeout: 10_000 });
        await expect(page.getByRole('row', { name: /2503/ })).toHaveCount(0, { timeout: 30_000 });

        expect(restoreCalls).toBe(2);
        expect(restoreBodies[0]).toBe('{}');
        expect(JSON.parse(restoreBodies[1] ?? '{}')).toEqual({ orderName: '2561' });
        expect(idempotencyKeys[0]).toBeTruthy();
        expect(idempotencyKeys[1]).toBeTruthy();
        expect(idempotencyKeys[1]).not.toBe(idempotencyKeys[0]);
    });

    test('deleted order show page falls back from 404 to includeDeleted=true card', async ({ page }) => {
        await setupOrderTrashApp(page);

        await page.route(/\/api\/v1\/orders\/301(?:\?.*)?$/, async (route) => {
            const url = new URL(route.request().url());
            if (url.searchParams.get('includeDeleted') === 'true') {
                await fulfillJson(route, {
                    order: buildOrderDto({
                        orderId: 301,
                        orderName: '2504',
                        deleteFlag: true,
                        deletedAt: '2026-07-14T12:34:00.000Z',
                        deletedByName: 'Екатерина Смирнова',
                    }),
                });
                return;
            }

            await fulfillJson(
                route,
                {
                    error: {
                        code: 'ORDER_NOT_FOUND',
                        message: 'Заказ не найден',
                        requestId: 'req-order-301-missing',
                    },
                },
                404,
            );
        });

        await page.goto('/orders/show/301');

        await expect(page.getByText('Заказ удалён').first()).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText('Екатерина Смирнова')).toBeVisible();
        await expect(page.getByText('Клиент', { exact: true })).toBeVisible();
        await expect(page.getByText('Базовый клиент', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Восстановить' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Изменить' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Печать' })).toHaveCount(0);
    });

    test('navigating from deleted order A to live order B clears the deleted banner and shows normal actions', async ({ page }) => {
        await setupOrderTrashApp(page);

        await page.route(/\/api\/v1\/orders\/(?:401|402)(?:\?.*)?$/, async (route) => {
            const url = new URL(route.request().url());
            const orderId = Number(url.pathname.split('/').pop());

            if (orderId === 401) {
                if (url.searchParams.get('includeDeleted') === 'true') {
                    await fulfillJson(route, {
                        order: buildOrderDto({
                            orderId: 401,
                            orderName: '2505',
                            deleteFlag: true,
                            deletedAt: '2026-07-14T09:00:00.000Z',
                            deletedByName: 'Удаливший Пользователь',
                        }),
                    });
                    return;
                }

                await fulfillJson(
                    route,
                    {
                        error: {
                            code: 'ORDER_NOT_FOUND',
                            message: 'Заказ не найден',
                            requestId: 'req-order-401-missing',
                        },
                    },
                    404,
                );
                return;
            }

            await fulfillJson(route, {
                order: buildOrderDto({ orderId: 402, orderName: '2506', version: 4 }),
            });
        });

        await page.goto('/orders/show/401');
        await expect(page.getByText('Заказ удалён').first()).toBeVisible({ timeout: 30_000 });
        await expect(page.getByRole('button', { name: 'Восстановить' })).toBeVisible();

        await page.goto('/orders/show/402');
        await expect(page.getByText('Заказ удалён').first()).toHaveCount(0, { timeout: 30_000 });
        await expect(page.getByText('2506', { exact: true }).first()).toBeVisible();
        await expect(page.getByRole('button', { name: 'Изменить' }).first()).toBeVisible();
        await expect(page.getByRole('button', { name: 'Печать' }).first()).toBeVisible();
    });
});

async function setupOrderTrashApp(page: Page) {
    const db = createWorkflowMockDb();
    await setupWorkflowMockApi(page, db, {
        runtimeConfig: {
            backendAuth: true,
            backendPermissions: true,
            backendOrdersRead: true,
            backendOrdersWrite: true,
        },
    });

    await page.addInitScript((permissions) => {
        localStorage.setItem(
            'user',
            JSON.stringify({
                id: '1',
                user_id: 1,
                username: 'admin',
                role: 'admin',
                role_id: 1,
                permissions,
            }),
        );
    }, DEFAULT_PERMISSIONS);

    await page.unroute(/\/api\/v1\/me$/);
    await page.unroute(/\/api\/v1\/auth\/refresh$/);

    await page.route(/\/api\/v1\/me$/, async (route) => {
        await fulfillJson(route, {
            user: {
                id: '1',
                userId: 1,
                username: 'admin',
                role: 'admin',
                roleId: 1,
                permissions: DEFAULT_PERMISSIONS,
            },
        });
    });

    await page.route(/\/api\/v1\/auth\/refresh$/, async (route) => {
        await fulfillJson(route, {
            accessToken: 'mock-access-token',
            accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
            user: {
                id: '1',
                userId: 1,
                username: 'admin',
                role: 'admin',
                roleId: 1,
                permissions: DEFAULT_PERMISSIONS,
            },
        });
    });

    return db;
}

function buildOrderDto(params: {
    orderId: number;
    orderName: string;
    version?: number;
    deleteFlag?: boolean;
    deletedAt?: string | null;
    deletedByName?: string | null;
}): OrderDto {
    const version = params.version ?? 3;
    return {
        header: {
            orderId: params.orderId,
            orderName: params.orderName,
            clientId: 1,
            clientName: 'Базовый клиент',
            projectId: null,
            projectCode: null,
            orderDate: '2026-07-14',
            managerId: 1,
            priority: 100,
            orderStatusId: 1,
            orderStatusName: 'Новый',
            paymentStatusId: 1,
            paymentStatusName: 'Не оплачено',
            productionStatusId: 1,
            productionStatusName: 'Новый',
            productionStatusFromDetailsEnabled: true,
            discount: 0,
            surcharge: 0,
            notes: null,
            version,
            deleteFlag: params.deleteFlag ?? false,
            deletedAt: params.deletedAt ?? null,
            deletedByName: params.deletedByName ?? null,
        },
        details: [],
        payments: [],
        workshops: [],
        requirements: [],
        dowelingLinks: [],
        primaryGroup: null,
        groups: [],
        totals: {
            totalAmount: 15000,
            finalAmount: 15000,
            paidAmount: 0,
            debtAmount: 15000,
            partsCount: 0,
            totalArea: 0,
        },
        version,
    };
}

function buildTrashListItem(params: {
    orderId: number;
    orderName: string;
    fullNumber: string;
    deletedByName: string;
    version?: number;
}): OrderListItemDto {
    return {
        orderId: params.orderId,
        orderName: params.orderName,
        clientId: 1,
        clientName: 'Базовый клиент',
        projectId: 0,
        projectCode: '',
        fullNumber: params.fullNumber,
        orderDate: '2026-07-10',
        orderStatusId: 1,
        orderStatusName: 'Новый',
        paymentStatusId: 1,
        paymentStatusName: 'Не оплачено',
        productionStatusId: 1,
        productionStatusName: 'Новый',
        totalAmount: 15000,
        finalAmount: 15000,
        paidAmount: 0,
        debtAmount: 15000,
        partsCount: 0,
        totalArea: 0,
        priority: 100,
        updatedAt: '2026-07-14T12:00:00.000Z',
        version: params.version ?? 5,
        deletedAt: '2026-07-14T12:34:00.000Z',
        deletedBy: 77,
        deletedByName: params.deletedByName,
    };
}

function createListResponse(items: OrderListItemDto[]): OrderListResponse {
    return {
        data: items,
        pagination: {
            page: 1,
            pageSize: 20,
            total: items.length,
            totalPages: items.length === 0 ? 1 : 1,
        },
    };
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
    await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
    });
}
