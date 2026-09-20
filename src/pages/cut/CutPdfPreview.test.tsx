import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pdf = vi.hoisted(() => ({
  getDocument: vi.fn(), getPage: vi.fn(), render: vi.fn(), destroy: vi.fn(),
  getViewport: vi.fn(), worker: { workerSrc: '' },
}));
vi.mock('pdfjs-dist', () => ({ getDocument: pdf.getDocument, GlobalWorkerOptions: pdf.worker }));
vi.mock('antd', () => ({
  Alert: (props: any) => React.createElement('test-alert', props),
  Spin: () => null,
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Space: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  Typography: { Text: ({ children }: React.PropsWithChildren) => <span>{children}</span> },
}));
import { CutPdfPreview } from './CutPdfPreview';

let tree: ReactTestRenderer | undefined;
let canvases: Array<{ width: number; height: number; getContext: ReturnType<typeof vi.fn>; toBlob: ReturnType<typeof vi.fn> }>;
const revokeUrl = vi.fn();
const viewport = { width: 100.5, height: 200.25 };
beforeEach(() => {
  vi.clearAllMocks();
  canvases = [];
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  vi.stubGlobal('document', {
    createElement: vi.fn((tag: string) => {
      expect(tag).toBe('canvas');
      const canvas = { width: 0, height: 0, getContext: vi.fn(), toBlob: vi.fn((callback: BlobCallback) => callback(new Blob(['png']))) };
      canvas.getContext.mockReturnValue({ canvas });
      canvases.push(canvas);
      return canvas;
    }),
  });
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test-${canvases.length}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeUrl);
  pdf.render.mockImplementation(() => ({ promise: Promise.resolve() }));
  pdf.getViewport.mockReturnValue(viewport);
  pdf.getPage.mockImplementation(async () => ({ getViewport: pdf.getViewport, render: pdf.render }));
  pdf.destroy.mockResolvedValue(undefined);
  pdf.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 2, getPage: pdf.getPage, destroy: pdf.destroy }) });
});
afterEach(() => {
  if (tree) act(() => tree!.unmount());
  tree = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(blob: Blob | null = new Blob(['pdf']), loading = false, waitForCompletion = true) {
  await act(async () => { tree = create(<CutPdfPreview blob={blob} loading={loading} />); });
  if (blob && !loading) {
    await act(async () => {
      await vi.waitFor(() => expect(waitForCompletion ? pdf.destroy : pdf.render).toHaveBeenCalled(), { timeout: 5000 });
    });
  }
}

describe('cut PDF canvas contract', () => {
  it.each([1, 2])('passes the exact canvas and preserves DPR %i rendering', async ratio => {
    vi.stubGlobal('window', { devicePixelRatio: ratio });
    await mount();
    expect(pdf.getPage.mock.calls).toEqual([[1], [2]]);
    expect(pdf.getViewport).toHaveBeenCalledWith({ scale: 1.35 });
    expect(pdf.render).toHaveBeenCalledTimes(2);
    canvases.forEach((canvas, index) => {
      expect(canvas.width).toBe(Math.floor(viewport.width * ratio));
      expect(canvas.height).toBe(Math.floor(viewport.height * ratio));
      expect(pdf.render.mock.calls[index][0]).toEqual({
        canvas, canvasContext: canvas.getContext.mock.results[0].value, viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png');
    });
    expect(tree!.root.findAllByType('img').map(img => img.props.src)).toEqual(['blob:test-1', 'blob:test-2']);
    expect(pdf.destroy).toHaveBeenCalledOnce();
    act(() => tree!.unmount());
    tree = undefined;
    expect(revokeUrl.mock.calls).toEqual([['blob:test-1'], ['blob:test-2']]);
  });

  it('keeps zoom local without rerendering the PDF', async () => {
    await mount();
    act(() => tree!.root.findByProps({ 'data-testid': 'cut-pdf-preview-zoom-in' }).props.onClick());
    expect(tree!.root.findAllByType('img')[0].props.style.width).toBe('125%');
    expect(pdf.render).toHaveBeenCalledTimes(2);
  });

  it('releases completed pages and destroys the PDF after a rendering error', async () => {
    pdf.render.mockImplementationOnce(() => ({ promise: Promise.resolve() }))
      .mockImplementationOnce(() => ({ promise: Promise.reject(new Error('Тест ошибки PDF')) }));
    await mount();
    expect(tree!.root.findByType('test-alert').props.description).toBe('Тест ошибки PDF');
    expect(tree!.root.findAllByType('img')).toHaveLength(0);
    expect(revokeUrl.mock.calls).toEqual([['blob:test-1']]);
    expect(pdf.destroy).toHaveBeenCalledOnce();
  });

  it('revokes late preview URLs after unmount', async () => {
    let finish!: () => void;
    pdf.render.mockImplementationOnce(() => ({ promise: new Promise<void>(resolve => { finish = resolve; }) }));
    await mount(new Blob(['pdf']), false, false);
    act(() => tree!.unmount());
    tree = undefined;
    await act(async () => { finish(); });
    expect(revokeUrl.mock.calls).toEqual([['blob:test-1'], ['blob:test-2']]);
    expect(pdf.destroy).toHaveBeenCalledOnce();
  });

  it.each([[null, false], [new Blob(['pdf']), true]] as const)('does not load when blob=%s loading=%s', async (blob, loading) => {
    await mount(blob, loading);
    expect(pdf.getDocument).not.toHaveBeenCalled();
    expect(pdf.render).not.toHaveBeenCalled();
  });
});
