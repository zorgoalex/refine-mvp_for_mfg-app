import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ search: vi.fn(), history: vi.fn() }));
const auth = vi.hoisted(() => ({ generation: 1 }));
vi.mock('../../api/cncTelegramApi', () => ({
  cncTelegramApi: { searchMdfBoardHistoryOrders: api.search, mdfBoardHistory: api.history },
}));
vi.mock('../../api/authSession', () => ({ authSession: { getSessionGeneration: () => auth.generation } }));
vi.mock('antd', () => {
  const passthrough = (name: string) => ({ children }: { children?: React.ReactNode }) =>
    React.createElement(name, null, children);
  return {
    Alert: (props: { message?: React.ReactNode }) => React.createElement('mock-alert', null, props.message),
    Button: passthrough('button'), Empty: passthrough('mock-empty'), Select: passthrough('mock-select'),
    Skeleton: passthrough('mock-skeleton'), Tag: passthrough('mock-tag'),
    Typography: { Text: passthrough('span'), Title: passthrough('h3'), Paragraph: passthrough('p') },
  };
});
vi.mock('@ant-design/icons', () => {
  const Icon = () => null;
  return { BranchesOutlined: Icon, ClockCircleOutlined: Icon, CloseOutlined: Icon, DownOutlined: Icon,
    HistoryOutlined: Icon, SearchOutlined: Icon, UpOutlined: Icon };
});

import { MdfBoardHistoryPanel } from './MdfBoardHistoryPanel';

describe('MDF board history panel: session change', () => {
  beforeEach(() => {
    auth.generation = 1;
    api.search.mockReset().mockResolvedValue({ data: [] });
    api.history.mockReset();
    vi.stubGlobal('window', { setTimeout: (fn: () => void) => { fn(); return 0; }, clearTimeout: () => undefined });
  });
  afterEach(() => { vi.unstubAllGlobals(); auth.generation = 1; });

  it('never shows an order history answered under another auth session', async () => {
    let answer!: (value: unknown) => void;
    api.history.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }));
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<MdfBoardHistoryPanel boardDate="2026-11-02" collapsed={false} selectedOrderId={11556}
        selectedOrderNumber="3058" onCollapsedChange={() => undefined} onClose={() => undefined}
        onFocusCard={() => undefined} onSelectedOrderChange={() => undefined} />);
    });
    expect(api.history).toHaveBeenCalledTimes(1);
    auth.generation = 2; // permissions/scope changed while the history read was running
    await act(async () => { answer({ order: { orderId: 11556, orderName: 'E2E-СЕКРЕТНЫЙ-ЗАКАЗ' }, episodes: [], window: null,
      generatedAt: '2026-11-02T00:00:00Z', diagnosis: null, coverage: null }); });
    expect(JSON.stringify(view.toJSON())).not.toContain('E2E-СЕКРЕТНЫЙ-ЗАКАЗ');
    act(() => view.unmount());
  });
});
