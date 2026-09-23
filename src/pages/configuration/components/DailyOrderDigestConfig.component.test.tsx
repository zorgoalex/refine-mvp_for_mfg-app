import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DailyOrderDigestConfig } from './DailyOrderDigestConfig';
import { authSession } from '../../../api/authSession';

const mockApi = vi.hoisted(() => ({
  settings: vi.fn(), saveSettings: vi.fn(), preview: vi.fn(), send: vi.fn(),
  runs: vi.fn(), run: vi.fn(), pageImage: vi.fn(), retry: vi.fn(),
}));
const pendingSessionStorage = new Map<string, string>();

const mockForm = {
  values: {} as Record<string, any>,
  resetFields() { this.values = {}; },
  setFieldsValue(values: Record<string, unknown>) { this.values = { ...this.values, ...values }; },
  getFieldValue(name: string) { return this.values[name]; },
  isFieldsTouched() { return false; },
};

vi.mock('../../../api/dailyOrderDigestApi', () => ({ dailyOrderDigestApi: mockApi }));
vi.mock('../../../config/featureFlags', () => ({ featureFlags: { useBackendWhatsApp: true } }));
vi.mock('@ant-design/icons', () => ({ ReloadOutlined: () => null, SendOutlined: () => null }));
vi.mock('antd', () => {
  const primitive = (tag: string) => (props: Record<string, unknown>) => React.createElement(tag, props, props.children as React.ReactNode);
  const Form = Object.assign(({ children }: { children?: React.ReactNode }) => React.createElement('form', null, children), {
    Item: primitive('div'),
    useForm: () => [mockForm],
    useWatch: (name: unknown, form: typeof mockForm) => typeof name === 'string' ? form.values[name] : form.values,
  });
  return {
    Alert: primitive('aside'), Button: primitive('button'), Card: primitive('section'), Checkbox: primitive('input'),
    Form, Input: primitive('input'), InputNumber: primitive('input'), Select: primitive('select'),
    Space: primitive('div'), Spin: primitive('span'), Switch: primitive('button'),
    Tag: primitive('span'), TimePicker: primitive('input'),
    Table: (props: Record<string, any>) => React.createElement('div', null,
      ...(props.dataSource as Record<string, unknown>[]).map((row, rowIndex) => React.createElement('div', { key: rowIndex },
        ...(props.columns as Array<Record<string, any>>).map((column, columnIndex) => React.createElement('span', { key: columnIndex },
          column.render ? column.render(row[column.dataIndex as string], row, rowIndex) : String(row[column.dataIndex as string] ?? '')))))),
    Typography: { Paragraph: primitive('p'), Text: primitive('span'), Title: primitive('h4') },
    Modal: (props: Record<string, any>) => props.open
      ? React.createElement('div', { 'data-testid': 'modal' },
          React.createElement('button', { 'data-testid': 'modal-cancel', onClick: props.onCancel }, props.cancelText),
          React.createElement('button', { 'data-testid': 'modal-ok', onClick: props.onOk }, props.okText),
          props.children)
      : null,
    message: { success: vi.fn() },
  };
});

let tree: ReactTestRenderer | undefined;
const settingsEnvelope = {
  settings: {
    version: 4, enabled: false, groupChatId: '123456789@g.us', sendTime: '08:45', timeZone: 'Asia/Almaty' as const,
    catchUpPolicy: 'until_deadline' as const, catchUpDeadline: '10:00', cardsPerMessage: 2 as const, partialPolicy: 'remaining' as const,
  },
  runtime: { enabled: true, relayAvailable: true, unavailableReason: null },
};

function user(id: string) {
  return { id, username: `user-${id}`, role: 'admin', permissions: [
    'whatsapp.manage', 'calendar.view', 'orders.view', 'orders.view_financials',
  ] } as const;
}

function button(label: string) {
  return tree!.root.findAllByType('button').find((node) => node.children.join('') === label);
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  mockForm.resetFields();
  pendingSessionStorage.clear();
  vi.clearAllMocks();
  vi.stubGlobal('window', {
    setInterval: vi.fn(() => 1), clearInterval: vi.fn(),
    sessionStorage: {
      getItem: (key: string) => pendingSessionStorage.get(key) ?? null,
      setItem: (key: string, value: string) => { pendingSessionStorage.set(key, value); },
      removeItem: (key: string) => { pendingSessionStorage.delete(key); },
    },
  });
  vi.stubGlobal('document', { visibilityState: 'visible' });
  mockApi.settings.mockResolvedValue(settingsEnvelope);
  mockApi.runs.mockResolvedValue({ runs: [] });
  authSession.setUser({ id: 'digest-admin', username: 'digest-admin', role: 'admin', permissions: [
    'whatsapp.manage', 'calendar.view', 'orders.view', 'orders.view_financials',
  ] });
});

afterEach(() => {
  if (tree) act(() => tree!.unmount());
  tree = undefined;
  authSession.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('DailyOrderDigestConfig rendered flow', () => {
  it('keeps preview available while automation is off and reuses the send key after a network failure', async () => {
    mockApi.preview.mockResolvedValue({
      businessDate: '2026-09-23', orderCount: 3, totalArea: 8.25, empty: false,
      pages: [{ pageIndex: 1, imageDataUrl: 'data:image/png;base64,preview', orderIds: [1, 2] }],
    });
    mockApi.send.mockRejectedValueOnce(new Error('network timeout')).mockResolvedValueOnce({ run: { id: 'run-1' } });

    await act(async () => { tree = create(<DailyOrderDigestConfig />); await settle(); });
    const cardsSelect = tree!.root.findAllByType('select').find((node) =>
      Array.isArray(node.props.options) && node.props.options.some((option: { value: number }) => option.value === 1));
    expect(cardsSelect?.props.options).toEqual([
      { value: 1, label: '1 карточка' },
      { value: 2, label: '2 карточки' },
    ]);
    expect(tree!.root.findAllByType('div').some((node) => String(node.props.extra).includes('исходного запуска'))).toBe(true);
    expect(button('Предпросмотр')?.props.disabled).toBe(false);
    expect(button('Отправить сейчас')?.props.disabled).toBe(true);

    await act(async () => { button('Предпросмотр')?.props.onClick(); await settle(); });
    expect(tree!.root.findAllByType('img').length).toBe(1);
    expect(button('Отправить сейчас')?.props.disabled).toBe(false);

    await act(async () => { button('Отправить сейчас')?.props.onClick(); });
    const confirm = () => tree!.root.findByProps({ 'data-testid': 'modal-ok' });
    await act(async () => { confirm().props.onClick(); await settle(); });
    const firstKey = mockApi.send.mock.calls[0][0].idempotencyKey;
    await act(async () => { confirm().props.onClick(); await settle(); });
    expect(mockApi.send).toHaveBeenCalledTimes(2);
    expect(mockApi.send.mock.calls[0][0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(mockApi.send.mock.calls[1][0].idempotencyKey).toBe(firstKey);
  });

  it('reuses the original send command after cancel, settings refresh, and a refreshed preview', async () => {
    const refreshedSettings = {
      ...settingsEnvelope,
      settings: { ...settingsEnvelope.settings, version: 5 },
    };
    mockApi.preview.mockResolvedValueOnce({
      businessDate: '2026-09-23', orderCount: 3, totalArea: 8.25, empty: false,
      pages: [{ pageIndex: 1, imageDataUrl: 'data:image/png;base64,first', orderIds: [1, 2] }],
    }).mockResolvedValueOnce({
      businessDate: '2026-09-23', orderCount: 4, totalArea: 11, empty: false,
      pages: [{ pageIndex: 1, imageDataUrl: 'data:image/png;base64,second', orderIds: [3, 4] }],
    });
    mockApi.send.mockRejectedValueOnce(new Error('network timeout')).mockResolvedValueOnce({ run: { id: 'run-1' } });

    await act(async () => { tree = create(<DailyOrderDigestConfig />); await settle(); });
    await act(async () => { button('Предпросмотр')?.props.onClick(); await settle(); });
    await act(async () => { button('Отправить сейчас')?.props.onClick(); });
    const confirm = () => tree!.root.findByProps({ 'data-testid': 'modal-ok' });
    await act(async () => { confirm().props.onClick(); await settle(); });
    const originalPayload = { ...mockApi.send.mock.calls[0][0] };

    await act(async () => { tree!.root.findByProps({ 'data-testid': 'modal-cancel' }).props.onClick(); });
    mockApi.settings.mockResolvedValue(refreshedSettings);
    await act(async () => { button('Обновить')?.props.onClick(); await settle(); });
    await act(async () => { button('Предпросмотр')?.props.onClick(); await settle(); });
    expect(tree!.root.findAllByType('img')[0]?.props.src).toBe('data:image/png;base64,second');

    await act(async () => { button('Отправить сейчас')?.props.onClick(); });
    await act(async () => { confirm().props.onClick(); await settle(); });
    expect(mockApi.send).toHaveBeenCalledTimes(2);
    expect(mockApi.send.mock.calls[1][0]).toEqual(originalPayload);
    expect(mockApi.send.mock.calls[1][0].settingsVersion).toBe(4);
    expect(pendingSessionStorage.size).toBe(0);
  });

  it('isolates an uncertain send by user across logout/login and restores it only for its owner', async () => {
    const previewResponse = {
      businessDate: '2026-09-23', orderCount: 2, totalArea: 5, empty: false,
      pages: [{ pageIndex: 1, imageDataUrl: 'data:image/png;base64,preview', orderIds: [1, 2] }],
    };
    mockApi.preview.mockResolvedValue(previewResponse);
    mockApi.send.mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce({ run: { id: 'run-b' } })
      .mockResolvedValueOnce({ run: { id: 'run-a' } });
    authSession.setUser(user('101'));

    await act(async () => { tree = create(<DailyOrderDigestConfig />); await settle(); });
    await act(async () => { button('Предпросмотр')?.props.onClick(); await settle(); });
    await act(async () => { button('Отправить сейчас')?.props.onClick(); });
    const confirm = () => tree!.root.findByProps({ 'data-testid': 'modal-ok' });
    await act(async () => { confirm().props.onClick(); await settle(); });
    const actorARequest = { ...mockApi.send.mock.calls[0][0] };
    const actorAStorageKey = 'daily-order-digest.pending-manual-send.v1:101';
    expect(pendingSessionStorage.has(actorAStorageKey)).toBe(true);
    await act(async () => { tree!.root.findByProps({ 'data-testid': 'modal-cancel' }).props.onClick(); });
    await act(async () => { tree!.unmount(); });
    tree = undefined;

    await act(async () => {
      authSession.clear();
      authSession.setUser(user('202'));
      tree = create(<DailyOrderDigestConfig />);
      await settle();
    });
    await act(async () => { button('Предпросмотр')?.props.onClick(); await settle(); });
    await act(async () => { button('Отправить сейчас')?.props.onClick(); });
    await act(async () => { confirm().props.onClick(); await settle(); });
    const actorBRequest = mockApi.send.mock.calls[1][0];
    expect(actorBRequest.idempotencyKey).not.toBe(actorARequest.idempotencyKey);
    expect(pendingSessionStorage.has(actorAStorageKey)).toBe(true);

    await act(async () => { tree!.unmount(); });
    tree = undefined;
    await act(async () => {
      authSession.clear();
      authSession.setUser(user('101'));
      tree = create(<DailyOrderDigestConfig />);
      await settle();
    });
    expect(button('Отправить сейчас')?.props.disabled).toBe(false);
    await act(async () => { button('Отправить сейчас')?.props.onClick(); });
    await act(async () => { confirm().props.onClick(); await settle(); });
    expect(mockApi.send).toHaveBeenCalledTimes(3);
    expect(mockApi.send.mock.calls[2][0]).toEqual(actorARequest);
    expect(pendingSessionStorage.has(actorAStorageKey)).toBe(false);
  });

  it('does not offer manual send for an empty preview', async () => {
    mockApi.preview.mockResolvedValue({ businessDate: '2026-09-23', orderCount: 0, totalArea: 0, pages: [], empty: true });
    await act(async () => { tree = create(<DailyOrderDigestConfig />); await settle(); });
    await act(async () => { button('Предпросмотр')?.props.onClick(); await settle(); });
    expect(button('Отправить сейчас')?.props.disabled).toBe(true);
    expect(tree!.root.findAllByType('aside').some((node) => String(node.props.message).includes('На выбранную дату заказов нет'))).toBe(true);
  });

  it('immediately clears financial preview and history when the same user loses financial permission', async () => {
    mockApi.preview.mockResolvedValue({
      businessDate: '2026-09-23', orderCount: 2, totalArea: 98.75, empty: false,
      pages: [{ pageIndex: 1, imageDataUrl: 'data:image/png;base64,private-preview', orderIds: [31, 32] }],
    });
    const historyRun = {
      id: 'run-private', businessDate: '2026-09-23', kind: 'manual', state: 'sent', orderCount: 2,
      totalArea: 98.75, sentPageCount: 1, pageCount: 1, destinationMasked: '1234…@g.us',
    };
    mockApi.runs.mockResolvedValue({ runs: [historyRun] });
    mockApi.run.mockResolvedValue({
      run: historyRun,
      pages: [{
        pageIndex: 1, orderIds: [31, 32], state: 'sent', attemptCount: 1, sentAt: null,
        imageAvailable: true, expiresAt: '2099-09-23T00:00:00.000Z',
      }],
    });

    await act(async () => { tree = create(<DailyOrderDigestConfig />); await settle(); });
    await act(async () => { button('Предпросмотр')?.props.onClick(); await settle(); });
    await act(async () => { button('Подробности')?.props.onClick(); await settle(); });
    expect(tree!.root.findAllByType('img')).toHaveLength(1);
    expect(tree!.root.findAll((node) => node.children.join('').includes('98,75 кв.м.')).length).toBeGreaterThan(0);
    expect(tree!.root.findAllByType('button').length).toBeGreaterThan(0);

    const requestCounts = [mockApi.settings.mock.calls.length, mockApi.runs.mock.calls.length, mockApi.preview.mock.calls.length, mockApi.run.mock.calls.length];
    await act(async () => {
      authSession.setUser({
        id: 'digest-admin', username: 'digest-admin', role: 'admin',
        permissions: ['whatsapp.manage', 'calendar.view', 'orders.view'],
      });
      await settle();
    });

    expect(tree!.root.findAllByType('aside')).toHaveLength(1);
    expect(tree!.root.findAllByType('img')).toHaveLength(0);
    expect(tree!.root.findAllByType('button')).toHaveLength(0);
    expect(tree!.root.findAll((node) => node.children.join('').includes('98,75 кв.м.'))).toHaveLength(0);
    expect([mockApi.settings.mock.calls.length, mockApi.runs.mock.calls.length, mockApi.preview.mock.calls.length, mockApi.run.mock.calls.length]).toEqual(requestCounts);
  });
});
