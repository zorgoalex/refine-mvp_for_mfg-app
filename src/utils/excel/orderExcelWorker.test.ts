import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { build } = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock('./orderExcelBuilder', () => ({ buildOrderExcelBuffer: build }));

describe('order Excel worker response transport', () => {
  const params = { orderId: 123 };
  let received: unknown;
  let posted: unknown;
  let transfers: Transferable[] | undefined;
  let scope: { onmessage?: (event: { data: unknown }) => Promise<void>; postMessage: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.resetModules();
    build.mockReset();
    received = posted = transfers = undefined;
    scope = {
      postMessage: vi.fn((message, transfer) => {
        posted = message;
        transfers = transfer;
        received = structuredClone(message, { transfer });
      }),
    };
    vi.stubGlobal('self', scope);
    await import('./orderExcelWorker');
  });
  afterEach(() => vi.unstubAllGlobals());

  async function run(value: ArrayBuffer | ArrayBufferView) {
    build.mockResolvedValue(value);
    await scope.onmessage!({ data: { requestId: 'test-request', params } });
    expect(build).toHaveBeenCalledExactlyOnceWith(params);
    expect(scope.postMessage).toHaveBeenCalledOnce();
    expect(received).toEqual({ requestId: 'test-request', ok: true, buffer: expect.any(ArrayBuffer) });
    const response = received as { buffer: ArrayBuffer };
    expect(transfers).toHaveLength(1);
    expect(transfers![0]).toBe((posted as { buffer: ArrayBuffer }).buffer);
    expect((transfers![0] as ArrayBuffer).byteLength).toBe(0);
    return new Uint8Array(response.buffer);
  }

  it('transfers the original ArrayBuffer without another copy', async () => {
    const input = new Uint8Array([1, 2, 3]).buffer;
    expect([...await run(input)]).toEqual([1, 2, 3]);
    expect(transfers![0]).toBe(input);
    expect(input.byteLength).toBe(0);
  });

  it.each(['typed', 'data', 'shared'] as const)('copies only the byte range of a %s view', async (kind) => {
    const backing = kind === 'shared' ? new SharedArrayBuffer(8) : new ArrayBuffer(8);
    const bytes = new Uint8Array(backing);
    bytes.set([99, 98, 1, 2, 3, 4, 97, 96]);
    const input = kind === 'data' ? new DataView(backing, 2, 4) : new Uint8Array(backing, 2, 4);
    expect([...await run(input)]).toEqual([1, 2, 3, 4]);
    expect([...bytes]).toEqual([99, 98, 1, 2, 3, 4, 97, 96]);
  });

  it('copies raw bytes, not numeric elements of a wide typed array', async () => {
    const input = new Uint16Array([0x1234, 0xabcd]);
    const expected = [...new Uint8Array(input.buffer)];
    expect([...await run(input)]).toEqual(expected);
    expect(input.byteLength).toBe(4);
  });

  it('transfers an empty view as an empty ordinary ArrayBuffer', async () => {
    expect([...await run(new Uint8Array(new SharedArrayBuffer(4), 2, 0))]).toEqual([]);
  });

  it.each([new TypeError('test failure'), 'test failure'])('serializes builder rejection: %s', async (error) => {
    build.mockRejectedValue(error);
    await scope.onmessage!({ data: { requestId: 'test-error', params } });
    expect(received).toEqual({ requestId: 'test-error', ok: false, error: {
      name: error instanceof Error ? error.name : 'Error', message: 'test failure',
    } });
    expect(transfers).toBeUndefined();
    expect(scope.postMessage).toHaveBeenCalledOnce();
  });
});
