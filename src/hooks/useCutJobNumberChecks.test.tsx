import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cutApi } from '../api/cutApi';
import { useCutJobNumberChecks } from './useCutJobNumberChecks';

vi.mock('../api/cutApi', () => ({ cutApi: { list: vi.fn() } }));
const list = vi.mocked(cutApi.list);
let state: ReturnType<typeof useCutJobNumberChecks>;
let root: ReactTestRenderer;
function Harness(props: { selected: string[]; numbers: Record<string, number | null> }) {
  state = useCutJobNumberChecks(props.selected, props.numbers, true);
  return null;
}
function render(selected: string[], numbers: Record<string, number | null>) {
  act(() => {
    if (root) root.update(<Harness selected={selected} numbers={numbers} />);
    else root = create(<Harness selected={selected} numbers={numbers} />);
  });
}
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(301); }); }

describe('cut import number availability', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    list.mockReset().mockResolvedValue([]);
  });
  afterEach(() => {
    if (root) act(() => root.unmount());
    root = undefined!;
    vi.unstubAllGlobals(); vi.useRealTimers();
  });
  it('checks selected numbers only, excludes deleted jobs, and accepts auto immediately', async () => {
    render(['first'], { second: 42 });
    expect(state.ready).toBe(true);
    await settle();
    expect(list).not.toHaveBeenCalled();
    render(['first'], { first: 42 });
    expect(state.ready).toBe(false);
    await settle();
    expect(list).toHaveBeenCalledWith({ jobNumber: '42', includeArchived: false });
    expect(state.ready).toBe(true);
  });
  it('blocks duplicate selected numbers and fractional numbers without querying', async () => {
    render(['first', 'second'], { first: 42, second: 42 });
    expect(state.checks.first.status).toBe('error');
    await settle(); expect(list).not.toHaveBeenCalled();
    render(['first'], { first: 1.5 });
    expect(state.ready).toBe(false);
    render(['first'], { first: 42, second: 42 });
    await settle(); expect(state.ready).toBe(true);
  });
  it('blocks occupied numbers and retries transient check failures', async () => {
    list.mockResolvedValueOnce([{ displayNumber: '42', status: 'ready' } as never]);
    render(['first'], { first: 42 });
    await settle(); expect(state.checks.first.message).toContain('уже существует');
    expect(state.checks.first.suggestions).toEqual([43, 44, 45]);
    list.mockRejectedValueOnce(new Error('offline'));
    act(() => state.retry());
    await settle(); expect(state.checks.first.status).toBe('error');
    act(() => state.retry());
    await settle(); expect(state.ready).toBe(true);
  });
  it('ignores a stale response after the requested number changes', async () => {
    let resolve!: (jobs: never[]) => void;
    list.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    render(['first'], { first: 42 });
    await settle();
    render(['first'], { first: 43 });
    await act(async () => { resolve([]); });
    expect(state.ready).toBe(false);
    await settle(); expect(state.ready).toBe(true);
    expect(list).toHaveBeenLastCalledWith({ jobNumber: '43', includeArchived: false });
  });
});
