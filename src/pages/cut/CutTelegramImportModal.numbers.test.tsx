import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CutTelegramImportModal } from './CutTelegramImportModal';

const mock = vi.hoisted(() => ({ value: null as any }));
vi.mock('../../hooks/useCncTelegramImport', () => ({ useCncTelegramImport: () => mock.value }));
vi.mock('../../hooks/useCutJobNumberChecks', () => ({ useCutJobNumberChecks: () => ({ ready: true, checks: {}, retry: vi.fn() }) }));
vi.mock('../../utils/permissions', () => ({ can: () => true }));
vi.mock('../../config/featureFlags', () => ({ featureFlags: { cncTelegram: true } }));
vi.mock('./svgCutRenderPreview', () => ({ buildStyledCutLayoutPreview: vi.fn() }));
vi.mock('antd', async () => {
  const React = await import('react');
  const box = (props: any) => React.createElement('div', null, props.children);
  const button = (props: any) => React.createElement('button', props, props.children);
  return {
    Alert: box, Button: button, Checkbox: box, DatePicker: { RangePicker: box }, Empty: box,
    InputNumber: (props: any) => React.createElement('input', props),
    Modal: (props: any) => props.open ? React.createElement('section', null, props.children, props.footer) : null,
    Pagination: box, Progress: box, Space: box, Spin: box, Steps: box, Tabs: box, Tag: box,
    Typography: { Text: box, Paragraph: box },
    message: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
  };
});
vi.mock('../../ui/tooltipDelay', async () => {
  const React = await import('react');
  return { Table: (props: any) => React.createElement('table', { 'data-selection': props.rowSelection },
    props.dataSource.map((candidate: any) => React.createElement('tr', { key: candidate.candidateId },
      props.columns.map((column: any) => React.createElement('td', { key: column.key }, column.render(null, candidate))),
    )),
  ) };
});

const first = '00000000-0000-4000-8000-000000000001';
const second = '00000000-0000-4000-8000-000000000002';
const candidates = [first, second].map((candidateId, index) => ({
  candidateId, svgFileName: `Тест-${index}.svg`, workday: '2026-09-05', sourceCreatedAt: '2026-09-05T00:00:00Z',
  sourceStatus: 'new', eligibility: 'eligible', matches: [], parserWarnings: [],
}));
let root: ReactTestRenderer;
const rerender = () => root.update(<CutTelegramImportModal open onClose={() => undefined} />);
const click = async (label: string) => {
  const button = root.root.findAllByType('button').find((node) => node.children.join('').includes(label));
  expect(button, label).toBeTruthy();
  await act(async () => { await button!.props.onClick(); });
};

describe('Telegram import number selection flow', () => {
  beforeEach(() => {
    mock.value = {
      scan: { scanId: 'scan-1', status: 'ready', progress: { daysTotal: 1, daysProcessed: 1 } },
      candidates, messages: [], messagePagination: { total: 0 }, prepared: null, importRequest: null,
      prepareImport: vi.fn().mockResolvedValue({}), prepareRepeat: vi.fn().mockResolvedValue({}),
      returnToSelection: vi.fn(() => { mock.value.prepared = null; mock.value.importRequest = null; rerender(); }),
    };
  });
  afterEach(() => { if (root) act(() => root.unmount()); });
  it('sends only selected number assignments and leaves other candidates on auto', async () => {
    act(() => { root = create(<CutTelegramImportModal open onClose={() => undefined} />); });
    act(() => {
      root.root.findByType('table').props['data-selection'].onChange([first, second]);
      root.root.findAllByType('input')[0].props.onChange(42);
    });
    await click('Подготовить создание');
    expect(mock.value.prepareImport).toHaveBeenCalledWith([first, second], { [first]: 42 });
  });
  it.each(['failed', 'completed'])('returns %s import to editable selection before preparing a repeat', async (status) => {
    mock.value.importRequest = {
      importRequestId: 'original', status, items: [{
        importItemId: 'item-1', candidateId: first, requestedCutJobId: 42,
        status: status === 'failed' ? 'failed' : 'imported', matches: [],
      }], totalCount: 1, importedCount: status === 'completed' ? 1 : 0, failedCount: status === 'failed' ? 1 : 0,
    };
    act(() => { root = create(<CutTelegramImportModal open onClose={() => undefined} />); });
    await click(status === 'completed' ? 'Создать ещё одну копию' : 'Повторить ошибки');
    expect(mock.value.prepareRepeat).not.toHaveBeenCalled();
    expect(root.root.findAllByType('input')[0].props.value).toBe(status === 'failed' ? 42 : null);
    act(() => root.root.findAllByType('input')[0].props.onChange(55));
    await click('Подготовить создание');
    expect(mock.value.prepareRepeat).toHaveBeenCalledWith('original', [first], { [first]: 55 });
  });
});
