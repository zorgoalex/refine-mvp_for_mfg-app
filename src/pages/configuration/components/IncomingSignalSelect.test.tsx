import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inboundSignalsApi, type SignalOption } from '../../../api/inboundSignalsApi';
import { IncomingSignalSelect } from './IncomingSignalSelect';

vi.mock('../../../api/inboundSignalsApi', () => ({ inboundSignalsApi: { signalOptions: vi.fn() } }));
vi.mock('antd', () => ({
  Select: (props: Record<string, unknown>) => React.createElement('select', props),
  Button: (props: Record<string, unknown>) => React.createElement('button', props),
  Space: (props: Record<string, unknown>) => React.createElement('div', props),
  Alert: (props: Record<string, unknown>) => React.createElement('aside', props),
  Typography: { Text: (props: Record<string, unknown>) => React.createElement('span', props) },
}));

const options = [{ code: 'goods.ready', name: 'Тест: заказ готов' }, { code: 'goods.packed', name: 'Тест: упакован' }];
const load = vi.mocked(inboundSignalsApi.signalOptions);
let tree: ReactTestRenderer | undefined;
const selected = () => tree!.root.findByType('select');
const notices = () => tree!.root.findAllByType('aside').map(node => node.props.message).join(' ');
async function mount(value: string[] = [], onChange = vi.fn()) {
  await act(async () => { tree = create(<IncomingSignalSelect value={value} onChange={onChange} />); });
}
beforeEach(() => { vi.clearAllMocks(); load.mockResolvedValue(options); });
afterEach(() => { act(() => tree?.unmount()); tree = undefined; });

describe('IncomingSignalSelect', () => {
  it('loads the signal catalog and selects multiple codes by searchable names, not free-text tags', async () => {
    const change = vi.fn(); await mount([], change);
    expect(load).toHaveBeenCalledOnce();
    expect(selected().props).toMatchObject({ mode: 'multiple', showSearch: true, optionFilterProp: 'label', disabled: false });
    expect(selected().props.options).toEqual(options.map(s => ({ value: s.code, label: `${s.name} (${s.code})` })));
    act(() => selected().props.onChange(['goods.ready','goods.packed']));
    expect(change).toHaveBeenCalledWith(['goods.ready','goods.packed']);
  });
  it('shows loading separately from an empty catalog', async () => {
    let resolve!: (value: SignalOption[]) => void;
    load.mockReturnValue(new Promise(done => { resolve = done; }));
    await mount();
    expect(selected().props).toMatchObject({ loading: true, disabled: true });
    expect(notices()).toBe('');
    await act(async () => resolve([]));
    expect(selected().props.loading).toBe(false);
    expect(notices()).toContain('Сначала добавьте и сохраните сигналы');
  });
  it('shows failure and retries without silently clearing existing selections', async () => {
    load.mockRejectedValueOnce(new Error('private upstream error'));
    const change = vi.fn(); await mount(['goods.ready'], change);
    expect(notices()).toContain('Не удалось загрузить список сигналов');
    expect(notices()).not.toContain('private upstream error');
    expect(selected().props.value).toEqual(['goods.ready']);
    expect(selected().props.disabled).toBe(true);
    await act(async () => tree!.root.findByType('button').props.onClick());
    expect(notices()).toBe('');
    expect(selected().props.disabled).toBe(false);
    expect(change).not.toHaveBeenCalled();
  });
  it('keeps removed codes visible until explicitly removed, then drops the fallback option', async () => {
    const change = vi.fn(); await mount(['retired.signal'], change);
    expect(notices()).toContain('В справочнике больше нет выбранных сигналов: retired.signal');
    expect(selected().props.options).toContainEqual({ value: 'retired.signal', label: 'retired.signal — нет в справочнике' });
    expect(change).not.toHaveBeenCalled();
    await act(async () => tree!.update(<IncomingSignalSelect value={[]} onChange={change} />));
    expect(selected().props.options.map((option: { value: string }) => option.value)).not.toContain('retired.signal');
  });
  it('reloads newly saved catalog entries', async () => {
    await mount();
    load.mockResolvedValue([{ code: 'new.signal', name: 'Тест: новый сигнал' }]);
    await act(async () => tree!.root.findByType('button').props.onClick());
    expect(selected().props.options).toEqual([{ value: 'new.signal', label: 'Тест: новый сигнал (new.signal)' }]);
  });
});
