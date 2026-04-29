import type { Page, Route } from '@playwright/test';

type Row = Record<string, any>;

export type WorkflowMockDb = Record<string, Row[]>;

const AUTH_TOKEN =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwidXNlcm5hbWUiOiJhZG1pbiIsInJvbGUiOiJhZG1pbiIsImh0dHBzOi8vaGFzdXJhLmlvL2p3dC9jbGFpbXMiOnsiWC1IYXN1cmEtQWxsb3dlZC1Sb2xlcyI6WyJhZG1pbiJdLCJYLUhhc3VyYS1EZWZhdWx0LVJvbGUiOiJhZG1pbiIsIlgtSGFzdXJhLVVzZXItSWQiOiIxIn0sImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoyMDAwMDAwMDAwfQ.test';

const ID_COLUMNS: Record<string, string> = {
    app_settings: 'setting_id',
    client_phones: 'phone_id',
    clients: 'client_id',
    doweling_orders: 'doweling_order_id',
    doweling_orders_view: 'doweling_order_id',
    edge_types: 'edge_type_id',
    employees: 'employee_id',
    film_types: 'film_type_id',
    films: 'film_id',
    material_types: 'material_type_id',
    materials: 'material_id',
    milling_types: 'milling_type_id',
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
    production_status_events: 'event_id',
    production_statuses: 'production_status_id',
    resource_requirements_statuses: 'requirement_status_id',
    material_transaction_types: 'transaction_type_id',
    suppliers: 'supplier_id',
    transaction_direction: 'direction_type_id',
    units: 'unit_id',
    vendors: 'vendor_id',
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
            },
        ],
        film_types: [
            {
                film_type_id: 1,
                film_type_name: 'ПВХ',
                is_active: true,
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
        resource_requirements_statuses: [],
        suppliers: [
            {
                supplier_id: 1,
                supplier_name: 'Тестовый поставщик',
                is_active: true,
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
        ],
        units: [
            {
                unit_id: 1,
                unit_code: 'sqm',
                unit_name: 'Квадратный метр',
                unit_symbol: 'м²',
                decimals: 2,
            },
        ],
        vendors: [
            {
                vendor_id: 1,
                vendor_name: 'Тестовый производитель',
                material_type_id: 1,
                is_active: true,
            },
        ],
        workshops: [
            {
                workshop_id: 1,
                workshop_name: 'Основной цех',
                address: 'Тестовый адрес',
                responsible_employee_id: 1,
                is_active: true,
            },
        ],
        work_centers: [],
    };
}

export async function setupWorkflowMockApi(page: Page, db = createWorkflowMockDb()): Promise<WorkflowMockDb> {
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

    await page.route(/\/(v1\/graphql|undefined)$/, async (route) => {
        await fulfillGraphql(route, db);
    });

    return db;
}

async function fulfillGraphql(route: Route, db: WorkflowMockDb) {
    const body = JSON.parse(route.request().postData() || '{}');
    const query = String(body.query || '');

    try {
        const data = handleGraphql(query, db);
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ data }),
        });
    } catch (error) {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                errors: [
                    {
                        message: error instanceof Error ? error.message : 'Mock GraphQL error',
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
    const idMatch = query.match(new RegExp(`${idCol}\\s*:\\s*([^,}\\s]+)`));
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
    const idMatch = query.match(new RegExp(`${idCol}\\s*:\\s*([^,}\\s]+)`));
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
