import React, { StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOwnedObjectUrlState } from './useOwnedObjectUrlState';

describe('preview object URL ownership', () => {
  afterEach(() => vi.restoreAllMocks());
  it('releases replaced and batched-away URLs only after the image commits its new src', () => {
    let replace!: (next: { url: string } | null) => void;
    let renderer: ReactTestRenderer;
    const revokedWhileReferenced: string[] = [];
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(url => {
      const image = renderer?.toJSON() as { props?: { src?: string } } | null;
      if (image?.props?.src === url) revokedWhileReferenced.push(url);
    });
    function Preview() {
      const [value, set] = useOwnedObjectUrlState<{ url: string }>(); replace = set;
      return value ? <img src={value.url} /> : null;
    }
    act(() => { renderer = create(<StrictMode><Preview /></StrictMode>); });
    act(() => replace({ url: 'blob:first' }));
    expect(revoke).not.toHaveBeenCalled();
    act(() => { replace({ url: 'blob:discarded' }); replace({ url: 'blob:last' }); });
    expect(revoke.mock.calls.flat()).toEqual(['blob:first', 'blob:discarded']);
    expect((renderer!.toJSON() as { props: { src: string } }).props.src).toBe('blob:last');
    act(() => replace(null));
    expect(revoke.mock.calls.flat()).toEqual(['blob:first', 'blob:discarded', 'blob:last']);
    expect(revokedWhileReferenced).toEqual([]);
    act(() => renderer!.unmount());
  });

  it('cleans up on unmount and rejects late asynchronous results without leaking URLs', () => {
    let replace!: (next: { url: string } | null) => void;
    let renderer: ReactTestRenderer;
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    function Preview() {
      const [value, set] = useOwnedObjectUrlState<{ url: string }>(); replace = set;
      return value ? <img src={value.url} /> : null;
    }
    act(() => { renderer = create(<Preview />); });
    act(() => replace({ url: 'blob:mounted' }));
    act(() => renderer!.unmount());
    act(() => replace({ url: 'blob:late' }));
    expect(revoke.mock.calls.flat()).toEqual(['blob:mounted', 'blob:late']);
  });
});
