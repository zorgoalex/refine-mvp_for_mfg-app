import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSvgUploadDetailValidation } from './useSvgUploadDetailValidation';
import type { EligibleDetailDto } from '../../api/types/cutApi.types';

const { preview } = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock('../../api/cutApi', () => ({ cutApi: { listEligibleDetailsPreview: preview } }));
function deferred() {
  let resolve!: (value: { details: EligibleDetailDto[] }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ details: EligibleDetailDto[] }>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
type Props = Parameters<typeof useSvgUploadDetailValidation>[0];
type Result = ReturnType<typeof useSvgUploadDetailValidation>;
let renderer: ReactTestRenderer | undefined;
const renders: Result[] = [];
function Probe(props: Props) {
  renders.push(useSvgUploadDetailValidation(props));
  return null;
}
function render(props: Props) {
  renders.length = 0;
  act(() => {
    if (renderer) renderer.update(<Probe {...props} />);
    else renderer = create(<Probe {...props} />);
  });
}
const last = () => renders[renders.length - 1];
const oldDetails = [{ orderName: '2895' }] as EligibleDetailDto[];
const allDetails = [{ orderName: '2895' }, { orderName: '2900' }] as EligibleDetailDto[];
const oldScope: Props = { enabled: true, sourceKey: 'old-svg', orderIds: [1, 2, 3, 4, 5, 6] };

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined;
  preview.mockReset();
});

describe('SVG detail validation scope', () => {
  it('waits for source-order lookup before validating a new SVG against seven orders', async () => {
    preview.mockResolvedValueOnce({ details: oldDetails });
    render(oldScope);
    await act(async () => {});
    expect(last()).toEqual({ status: 'ready', details: oldDetails });
    render({ ...oldScope, enabled: false, sourceKey: 'new-svg' });
    expect(renders.every(r => r.status === 'idle' && r.details.length === 0)).toBe(true);
    expect(preview).toHaveBeenCalledTimes(1);
    const next = deferred(); preview.mockReturnValueOnce(next.promise);
    render({ enabled: true, sourceKey: 'new-svg', orderIds: [1, 2, 3, 4, 5, 6, 7] });
    expect(renders.every(r => r.status === 'loading' && r.details.length === 0)).toBe(true);
    expect(preview).toHaveBeenLastCalledWith({ orderIds: [1, 2, 3, 4, 5, 6, 7] });
    await act(async () => next.resolve({ details: allDetails }));
    expect(last()).toEqual({ status: 'ready', details: allDetails });
  });

  it.each([
    { ...oldScope, sourceKey: 'new-svg' },
    { ...oldScope, orderIds: [1, 2, 3, 4, 5, 6, 7] },
  ])('invalidates cached details in the first render when the scope changes: %j', async nextScope => {
    preview.mockResolvedValueOnce({ details: oldDetails });
    render(oldScope);
    await act(async () => {});
    preview.mockReturnValueOnce(deferred().promise);
    render(nextScope);
    expect(renders.every(r => r.status === 'loading' && r.details.length === 0)).toBe(true);
  });

  it('ignores an older request that completes after the current request', async () => {
    const old = deferred(), next = deferred();
    preview.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    render(oldScope);
    render({ ...oldScope, sourceKey: 'new-svg' });
    await act(async () => next.resolve({ details: allDetails }));
    await act(async () => old.resolve({ details: oldDetails }));
    expect(last()).toEqual({ status: 'ready', details: allDetails });
  });

  it('reports request failure separately from successful empty results', async () => {
    const request = deferred(); preview.mockReturnValueOnce(request.promise);
    render(oldScope);
    await act(async () => request.reject(new Error('network failed')));
    expect(last()).toEqual({ status: 'error', details: [] });
    preview.mockResolvedValueOnce({ details: [] });
    render({ ...oldScope, sourceKey: 'another-svg' });
    await act(async () => {});
    expect(last()).toEqual({ status: 'ready', details: [] });
  });

  it('discards a disabled request and fetches again when the same scope reopens', async () => {
    const old = deferred(); preview.mockReturnValueOnce(old.promise);
    render(oldScope);
    render({ ...oldScope, enabled: false });
    await act(async () => old.resolve({ details: oldDetails }));
    expect(last()).toEqual({ status: 'idle', details: [] });
    preview.mockResolvedValueOnce({ details: allDetails });
    render(oldScope);
    expect(renders.every(r => r.status === 'loading')).toBe(true);
    await act(async () => {});
    expect(last()).toEqual({ status: 'ready', details: allDetails });
  });
});
