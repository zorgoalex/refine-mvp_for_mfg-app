import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeQrFromFile } from './qrScanner';

const { readBarcodes, prepareZXingModule } = vi.hoisted(() => ({
  readBarcodes: vi.fn(), prepareZXingModule: vi.fn(),
}));
vi.mock('zxing-wasm/reader', () => ({ readBarcodes, prepareZXingModule }));
vi.mock('zxing-wasm/reader/zxing_reader.wasm?url', () => ({ default: '/test-reader.wasm' }));

describe('file QR normalization boundary', () => {
  const camera = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    readBarcodes.mockResolvedValue([{ text: '  test-qr  ' }]);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: camera } });
  });
  afterEach(() => {
    expect(camera).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('recognizes BMP bytes despite a misleading EMF MIME type', async () => {
    const bytes = new Uint8Array([0x42, 0x4d, 1, 2, 3]);
    expect(await decodeQrFromFile(new Blob([bytes], { type: 'image/emf' }))).toBe('test-qr');
    const [blob, options] = readBarcodes.mock.calls[0];
    expect(blob.type).toBe('image/bmp');
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([...bytes]);
    expect(options).toEqual({ formats: ['QRCode'], maxNumberOfSymbols: 1 });
    const { locateFile } = prepareZXingModule.mock.calls[0][0].overrides;
    expect(locateFile('reader.wasm', '/')).toBe('/test-reader.wasm');
  });

  it('passes embedded EMF raster as BMP with exact pixel bytes', async () => {
    const emf = new Uint8Array(212);
    const view = new DataView(emf.buffer);
    view.setUint32(0, 1, true);
    view.setUint32(4, 88, true);
    emf.set([0x20, 0x45, 0x4d, 0x46], 40);
    view.setUint32(88, 81, true);
    view.setUint32(92, 124, true);
    [80, 40, 120, 4].forEach((n, i) => view.setUint32(136 + i * 4, n, true));
    view.setUint32(168, 40, true);
    emf.set([10, 20, 30, 40], 208);
    await decodeQrFromFile(new Blob([emf], { type: 'image/emf' }));
    const blob = readBarcodes.mock.calls[0][0] as Blob;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(blob.type).toBe('image/bmp');
    expect(bytes.length).toBe(58);
    expect([...bytes.slice(0, 2)]).toEqual([0x42, 0x4d]);
    expect([...bytes.slice(-4)]).toEqual([10, 20, 30, 40]);
  });

  it.each(['image/png', 'image/emf'])('preserves unconverted %s input identity', async (type) => {
    const file = new Blob([new Uint8Array([1, 2, 3])], { type });
    await decodeQrFromFile(file);
    expect(readBarcodes.mock.calls[0][0]).toBe(file);
  });

  it.each([[], [{ text: '  ' }]])('returns null without a nonempty QR result', async (result) => {
    readBarcodes.mockResolvedValue(result);
    expect(await decodeQrFromFile(new Blob())).toBeNull();
  });

  it('warns and returns null when decoding fails', async () => {
    const error = new Error('test decode failure');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readBarcodes.mockRejectedValue(error);
    expect(await decodeQrFromFile(new Blob())).toBeNull();
    expect(warn).toHaveBeenCalledWith('decodeQrFromFile failed:', error);
  });
});
