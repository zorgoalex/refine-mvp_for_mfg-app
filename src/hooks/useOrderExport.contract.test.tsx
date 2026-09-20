import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getOne: vi.fn(), getList: vi.fn(), upload: vi.fn(), backend: vi.fn(),
  success: vi.fn(), error: vi.fn(),
  flags: { useBackendOrderExport: false, sheetMaterialsReads: true },
}));
vi.mock('@refinedev/core', () => ({ useDataProvider: () => () => mocks }));
vi.mock('antd', () => ({ message: { success: mocks.success, error: mocks.error } }));
vi.mock('../config/featureFlags', () => ({ featureFlags: mocks.flags }));
vi.mock('../api/exportApi', () => ({ exportApi: { exportOrderToGoogleDrive: mocks.backend } }));
vi.mock('../utils/excel/uploadToApi', () => ({ uploadOrderExcelToApi: mocks.upload, handleUploadError: () => 'test error' }));
import { useOrderExport } from './useOrderExport';

describe('order export query and payload contract', () => {
  let renderer: ReactTestRenderer;
  let hook: ReturnType<typeof useOrderExport>;
  let lists: Record<string, object[]>;
  const order = { order_id: 42, order_name: 'Тест заказ', order_date: '2026-09-20' };
  function Harness() { hook = useOrderExport(); return null; }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.flags.useBackendOrderExport = false;
    lists = {
      orders_view: [{ material_name: 'Тест лист', total_area: 2, order_status_name: 'Новый' }],
      order_details: [{ detail_id: 5, height: 100, width: 200, quantity: 2, note: 'Тест', material_id: 8, milling_type_id: 9, edge_type_id: 10, film_id: 11 }],
      payments: [{ payment_id: 6, type_paid_id: 7, payment_date: '2026-09-20', amount: 123 }],
      order_details_view: [{ detail_id: 5, material_name: 'Тест resolved' }],
      client_phones: [{ phone_number: '+7 (701) 123-45-67', is_primary: true }],
      materials: [{ material_id: 8, material_name: 'Тест legacy' }],
      milling_types: [{ milling_type_id: 9, milling_type_name: 'Тест фреза' }],
      edge_types: [{ edge_type_id: 10, edge_type_name: 'Тест кромка' }],
      films: [{ film_id: 11, film_name: 'Тест плёнка' }],
      payment_types: [{ type_paid_id: 7, type_paid_name: 'Тест оплата' }],
    };
    mocks.getList.mockImplementation(async ({ resource }) => ({ data: lists[resource] ?? [] }));
    mocks.getOne.mockImplementation(async ({ resource }) => ({ data: resource === 'orders'
      ? { ...order, client_id: 3, total_amount: 250, notes: 'Тест сохранённое поле', order_doweling_links: [{ doweling_order: { doweling_order_name: 'Тест присадка', design_engineer_id: 4 } }] }
      : resource === 'clients' ? { client_name: 'Тест клиент' } : { full_name: 'Тест конструктор' } }));
    mocks.upload.mockResolvedValue({ success: true });
    mocks.backend.mockResolvedValue({ success: true, fileName: 'backend.xlsx' });
    await act(async () => { renderer = create(<Harness />); });
  });
  afterEach(async () => { await act(async () => renderer.unmount()); vi.restoreAllMocks(); });

  async function run() { await act(async () => { await hook.exportToDrive(order); }); expect(hook.isUploading).toBe(false); }

  it('preserves full order, view metadata, relations, mapped rows, payment and filename', async () => {
    await run();
    expect(mocks.getOne).toHaveBeenCalledWith({ resource: 'orders', id: 42 });
    expect(mocks.upload).toHaveBeenCalledOnce();
    const payload = mocks.upload.mock.calls[0][0];
    expect(payload.order).toMatchObject({ ...order, client_id: 3, total_amount: 250, notes: 'Тест сохранённое поле',
      _viewData: { total_area: 2, material_name: 'Тест лист', order_status_name: 'Новый', payment_status_name: '', issue_date: null },
      _exportData: { prisadkaName: 'Тест присадка', prisadkaDesignerName: 'Тест конструктор' },
    });
    expect(payload.details).toEqual([expect.objectContaining({ detail_id: 5, length: 100, width: 200, quantity: 2, notes: 'Тест',
      material: { material_name: 'Тест resolved' }, milling_type: { milling_type_name: 'Тест фреза' },
      edge_type: { edge_type_name: 'Тест кромка' }, film: { film_name: 'Тест плёнка' } })]);
    expect(payload.payments).toEqual([{ payment_id: 6, type_paid_id: 7, payment_date: '2026-09-20', amount: 123, payment_type: { payment_type_name: 'Тест оплата' } }]);
    expect(payload.client).toEqual({ client_name: 'Тест клиент' });
    expect(payload.clientPhone).toBe('8 701 123 4567');
    expect(payload.fileName).toBe('заказ-Ф26-42-Тест-заказ-Тест-клиент.xlsx');
    expect(mocks.success).toHaveBeenCalledOnce();
  });

  it('exports a header-only sheet order', async () => {
    lists.order_details = [];
    await run();
    expect(mocks.upload.mock.calls[0][0].details).toEqual([]);
  });

  it('skips a genuinely empty order', async () => {
    lists.order_details = []; lists.orders_view = [];
    await run();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('uses only the backend export path when enabled', async () => {
    mocks.flags.useBackendOrderExport = true;
    await run();
    expect(mocks.backend).toHaveBeenCalledExactlyOnceWith(42, { format: 'xlsx' });
    expect(mocks.getOne).not.toHaveBeenCalled(); expect(mocks.getList).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('reports a failed optional upload without throwing or staying busy', async () => {
    mocks.upload.mockRejectedValue(new Error('test upload failure'));
    await run();
    expect(mocks.error).toHaveBeenCalledWith('Не удалось выгрузить в Google Drive: test error');
    expect(mocks.success).not.toHaveBeenCalled();
  });
});
