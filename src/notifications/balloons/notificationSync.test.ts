import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTED_SYNC_MS, DISCONNECTED_SYNC_MS, startNotificationSync } from './notificationSync';

/** A controllable SSE response: push events, then end or fail. */
function sseResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }),
    send(event: string, data = '{}') { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`)); },
    fail() { controller.error(new DOMException('aborted', 'AbortError')); },
    end() { controller.close(); },
  };
}

const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

describe('startNotificationSync (plan part B)', () => {
  let visibility: () => void = () => undefined;
  let visible = true;
  beforeEach(() => { vi.useFakeTimers(); visible = true; });
  afterEach(() => vi.useRealTimers());

  const start = (openStream: (signal: AbortSignal) => Promise<Response>) => {
    const onSync = vi.fn();
    const sync = startNotificationSync({
      openStream, onSync, isVisible: () => visible,
      addVisibilityListener: (listener) => { visibility = listener; return () => { visibility = () => undefined; }; },
    });
    return { sync, onSync };
  };

  it('syncs on `hello` and on every `changed`; polls only every 5 minutes while connected', async () => {
    const stream = sseResponse();
    const { sync, onSync } = start(async () => stream.response);
    await flush();
    stream.send('hello');
    await flush();
    expect(sync.connected).toBe(true);
    expect(onSync).toHaveBeenCalledTimes(1);
    stream.send('changed');
    stream.send('changed');
    await flush();
    expect(onSync).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(DISCONNECTED_SYNC_MS);
    expect(onSync).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(CONNECTED_SYNC_MS - DISCONNECTED_SYNC_MS);
    expect(onSync).toHaveBeenCalledTimes(4);
    sync.stop();
  });

  it('a dropped stream re-syncs at once, polls every minute while down and reconnects with backoff (hello re-syncs)', async () => {
    const first = sseResponse();
    const second = sseResponse();
    const openStream = vi.fn().mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
    const { sync, onSync } = start(openStream);
    await flush();
    first.send('hello');
    await flush();
    first.end();
    await flush();
    expect(sync.connected).toBe(false);
    expect(onSync).toHaveBeenCalledTimes(2); // hello + catch-up after the drop
    await vi.advanceTimersByTimeAsync(2_000);
    expect(openStream).toHaveBeenCalledTimes(2);
    second.send('hello');
    await flush();
    expect(sync.connected).toBe(true);
    expect(onSync).toHaveBeenCalledTimes(3);
    sync.stop();
  });

  it('stream disabled on the server (204): polls every minute, re-checks the stream after 10 minutes', async () => {
    const openStream = vi.fn(async () => new Response(null, { status: 204 }));
    const { sync, onSync } = start(openStream);
    await flush();
    await vi.advanceTimersByTimeAsync(DISCONNECTED_SYNC_MS);
    expect(onSync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DISCONNECTED_SYNC_MS);
    expect(onSync).toHaveBeenCalledTimes(2);
    expect(openStream).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(openStream).toHaveBeenCalledTimes(2);
    sync.stop();
  });

  it('the poll skips a hidden tab; a return to the tab syncs and reconnects at once', async () => {
    const openStream = vi.fn().mockRejectedValueOnce(new TypeError('network')).mockResolvedValue(new Response(null, { status: 204 }));
    const { sync, onSync } = start(openStream);
    await flush();
    visible = false;
    await vi.advanceTimersByTimeAsync(DISCONNECTED_SYNC_MS);
    expect(onSync).not.toHaveBeenCalled();
    // the network error was retried after the backoff (2nd call, 204); a return to the tab syncs and connects again
    expect(openStream).toHaveBeenCalledTimes(2);
    visible = true;
    visibility();
    await flush();
    expect(onSync).toHaveBeenCalledTimes(1);
    expect(openStream).toHaveBeenCalledTimes(3);
    sync.stop();
  });

  it('server not listening (hello/listener listening:false) → 60-second fallback while the HTTP stream stays open', async () => {
    const stream = sseResponse();
    const { sync, onSync } = start(async () => stream.response);
    await flush();
    stream.send('hello', '{"listening":false}');
    await flush();
    expect(sync.connected).toBe(false);
    expect(onSync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DISCONNECTED_SYNC_MS);
    expect(onSync).toHaveBeenCalledTimes(2);
    stream.send('listener', '{"listening":true}');
    await flush();
    expect(sync.connected).toBe(true);
    await vi.advanceTimersByTimeAsync(DISCONNECTED_SYNC_MS);
    expect(onSync).toHaveBeenCalledTimes(2);
    stream.send('listener', '{"listening":false}');
    await flush();
    await vi.advanceTimersByTimeAsync(DISCONNECTED_SYNC_MS);
    expect(onSync).toHaveBeenCalledTimes(3);
    sync.stop();
  });

  it('stop() on a connected stream leaves no timer, also when the aborted read rejects later', async () => {
    const stream = sseResponse();
    const { sync, onSync } = start(async () => stream.response);
    await flush();
    stream.send('hello');
    await flush();
    sync.stop();
    stream.fail();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(CONNECTED_SYNC_MS * 2);
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it('stop() aborts the stream and timers: nothing syncs afterwards', async () => {
    const stream = sseResponse();
    let aborted = false;
    const { sync, onSync } = start(async (signal) => { signal.addEventListener('abort', () => { aborted = true; }); return stream.response; });
    await flush();
    sync.stop();
    expect(aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(CONNECTED_SYNC_MS * 2);
    expect(onSync).not.toHaveBeenCalled();
  });
});
