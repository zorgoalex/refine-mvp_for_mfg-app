import { expect, test, type Page, type Route } from '@playwright/test';
import { createWorkflowMockDb, setupWorkflowMockApi, type WorkflowMockDb } from './helpers/mockWorkflowApi';

const backendOrderWritesEnabled = process.env.VITE_USE_BACKEND_ORDERS_WRITE === 'true';

test.describe('Order save backend command boundary', () => {
    test.skip(!backendOrderWritesEnabled, 'Run with VITE_USE_BACKEND_ORDERS_WRITE=true');
    test.setTimeout(90000);

    test('saves operational child workflow data through one backend order command without child GraphQL mutations', async ({ page }) => {
        const db = createWorkflowMockDb();
        seedOrderAggregate(db);

        await page.route(/\/runtime-config\.json$/, async (route) => {
            await fulfillJson(route, {
                apiUrl: '',
                features: {
                    backendOrdersRead: true,
                    backendOrdersWrite: true,
                },
            });
        });

        const forbiddenGraphqlMutations: string[] = [];
        await setupWorkflowMockApi(page, db, {
            runtimeConfig: false,
            onGraphqlQuery: (query) => {
                if (/\b(?:insert|update|delete)_(?:order_workshops|order_resource_requirements|order_doweling_links|doweling_orders)(?:_by_pk|_one)?\b/.test(query)) {
                    forbiddenGraphqlMutations.push(query);
                }
            },
        });
        const api = await setupOrderSaveBackendMock(page, db);

        await page.goto('/orders/edit/15');
        await expect(page.getByText('Backend command boundary order', { exact: true })).toBeVisible({ timeout: 30000 });
        await deleteWorkflowChildrenThroughStore(page);
        await page.getByRole('tab', { name: 'Основная информация' }).click();
        await page.getByPlaceholder('Введите название заказа').fill('Backend command boundary order saved');
        await page.getByRole('button', { name: /Сохранить/ }).click();

        await expect.poll(() => api.updateBodies.length).toBe(1);
        await page.waitForTimeout(500);
        expect(api.updateBodies).toHaveLength(1);
        expect(api.updateBodies[0]).toMatchObject({
            header: expect.objectContaining({
                orderName: 'Backend command boundary order saved',
            }),
            workshops: [
                expect.objectContaining({
                    id: 81,
                    workshopId: 1,
                    productionStatusId: 1,
                }),
            ],
            requirements: [
                expect.objectContaining({
                    id: 91,
                    resourceType: 'material',
                    materialId: 1,
                    requiredQuantity: 2,
                }),
            ],
            dowelingLinks: [
                expect.objectContaining({
                    id: 101,
                    dowelingOrderId: 44,
                    designEngineerId: 1,
                }),
            ],
            deleted: expect.objectContaining({
                workshopIds: [82],
                requirementIds: [92],
                dowelingLinkIds: [102],
            }),
        });
        expect(forbiddenGraphqlMutations).toEqual([]);
    });
});

function seedOrderAggregate(db: WorkflowMockDb) {
    db.orders.push({
        order_id: 15,
        order_name: 'Backend command boundary order',
        client_id: 1,
        order_status_id: 1,
        payment_status_id: 1,
        production_status_id: 1,
        production_status_from_details_enabled: true,
        final_amount: 1000,
        paid_amount: 0,
        order_date: '2026-05-01',
        planned_completion_date: '2026-05-10',
        delete_flag: false,
        version: 4,
    });
    db.order_workshops.push({
        order_workshop_id: 81,
        order_id: 15,
        workshop_id: 1,
        production_status_id: 1,
        received_date: '2026-05-01',
        started_date: null,
        completed_date: null,
        planned_completion_date: '2026-05-10',
        sequence_order: null,
        responsible_employee_id: null,
        notes: 'existing workshop',
        ref_key_1c: null,
    });
    db.order_workshops.push({
        order_workshop_id: 82,
        order_id: 15,
        workshop_id: 2,
        production_status_id: 2,
        received_date: '2026-05-02',
        started_date: null,
        completed_date: null,
        planned_completion_date: '2026-05-11',
        sequence_order: null,
        responsible_employee_id: null,
        notes: 'workshop deleted before save',
        ref_key_1c: null,
    });
    db.order_details.push({
        detail_id: 71,
        order_id: 15,
        detail_number: 1,
        detail_name: 'Boundary detail',
        height: 1000,
        width: 500,
        quantity: 1,
        area: 0.5,
        // Variant B: material_id is always NULL; sheet_material_type_id is authoritative.
        material_id: null,
        sheet_material_type_id: 1,
        milling_type_id: 1,
        edge_type_id: 1,
        film_id: null,
        milling_cost_per_sqm: 10000,
        detail_cost: 1000,
        priority: 100,
        production_status_id: 1,
        joint_order_id: null,
        note: 'existing detail',
        link_cutting_file: null,
        link_cutting_image_file: null,
        link_cad_file: null,
        link_pdf_file: null,
        ref_key_1c: null,
        delete_flag: false,
    });
    db.order_resource_requirements.push({
        requirement_id: 91,
        order_id: 15,
        resource_type: 'material',
        material_id: 1,
        film_id: null,
        edge_type_id: null,
        required_quantity: 2,
        unit_id: 1,
        waste_percentage: null,
        final_quantity: 2,
        requirement_status_id: 1,
        supplier_id: null,
        purchase_price: null,
        requisition_id: null,
        warehouse_id: null,
        reserved_at: null,
        consumed_at: null,
        notes: 'existing requirement',
        calculation_details: null,
        ref_key_1c: null,
        is_active: true,
    });
    db.order_resource_requirements.push({
        requirement_id: 92,
        order_id: 15,
        resource_type: 'material',
        material_id: 1,
        film_id: null,
        edge_type_id: null,
        required_quantity: 3,
        unit_id: 1,
        waste_percentage: null,
        final_quantity: 3,
        requirement_status_id: 1,
        supplier_id: null,
        purchase_price: null,
        requisition_id: null,
        warehouse_id: null,
        reserved_at: null,
        consumed_at: null,
        notes: 'requirement deleted before save',
        calculation_details: null,
        ref_key_1c: null,
        is_active: true,
    });
    db.doweling_orders.push({
        doweling_order_id: 44,
        doweling_order_name: 'Boundary doweling',
        design_engineer_id: 1,
        production_status_id: 1,
        payment_status_id: 1,
        doweling_order_date: '2026-05-01',
    });
    db.doweling_orders.push({
        doweling_order_id: 45,
        doweling_order_name: 'Deleted boundary doweling',
        design_engineer_id: 2,
        production_status_id: 1,
        payment_status_id: 1,
        doweling_order_date: '2026-05-02',
    });
    db.order_doweling_links.push({
        order_doweling_link_id: 101,
        order_id: 15,
        doweling_order_id: 44,
        ref_key_1c: null,
        doweling_order: {
            doweling_order_id: 44,
            doweling_order_name: 'Boundary doweling',
            design_engineer_id: 1,
        },
    });
    db.order_doweling_links.push({
        order_doweling_link_id: 102,
        order_id: 15,
        doweling_order_id: 45,
        ref_key_1c: null,
        doweling_order: {
            doweling_order_id: 45,
            doweling_order_name: 'Deleted boundary doweling',
            design_engineer_id: 2,
        },
    });
}

async function deleteWorkflowChildrenThroughStore(page: Page) {
    await page.evaluate(async () => {
        const { useOrderFormStore } = await import('/src/stores/orderFormStore.ts');
        const store = useOrderFormStore.getState();
        store.deleteWorkshop(82, 82);
        store.deleteRequirement(92, 92);
        store.deleteDowelingLink(102, 102);
    });
}

async function setupOrderSaveBackendMock(page: Page, db: WorkflowMockDb) {
    const api = {
        updateBodies: [] as Array<Record<string, unknown>>,
    };

    await page.route(/\/api\/v1\/orders\/15$/, async (route) => {
        const method = route.request().method();
        if (method === 'GET') {
            await fulfillJson(route, toBackendOrder(db));
            return;
        }
        if (method !== 'PUT') {
            await route.fallback();
            return;
        }

        const body = JSON.parse(route.request().postData() || '{}');
        api.updateBodies.push(body);
        const order = db.orders.find((item) => item.order_id === 15);
        if (order) {
            const header = (body.header ?? {}) as Record<string, unknown>;
            if (typeof header.orderName === 'string') {
                order.order_name = header.orderName;
            }
            order.version = Number(order.version || 0) + 1;
        }

        await fulfillJson(route, {
            order: {
                ...toBackendOrder(db).order,
                version: order?.version ?? 5,
            },
        });
    });

    return api;
}

function toBackendOrder(db: WorkflowMockDb) {
    const order = db.orders.find((item) => item.order_id === 15);
    if (!order) throw new Error('Missing mock order 15');

    return {
        order: {
            header: {
                orderId: 15,
                orderName: order.order_name,
                clientId: order.client_id,
                orderDate: order.order_date,
                orderStatusId: order.order_status_id,
                paymentStatusId: order.payment_status_id,
                productionStatusId: order.production_status_id,
                productionStatusFromDetailsEnabled: order.production_status_from_details_enabled,
                plannedCompletionDate: order.planned_completion_date,
                version: order.version,
            },
            details: db.order_details.map((detail) => ({
                id: detail.detail_id,
                orderId: detail.order_id,
                detailNumber: detail.detail_number,
                detailName: detail.detail_name,
                height: detail.height,
                width: detail.width,
                quantity: detail.quantity,
                area: detail.area,
                // Variant B: material_id is always null; sheet_material_type_id is authoritative.
                materialId: null,
                sheetMaterialTypeId: detail.sheet_material_type_id ?? null,
                millingTypeId: detail.milling_type_id,
                edgeTypeId: detail.edge_type_id,
                filmId: detail.film_id,
                millingCostPerSqm: detail.milling_cost_per_sqm,
                detailCost: detail.detail_cost,
                priority: detail.priority,
                productionStatusId: detail.production_status_id,
                jointOrderId: detail.joint_order_id,
                note: detail.note,
                linkCuttingFile: detail.link_cutting_file,
                linkCuttingImageFile: detail.link_cutting_image_file,
                linkCadFile: detail.link_cad_file,
                linkPdfFile: detail.link_pdf_file,
                refKey1c: detail.ref_key_1c,
            })),
            payments: [],
            workshops: db.order_workshops.map((workshop) => ({
                id: workshop.order_workshop_id,
                orderId: workshop.order_id,
                workshopId: workshop.workshop_id,
                productionStatusId: workshop.production_status_id,
                receivedDate: workshop.received_date,
                startedDate: workshop.started_date,
                completedDate: workshop.completed_date,
                plannedCompletionDate: workshop.planned_completion_date,
                sequenceOrder: workshop.sequence_order,
                responsibleEmployeeId: workshop.responsible_employee_id,
                notes: workshop.notes,
                refKey1c: workshop.ref_key_1c,
            })),
            requirements: db.order_resource_requirements.map((requirement) => ({
                id: requirement.requirement_id,
                orderId: requirement.order_id,
                resourceType: requirement.resource_type,
                materialId: requirement.material_id,
                filmId: requirement.film_id,
                edgeTypeId: requirement.edge_type_id,
                requiredQuantity: requirement.required_quantity,
                unitId: requirement.unit_id,
                wastePercentage: requirement.waste_percentage,
                finalQuantity: requirement.final_quantity,
                requirementStatusId: requirement.requirement_status_id,
                supplierId: requirement.supplier_id,
                purchasePrice: requirement.purchase_price,
                requisitionId: requirement.requisition_id,
                warehouseId: requirement.warehouse_id,
                reservedAt: requirement.reserved_at,
                consumedAt: requirement.consumed_at,
                notes: requirement.notes,
                calculationDetails: requirement.calculation_details,
                refKey1c: requirement.ref_key_1c,
            })),
            dowelingLinks: db.order_doweling_links.map((link) => ({
                id: link.order_doweling_link_id,
                orderId: link.order_id,
                dowelingOrderId: link.doweling_order_id,
                designEngineerId: link.doweling_order?.design_engineer_id ?? null,
                designEngineerName: null,
                refKey1c: link.ref_key_1c,
                dowelingOrder: {
                    id: link.doweling_order_id,
                    name: link.doweling_order?.doweling_order_name ?? 'Boundary doweling',
                    designEngineerId: link.doweling_order?.design_engineer_id ?? null,
                },
            })),
            totals: {
                totalAmount: 1000,
                discount: 0,
                surcharge: 0,
                finalAmount: 1000,
                paidAmount: 0,
                debtAmount: 1000,
                partsCount: 0,
                totalArea: 0,
            },
            version: order.version,
        },
    };
}

async function fulfillJson(route: Route, body: unknown) {
    await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
    });
}
