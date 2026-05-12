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
    fillUpdate: (page: Page) => Promise<void>;
    expectedCreate: Record<string, any>;
    expectedUpdate: Record<string, any>;
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
            await fillText(page, 'edge_type_name', 'E2E обкат R3');
            await fillText(page, 'sort_order', '25');
            await fillText(page, 'description', 'Создано из workflow-теста');
            await setChecked(page, 'is_active', true);
            await fillText(page, 'ref_key_1c', 'EDGE-E2E');
        },
        fillUpdate: async (page) => {
            await fillText(page, 'edge_type_name', 'E2E обкат R3 обновлен');
            await fillText(page, 'sort_order', '26');
            await fillText(page, 'description', 'Обновлено из workflow-теста');
            await setChecked(page, 'is_active', false);
            await fillText(page, 'ref_key_1c', 'EDGE-E2E-UPD');
        },
        expectedCreate: {
            sort_order: 25,
            description: 'Создано из workflow-теста',
            is_active: true,
            ref_key_1c: 'EDGE-E2E',
        },
        expectedUpdate: {
            sort_order: 26,
            description: 'Обновлено из workflow-теста',
            is_active: false,
            ref_key_1c: 'EDGE-E2E-UPD',
        },
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
            await fillText(page, 'material_type_name', 'E2E тип материала');
            await fillText(page, 'sort_order', '35');
            await fillText(page, 'description', 'Материал из workflow-теста');
            await setChecked(page, 'is_active', true);
            await fillText(page, 'ref_key_1c', 'MAT-TYPE-E2E');
        },
        fillUpdate: async (page) => {
            await fillText(page, 'material_type_name', 'E2E тип материала обновлен');
            await fillText(page, 'sort_order', '36');
            await fillText(page, 'description', 'Материал обновлен из workflow-теста');
            await setChecked(page, 'is_active', false);
            await fillText(page, 'ref_key_1c', 'MAT-TYPE-E2E-UPD');
        },
        expectedCreate: {
            sort_order: 35,
            description: 'Материал из workflow-теста',
            is_active: true,
            ref_key_1c: 'MAT-TYPE-E2E',
        },
        expectedUpdate: {
            sort_order: 36,
            description: 'Материал обновлен из workflow-теста',
            is_active: false,
            ref_key_1c: 'MAT-TYPE-E2E-UPD',
        },
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
            await fillText(page, 'milling_type_name', 'E2E фрезеровка');
            await fillText(page, 'cost_per_sqm', '12345');
            await fillText(page, 'sort_order', '45');
            await fillText(page, 'description', 'Фрезеровка из workflow-теста');
            await setChecked(page, 'is_active', true);
            await fillText(page, 'ref_key_1c', 'MILL-E2E');
        },
        fillUpdate: async (page) => {
            await fillText(page, 'milling_type_name', 'E2E фрезеровка обновлена');
            await fillText(page, 'cost_per_sqm', '23456');
            await fillText(page, 'sort_order', '46');
            await fillText(page, 'description', 'Фрезеровка обновлена из workflow-теста');
            await setChecked(page, 'is_active', false);
            await fillText(page, 'ref_key_1c', 'MILL-E2E-UPD');
        },
        expectedCreate: {
            cost_per_sqm: 12345,
            sort_order: 45,
            description: 'Фрезеровка из workflow-теста',
            is_active: true,
            ref_key_1c: 'MILL-E2E',
        },
        expectedUpdate: {
            cost_per_sqm: 23456,
            sort_order: 46,
            description: 'Фрезеровка обновлена из workflow-теста',
            is_active: false,
            ref_key_1c: 'MILL-E2E-UPD',
        },
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
            await fillText(page, 'film_type_name', 'E2E тип пленки');
            await fillText(page, 'ref_key_1c', 'FILM-TYPE-E2E');
            await setChecked(page, 'is_active', true);
        },
        fillUpdate: async (page) => {
            await fillText(page, 'film_type_name', 'E2E тип пленки обновлен');
            await fillText(page, 'ref_key_1c', 'FILM-TYPE-E2E-UPD');
            await setChecked(page, 'is_active', false);
        },
        expectedCreate: { ref_key_1c: 'FILM-TYPE-E2E', is_active: true },
        expectedUpdate: { ref_key_1c: 'FILM-TYPE-E2E-UPD', is_active: false },
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
            await fillText(page, 'type_paid_name', 'E2E тип оплаты');
            await fillText(page, 'sort_order', '55');
            await setChecked(page, 'is_active', true);
            await fillText(page, 'ref_key_1c', 'PAY-TYPE-E2E');
        },
        fillUpdate: async (page) => {
            await fillText(page, 'type_paid_name', 'E2E тип оплаты обновлен');
            await fillText(page, 'sort_order', '56');
            await setChecked(page, 'is_active', false);
            await fillText(page, 'ref_key_1c', 'PAY-TYPE-E2E-UPD');
        },
        expectedCreate: { sort_order: 55, is_active: true, ref_key_1c: 'PAY-TYPE-E2E' },
        expectedUpdate: { sort_order: 56, is_active: false, ref_key_1c: 'PAY-TYPE-E2E-UPD' },
    },
    {
        title: 'статусы заказов',
        path: '/order-statuses',
        resource: 'order_statuses',
        idField: 'order_status_id',
        nameField: 'order_status_name',
        createName: 'E2E статус заказа',
        updateName: 'E2E статус заказа обновлен',
        fillCreate: async (page) => {
            await fillText(page, 'order_status_name', 'E2E статус заказа');
            await fillText(page, 'sort_order', '65');
            await fillText(page, 'color', '#112233');
            await fillText(page, 'description', 'Статус заказа из workflow-теста');
            await setChecked(page, 'is_active', true);
            await fillText(page, 'ref_key_1c', 'ORDER-STATUS-E2E');
        },
        fillUpdate: async (page) => {
            await fillText(page, 'order_status_name', 'E2E статус заказа обновлен');
            await fillText(page, 'sort_order', '66');
            await fillText(page, 'color', '#445566');
            await fillText(page, 'description', 'Статус заказа обновлен из workflow-теста');
            await setChecked(page, 'is_active', false);
            await fillText(page, 'ref_key_1c', 'ORDER-STATUS-E2E-UPD');
        },
        expectedCreate: {
            sort_order: 65,
            color: '#112233',
            description: 'Статус заказа из workflow-теста',
            is_active: true,
            ref_key_1c: 'ORDER-STATUS-E2E',
        },
        expectedUpdate: {
            sort_order: 66,
            color: '#445566',
            description: 'Статус заказа обновлен из workflow-теста',
            is_active: false,
            ref_key_1c: 'ORDER-STATUS-E2E-UPD',
        },
    },
    {
        title: 'статусы платежей',
        path: '/payment-statuses',
        resource: 'payment_statuses',
        idField: 'payment_status_id',
        nameField: 'payment_status_name',
        createName: 'E2E статус платежа',
        updateName: 'E2E статус платежа обновлен',
        fillCreate: async (page) => {
            await fillText(page, 'payment_status_name', 'E2E статус платежа');
            await fillText(page, 'sort_order', '75');
            await fillText(page, 'color', '#AA7733');
            await fillText(page, 'description', 'Статус платежа из workflow-теста');
            await setChecked(page, 'is_active', true);
            await fillText(page, 'ref_key_1c', 'PAY-STATUS-E2E');
        },
        fillUpdate: async (page) => {
            await fillText(page, 'payment_status_name', 'E2E статус платежа обновлен');
            await fillText(page, 'sort_order', '76');
            await fillText(page, 'color', '#33AA77');
            await fillText(page, 'description', 'Статус платежа обновлен из workflow-теста');
            await setChecked(page, 'is_active', false);
            await fillText(page, 'ref_key_1c', 'PAY-STATUS-E2E-UPD');
        },
        expectedCreate: {
            sort_order: 75,
            color: '#AA7733',
            description: 'Статус платежа из workflow-теста',
            is_active: true,
            ref_key_1c: 'PAY-STATUS-E2E',
        },
        expectedUpdate: {
            sort_order: 76,
            color: '#33AA77',
            description: 'Статус платежа обновлен из workflow-теста',
            is_active: false,
            ref_key_1c: 'PAY-STATUS-E2E-UPD',
        },
    },
    {
        title: 'статусы производства',
        path: '/production-statuses',
        resource: 'production_statuses',
        idField: 'production_status_id',
        nameField: 'production_status_name',
        createName: 'E2E статус производства',
        updateName: 'E2E статус производства обновлен',
        fillCreate: async (page) => {
            await fillText(page, 'production_status_name', 'E2E статус производства');
            await fillText(page, 'sort_order', '85');
            await fillText(page, 'color', '#3366AA');
            await fillText(page, 'description', 'Статус производства из workflow-теста');
            await setChecked(page, 'is_active', true);
            await fillText(page, 'ref_key_1c', 'PROD-STATUS-E2E');
        },
        fillUpdate: async (page) => {
            await fillText(page, 'production_status_name', 'E2E статус производства обновлен');
            await fillText(page, 'sort_order', '86');
            await fillText(page, 'color', '#AA6633');
            await fillText(page, 'description', 'Статус производства обновлен из workflow-теста');
            await setChecked(page, 'is_active', false);
            await fillText(page, 'ref_key_1c', 'PROD-STATUS-E2E-UPD');
        },
        expectedCreate: {
            sort_order: 85,
            color: '#3366AA',
            description: 'Статус производства из workflow-теста',
            is_active: true,
            ref_key_1c: 'PROD-STATUS-E2E',
        },
        expectedUpdate: {
            sort_order: 86,
            color: '#AA6633',
            description: 'Статус производства обновлен из workflow-теста',
            is_active: false,
            ref_key_1c: 'PROD-STATUS-E2E-UPD',
        },
    },
    {
        title: 'статусы заявок',
        path: '/requisition-statuses',
        resource: 'requisition_statuses',
        idField: 'requisition_status_id',
        nameField: 'requisition_status_name',
        createName: 'E2E статус заявки',
        updateName: 'E2E статус заявки обновлен',
        fillCreate: async (page) => {
            await fillText(page, 'requisition_status_name', 'E2E статус заявки');
            await fillText(page, 'sort_order', '95');
            await setChecked(page, 'is_active', true);
            await fillText(page, 'description', 'Статус заявки из workflow-теста');
        },
        fillUpdate: async (page) => {
            await fillText(page, 'requisition_status_name', 'E2E статус заявки обновлен');
            await fillText(page, 'sort_order', '96');
            await setChecked(page, 'is_active', false);
            await fillText(page, 'description', 'Статус заявки обновлен из workflow-теста');
        },
        expectedCreate: {
            sort_order: 95,
            is_active: true,
            description: 'Статус заявки из workflow-теста',
        },
        expectedUpdate: {
            sort_order: 96,
            is_active: false,
            description: 'Статус заявки обновлен из workflow-теста',
        },
    },
    {
        title: 'статусы движений',
        path: '/movements-statuses',
        resource: 'movements_statuses',
        idField: 'movement_status_id',
        nameField: 'movement_status_name',
        createName: 'E2E статус движения',
        updateName: 'E2E статус движения обновлен',
        fillCreate: async (page) => {
            await fillText(page, 'movement_status_code', 'E2E-MOVE');
            await fillText(page, 'movement_status_name', 'E2E статус движения');
            await fillText(page, 'sort_order', '105');
            await setChecked(page, 'is_active', true);
            await fillText(page, 'description', 'Статус движения из workflow-теста');
        },
        fillUpdate: async (page) => {
            await fillText(page, 'movement_status_code', 'E2E-MOVE-UPD');
            await fillText(page, 'movement_status_name', 'E2E статус движения обновлен');
            await fillText(page, 'sort_order', '106');
            await setChecked(page, 'is_active', false);
            await fillText(page, 'description', 'Статус движения обновлен из workflow-теста');
        },
        expectedCreate: {
            movement_status_code: 'E2E-MOVE',
            sort_order: 105,
            is_active: true,
            description: 'Статус движения из workflow-теста',
        },
        expectedUpdate: {
            movement_status_code: 'E2E-MOVE-UPD',
            sort_order: 106,
            is_active: false,
            description: 'Статус движения обновлен из workflow-теста',
        },
    },
    {
        title: 'статусы потребностей',
        path: '/resource-requirements-statuses',
        resource: 'resource_requirements_statuses',
        idField: 'requirement_status_id',
        nameField: 'requirement_status_name',
        createName: 'E2E статус потребности',
        updateName: 'E2E статус потребности обновлен',
        fillCreate: async (page) => {
            await fillText(page, 'requirement_status_code', 'E2E-REQ');
            await fillText(page, 'requirement_status_name', 'E2E статус потребности');
            await fillText(page, 'sort_order', '115');
            await fillText(page, 'description', 'Статус потребности из workflow-теста');
            await setChecked(page, 'is_active', true);
            await fillText(page, 'ref_key_1c', 'REQ-STATUS-E2E');
        },
        fillUpdate: async (page) => {
            await fillText(page, 'requirement_status_code', 'E2E-REQ-UPD');
            await fillText(page, 'requirement_status_name', 'E2E статус потребности обновлен');
            await fillText(page, 'sort_order', '116');
            await fillText(page, 'description', 'Статус потребности обновлен из workflow-теста');
            await setChecked(page, 'is_active', false);
            await fillText(page, 'ref_key_1c', 'REQ-STATUS-E2E-UPD');
        },
        expectedCreate: {
            requirement_status_code: 'E2E-REQ',
            sort_order: 115,
            description: 'Статус потребности из workflow-теста',
            is_active: true,
            ref_key_1c: 'REQ-STATUS-E2E',
        },
        expectedUpdate: {
            requirement_status_code: 'E2E-REQ-UPD',
            sort_order: 116,
            description: 'Статус потребности обновлен из workflow-теста',
            is_active: false,
            ref_key_1c: 'REQ-STATUS-E2E-UPD',
        },
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
            await fillText(page, 'direction_code', 'E2E-DIR');
            await fillText(page, 'direction_name', 'E2E направление');
            await fillText(page, 'description', 'Направление из workflow-теста');
            await setChecked(page, 'is_active', true);
        },
        fillUpdate: async (page) => {
            await fillText(page, 'direction_code', 'E2E-DIR-UPD');
            await fillText(page, 'direction_name', 'E2E направление обновлено');
            await fillText(page, 'description', 'Направление обновлено из workflow-теста');
            await setChecked(page, 'is_active', false);
        },
        expectedCreate: {
            direction_code: 'E2E-DIR',
            description: 'Направление из workflow-теста',
            is_active: true,
        },
        expectedUpdate: {
            direction_code: 'E2E-DIR-UPD',
            description: 'Направление обновлено из workflow-теста',
            is_active: false,
        },
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
            await fillText(page, 'transaction_type_name', 'E2E движение материала');
            await selectAntdOption(page, formItem(page, 'Direction'), 'Приход');
            await setChecked(page, 'affects_stock', true);
            await setChecked(page, 'requires_document', false);
            await fillText(page, 'sort_order', '125');
            await setChecked(page, 'is_active', true);
            await fillText(page, 'description', 'Тип движения из workflow-теста');
        },
        fillUpdate: async (page) => {
            await fillText(page, 'transaction_type_name', 'E2E движение материала обновлено');
            await selectAntdOption(page, formItem(page, 'Direction'), 'Расход');
            await setChecked(page, 'affects_stock', false);
            await setChecked(page, 'requires_document', true);
            await fillText(page, 'sort_order', '126');
            await setChecked(page, 'is_active', false);
            await fillText(page, 'description', 'Тип движения обновлен из workflow-теста');
        },
        expectedCreate: {
            direction_type_id: 1,
            affects_stock: true,
            requires_document: false,
            sort_order: 125,
            is_active: true,
            description: 'Тип движения из workflow-теста',
        },
        expectedUpdate: {
            direction_type_id: 2,
            affects_stock: false,
            requires_document: true,
            sort_order: 126,
            is_active: false,
            description: 'Тип движения обновлен из workflow-теста',
        },
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
            await fillText(page, 'unit_code', 'e2e');
            await fillText(page, 'unit_name', 'E2E единица');
            await fillText(page, 'unit_symbol', 'e2e');
            await fillText(page, 'decimals', '3');
            await fillText(page, 'ref_key_1c', 'UNIT-E2E');
        },
        fillUpdate: async (page) => {
            await fillText(page, 'unit_code', 'e2u');
            await fillText(page, 'unit_name', 'E2E единица обновлена');
            await fillText(page, 'unit_symbol', 'e2u');
            await fillText(page, 'decimals', '4');
            await fillText(page, 'ref_key_1c', 'UNIT-E2E-UPD');
        },
        expectedCreate: { unit_code: 'e2e', unit_symbol: 'e2e', decimals: 3, ref_key_1c: 'UNIT-E2E' },
        expectedUpdate: { unit_code: 'e2u', unit_symbol: 'e2u', decimals: 4, ref_key_1c: 'UNIT-E2E-UPD' },
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
            await fillText(page, 'supplier_name', 'E2E поставщик');
            await fillText(page, 'address', 'Алматы, тестовый адрес');
            await fillText(page, 'contact_person', 'Контакт E2E');
            await fillText(page, 'phone', '+7 701 555 1212');
            await fillText(page, 'ref_key_1c', 'SUPPLIER-E2E');
            await fillText(page, 'description', 'Поставщик из workflow-теста');
            await setChecked(page, 'is_active', true);
        },
        fillUpdate: async (page) => {
            await fillText(page, 'supplier_name', 'E2E поставщик обновлен');
            await fillText(page, 'address', 'Астана, обновленный адрес');
            await fillText(page, 'contact_person', 'Контакт E2E обновлен');
            await fillText(page, 'phone', '+7 702 555 1212');
            await fillText(page, 'ref_key_1c', 'SUPPLIER-E2E-UPD');
            await fillText(page, 'description', 'Поставщик обновлен из workflow-теста');
            await setChecked(page, 'is_active', false);
        },
        expectedCreate: {
            address: 'Алматы, тестовый адрес',
            contact_person: 'Контакт E2E',
            phone: '+7 701 555 1212',
            ref_key_1c: 'SUPPLIER-E2E',
            description: 'Поставщик из workflow-теста',
            is_active: true,
        },
        expectedUpdate: {
            address: 'Астана, обновленный адрес',
            contact_person: 'Контакт E2E обновлен',
            phone: '+7 702 555 1212',
            ref_key_1c: 'SUPPLIER-E2E-UPD',
            description: 'Поставщик обновлен из workflow-теста',
            is_active: false,
        },
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
            await fillText(page, 'vendor_name', 'E2E производитель');
            await selectAntdOption(page, formItem(page, 'Тип материала'), 'МДФ');
            await fillText(page, 'contact_info', 'vendor@example.test');
            await fillText(page, 'ref_key_1c', 'VENDOR-E2E');
            await setChecked(page, 'is_active', true);
        },
        fillUpdate: async (page) => {
            await fillText(page, 'vendor_name', 'E2E производитель обновлен');
            await selectAntdOption(page, formItem(page, 'Тип материала'), 'ЛДСП');
            await fillText(page, 'contact_info', 'vendor-updated@example.test');
            await fillText(page, 'ref_key_1c', 'VENDOR-E2E-UPD');
            await setChecked(page, 'is_active', false);
        },
        expectedCreate: {
            material_type_id: 1,
            contact_info: 'vendor@example.test',
            ref_key_1c: 'VENDOR-E2E',
            is_active: true,
        },
        expectedUpdate: {
            material_type_id: 2,
            contact_info: 'vendor-updated@example.test',
            ref_key_1c: 'VENDOR-E2E-UPD',
            is_active: false,
        },
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
            await fillText(page, 'film_name', 'E2E пленка');
            await selectAntdOption(page, formItem(page, 'Film Type'), 'ПВХ');
            await selectAntdOption(page, formItem(page, 'Производитель'), 'Тестовый производитель');
            await setChecked(page, 'film_texture', true);
            await fillText(page, 'ref_key_1c', 'FILM-E2E');
            await setChecked(page, 'is_active', true);
        },
        fillUpdate: async (page) => {
            await fillText(page, 'film_name', 'E2E пленка обновлена');
            await selectAntdOption(page, formItem(page, 'Film Type'), 'PET');
            await selectAntdOption(page, formItem(page, 'Производитель'), 'Второй производитель');
            await setChecked(page, 'film_texture', false);
            await fillText(page, 'ref_key_1c', 'FILM-E2E-UPD');
            await setChecked(page, 'is_active', false);
        },
        expectedCreate: {
            film_type_id: 1,
            vendor_id: 1,
            film_texture: true,
            ref_key_1c: 'FILM-E2E',
            is_active: true,
        },
        expectedUpdate: {
            film_type_id: 2,
            vendor_id: 2,
            film_texture: false,
            ref_key_1c: 'FILM-E2E-UPD',
            is_active: false,
        },
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
            await fillText(page, 'material_name', 'E2E материал');
            await selectAntdOption(page, formItem(page, 'Unit'), 'Квадратный метр');
            await selectAntdOption(page, formItem(page, 'Material Type'), 'МДФ');
            await selectAntdOption(page, formItem(page, 'Vendor'), 'Тестовый производитель');
            await selectAntdOption(page, formItem(page, 'Supplier'), 'Тестовый поставщик');
            await fillText(page, 'description', 'Материал из workflow-теста');
            await setChecked(page, 'is_active', true);
            await fillText(page, 'ref_key_1c', 'MATERIAL-E2E');
        },
        fillUpdate: async (page) => {
            await fillText(page, 'material_name', 'E2E материал обновлен');
            await selectAntdOption(page, formItem(page, 'Unit'), 'Штука');
            await selectAntdOption(page, formItem(page, 'Material Type'), 'ЛДСП');
            await selectAntdOption(page, formItem(page, 'Vendor'), 'Второй производитель');
            await selectAntdOption(page, formItem(page, 'Supplier'), 'Резервный поставщик');
            await fillText(page, 'description', 'Материал обновлен из workflow-теста');
            await setChecked(page, 'is_active', false);
            await fillText(page, 'ref_key_1c', 'MATERIAL-E2E-UPD');
        },
        expectedCreate: {
            unit_id: 1,
            material_type_id: 1,
            vendor_id: 1,
            default_supplier_id: 1,
            description: 'Материал из workflow-теста',
            is_active: true,
            ref_key_1c: 'MATERIAL-E2E',
        },
        expectedUpdate: {
            unit_id: 2,
            material_type_id: 2,
            vendor_id: 2,
            default_supplier_id: 2,
            description: 'Материал обновлен из workflow-теста',
            is_active: false,
            ref_key_1c: 'MATERIAL-E2E-UPD',
        },
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
            await fillText(page, 'full_name', 'E2E сотрудник');
            await fillText(page, 'position', 'Тестировщик справочников');
            await fillText(page, 'note', 'Создано из workflow-теста');
            await setChecked(page, 'is_active', true);
            await fillText(page, 'ref_key_1c', 'EMPLOYEE-E2E');
        },
        fillUpdate: async (page) => {
            await fillText(page, 'full_name', 'E2E сотрудник обновлен');
            await fillText(page, 'position', 'Старший тестировщик справочников');
            await fillText(page, 'note', 'Обновлено из workflow-теста');
            await setChecked(page, 'is_active', false);
            await fillText(page, 'ref_key_1c', 'EMPLOYEE-E2E-UPD');
        },
        expectedCreate: {
            position: 'Тестировщик справочников',
            note: 'Создано из workflow-теста',
            is_active: true,
            ref_key_1c: 'EMPLOYEE-E2E',
        },
        expectedUpdate: {
            position: 'Старший тестировщик справочников',
            note: 'Обновлено из workflow-теста',
            is_active: false,
            ref_key_1c: 'EMPLOYEE-E2E-UPD',
        },
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
            await fillText(page, 'workshop_name', 'E2E цех');
            await fillText(page, 'address', 'Адрес E2E цеха');
            await selectAntdOption(page, formItem(page, 'Ответственный сотрудник'), 'Администратор Тестов');
            await setChecked(page, 'is_active', true);
            await fillText(page, 'ref_key_1c', 'WORKSHOP-E2E');
        },
        fillUpdate: async (page) => {
            await fillText(page, 'workshop_name', 'E2E цех обновлен');
            await fillText(page, 'address', 'Адрес E2E цеха обновлен');
            await selectAntdOption(page, formItem(page, 'Ответственный сотрудник'), 'Мастер Тестов');
            await setChecked(page, 'is_active', false);
            await fillText(page, 'ref_key_1c', 'WORKSHOP-E2E-UPD');
        },
        expectedCreate: {
            address: 'Адрес E2E цеха',
            responsible_employee_id: 1,
            is_active: true,
            ref_key_1c: 'WORKSHOP-E2E',
        },
        expectedUpdate: {
            address: 'Адрес E2E цеха обновлен',
            responsible_employee_id: 2,
            is_active: false,
            ref_key_1c: 'WORKSHOP-E2E-UPD',
        },
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
            await fillText(page, 'workcenter_code', 'E2E-WC');
            await fillText(page, 'workcenter_name', 'E2E участок');
            await selectAntdOption(page, formItem(page, 'Цех'), 'Основной цех');
            await setChecked(page, 'is_active', true);
            await fillText(page, 'ref_key_1c', 'WORKCENTER-E2E');
        },
        fillUpdate: async (page) => {
            await fillText(page, 'workcenter_code', 'E2E-WC-UPD');
            await fillText(page, 'workcenter_name', 'E2E участок обновлен');
            await selectAntdOption(page, formItem(page, 'Цех'), 'Финишный цех');
            await setChecked(page, 'is_active', false);
            await fillText(page, 'ref_key_1c', 'WORKCENTER-E2E-UPD');
        },
        expectedCreate: {
            workcenter_code: 'E2E-WC',
            workshop_id: 1,
            is_active: true,
            ref_key_1c: 'WORKCENTER-E2E',
        },
        expectedUpdate: {
            workcenter_code: 'E2E-WC-UPD',
            workshop_id: 2,
            is_active: false,
            ref_key_1c: 'WORKCENTER-E2E-UPD',
        },
    },
    {
        title: 'клиенты',
        path: '/clients',
        resource: 'clients',
        idField: 'client_id',
        nameField: 'client_name',
        createName: 'E2E клиент',
        updateName: 'E2E клиент обновлен',
        fillCreate: async (page) => {
            await fillText(page, 'client_name', 'E2E клиент');
            await fillText(page, 'notes', 'Клиент из workflow-теста');
            await setChecked(page, 'is_active', true);
            await fillText(page, 'ref_key_1c', 'CLIENT-E2E');
        },
        fillUpdate: async (page) => {
            await fillText(page, 'client_name', 'E2E клиент обновлен');
            await fillText(page, 'notes', 'Клиент обновлен из workflow-теста');
            await setChecked(page, 'is_active', false);
            await fillText(page, 'ref_key_1c', 'CLIENT-E2E-UPD');
        },
        expectedCreate: {
            notes: 'Клиент из workflow-теста',
            is_active: true,
            ref_key_1c: 'CLIENT-E2E',
        },
        expectedUpdate: {
            notes: 'Клиент обновлен из workflow-теста',
            is_active: false,
            ref_key_1c: 'CLIENT-E2E-UPD',
        },
    },
];

test.describe('Reference workflows', () => {
    test.setTimeout(600000);

    test('creates, updates every form field, and deletes all catalog records', async ({ page }) => {
        const db = await setupWorkflowMockApi(page);

        for (const catalog of catalogCases) {
            await test.step(catalog.title, async () => {
                await createUpdateAndDeleteCatalog(page, db, catalog);
            });
        }
    });

    test('creates, updates, and deletes client phones', async ({ page }) => {
        const db = await setupWorkflowMockApi(page);

        await page.goto('/clients/create');
        await fillText(page, 'client_name', 'E2E клиент с телефоном');
        await fillText(page, 'notes', 'Проверка справочника клиентов');
        await setChecked(page, 'is_active', true);
        await fillText(page, 'ref_key_1c', 'CLIENT-PHONE-E2E');

        const phonesCard = page.locator('.ant-card').filter({ hasText: 'Телефоны' });
        await phonesCard.getByRole('button', { name: 'Добавить' }).click();

        const addDialog = page.getByRole('dialog', { name: 'Добавить телефон' });
        await fillTextIn(addDialog, 'phone_number', '+7 701 123 4567');
        await selectAntdOption(page, formItem(addDialog, 'Тип телефона'), 'Мобильный');
        await addDialog.getByLabel('Основной номер').check();
        await addDialog.getByRole('button', { name: 'Добавить' }).click();

        await expect(phonesCard.getByText('+7 701 123 4567')).toBeVisible();
        await expect(phonesCard.getByText('Основной')).toBeVisible();

        const createUrl = page.url();
        await page.getByRole('button', { name: 'Сохранить' }).click();

        await expect
            .poll(() => db.clients.find((row) => row.client_name === 'E2E клиент с телефоном')?.client_id)
            .toBeTruthy();
        await settleNavigation(page, createUrl);

        const client = db.clients.find((row) => row.client_name === 'E2E клиент с телефоном')!;
        expect(client).toMatchObject({
            is_active: true,
            notes: 'Проверка справочника клиентов',
            ref_key_1c: 'CLIENT-PHONE-E2E',
        });

        await expect
            .poll(() => db.client_phones.find((row) => row.client_id === client.client_id))
            .toMatchObject({
                phone_number: '+7 701 123 4567',
                phone_type: 'mobile',
                is_primary: true,
            });

        const phone = db.client_phones.find((row) => row.client_id === client.client_id)!;

        await page.goto(`/clients/edit/${client.client_id}`);
        const clientNameInput = page.locator('#client_name');
        await expect(clientNameInput).toBeVisible({ timeout: 30000 });
        await expect(clientNameInput).toHaveValue('E2E клиент с телефоном', { timeout: 30000 });
        const editPhonesCard = page.locator('.ant-card').filter({ hasText: 'Телефоны' });
        await expect(editPhonesCard.getByText('+7 701 123 4567')).toBeVisible();

        await editPhonesCard
            .locator('tr')
            .filter({ hasText: '+7 701 123 4567' })
            .locator('button')
            .first()
            .click();

        const editDialog = page.getByRole('dialog', { name: 'Редактировать телефон' });
        await fillTextIn(editDialog, 'phone_number', '+7 702 765 4321');
        await selectAntdOption(page, formItem(editDialog, 'Тип телефона'), 'Рабочий');
        await editDialog.getByLabel('Основной номер').uncheck();
        await editDialog.getByRole('button', { name: 'Сохранить' }).click();

        await expect(editPhonesCard.getByText('+7 702 765 4321')).toBeVisible();
        await expect(editPhonesCard.getByText('Рабочий')).toBeVisible();

        await editPhonesCard
            .locator('tr')
            .filter({ hasText: '+7 702 765 4321' })
            .locator('button')
            .nth(1)
            .click();
        await page.getByRole('button', { name: 'Удалить' }).click();
        await expect(editPhonesCard.getByText('Нет телефонов')).toBeVisible();

        await fillText(page, 'notes', 'Телефон обновлен и удален');
        const editUrl = page.url();
        await page.getByRole('button', { name: 'Сохранить' }).click();

        await expect
            .poll(() => db.clients.find((row) => row.client_id === client.client_id))
            .toMatchObject({ notes: 'Телефон обновлен и удален' });
        await expect.poll(() => db.client_phones.some((row) => row.phone_id === phone.phone_id)).toBe(false);
        await settleNavigation(page, editUrl);

        await deleteCatalogRecord(page, db, {
            title: 'клиенты',
            path: '/clients',
            resource: 'clients',
            idField: 'client_id',
            nameField: 'client_name',
            createName: 'E2E клиент с телефоном',
            updateName: 'E2E клиент с телефоном',
            fillCreate: async () => {},
            fillUpdate: async () => {},
            expectedCreate: {},
            expectedUpdate: {},
        }, client.client_id);
    });
});

async function createUpdateAndDeleteCatalog(page: Page, db: WorkflowMockDb, catalog: CatalogCase) {
    await page.goto(`${catalog.path}/create`);
    await catalog.fillCreate(page);
    const createUrl = page.url();
    await page.getByRole('button', { name: 'Сохранить' }).click();

    await expect
        .poll(() => db[catalog.resource].find((row) => row[catalog.nameField] === catalog.createName)?.[catalog.idField])
        .toBeTruthy();
    await settleNavigation(page, createUrl);

    const created = db[catalog.resource].find((row) => row[catalog.nameField] === catalog.createName)!;
    expect(created).toMatchObject({
        [catalog.nameField]: catalog.createName,
        ...catalog.expectedCreate,
    });

    await page.goto(`${catalog.path}/edit/${created[catalog.idField]}`);
    const nameInput = page.locator(`#${catalog.nameField}`);
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toHaveValue(catalog.createName);
    await catalog.fillUpdate(page);
    const editUrl = page.url();
    await page.getByRole('button', { name: 'Сохранить' }).click();

    await expect
        .poll(() => db[catalog.resource].find((row) => row[catalog.idField] === created[catalog.idField]))
        .toMatchObject({
            [catalog.nameField]: catalog.updateName,
            ...catalog.expectedUpdate,
        });
    await settleNavigation(page, editUrl);

    await deleteCatalogRecord(page, db, catalog, created[catalog.idField]);
}

async function deleteCatalogRecord(page: Page, db: WorkflowMockDb, catalog: CatalogCase, id: number | string) {
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
        { resource: catalog.resource, idField: catalog.idField, id },
    );

    expect(response.errors).toBeUndefined();
    expect(response.data?.[`delete_${catalog.resource}_by_pk`]).toMatchObject({ [catalog.idField]: id });
    await expect.poll(() => db[catalog.resource].some((row) => String(row[catalog.idField]) === String(id))).toBe(false);
}

function formItem(root: Page | Locator, label: string) {
    return root.locator('.ant-form-item').filter({ hasText: label }).first();
}

async function fillText(page: Page, id: string, value: string) {
    await fillTextIn(page, id, value);
}

async function fillTextIn(root: Page | Locator, id: string, value: string) {
    const input = root.locator(`#${id}`);
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

async function selectAntdOption(page: Page, formItemLocator: Locator, optionText: string) {
    await formItemLocator.locator('.ant-select').first().click();
    const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
    await dropdown.locator('.ant-select-item-option').filter({ hasText: optionText }).first().click();
}

async function settleNavigation(page: Page, previousUrl: string) {
    await expect(page).not.toHaveURL(previousUrl, { timeout: 5000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(100);
}
