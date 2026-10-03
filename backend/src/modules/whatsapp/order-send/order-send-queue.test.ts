import { describe, expect, it } from 'vitest';
import { estimateQueue, type QueueRow } from './order-send-queue';

const now = new Date('2026-10-03T10:00:00Z');
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
const row = (id: string, created: number, overrides: Partial<QueueRow> = {}): QueueRow => ({
  send_id: id, state: 'queued', created_at: at(created), next_attempt_at: at(created), queue_expires_at: at(created + 24 * 60), send_started_at: null,
  ...overrides,
});
const minutes = (date: Date | undefined) => (date ? (date.getTime() - now.getTime()) / 60_000 : null);

describe('estimateQueue', () => {
  it('FIFO behind the gate: each next send one threshold plus half the window later', () => {
    const settings = { last_delivery_at: at(-2), next_delivery_at: at(4), min_interval_minutes: 5, send_window_minutes: 2 };
    const result = estimateQueue(settings, [row('b', -1), row('a', -3), row('c', 0)], now);
    expect(['a', 'b', 'c'].map((id) => result.get(id)?.position)).toEqual([1, 2, 3]);
    expect(['a', 'b', 'c'].map((id) => minutes(result.get(id)?.estimatedAt))).toEqual([4, 10, 16]);
  });

  it('an overdue gate means now; a sending one is its start', () => {
    const settings = { last_delivery_at: at(-60), next_delivery_at: null, min_interval_minutes: 5, send_window_minutes: 0 };
    const result = estimateQueue(settings, [row('s', -2, { state: 'sending', send_started_at: at(-1) }), row('q', -1)], now);
    expect(minutes(result.get('s')?.estimatedAt)).toBe(-1);
    expect(result.get('q')).toMatchObject({ position: 2, mayExpire: false });
    expect(minutes(result.get('q')?.estimatedAt)).toBe(0);
  });

  it('a send that expires before its turn takes no slot (the review example: 24 h threshold)', () => {
    const settings = { last_delivery_at: at(-22 * 60), next_delivery_at: null, min_interval_minutes: 24 * 60, send_window_minutes: 0 };
    // The gate is in 2 hours; A expires in 1 hour, B in 3 hours.
    const result = estimateQueue(settings, [row('a', -23 * 60, { queue_expires_at: at(60) }), row('b', -21 * 60, { queue_expires_at: at(180) })], now);
    expect(result.get('a')).toMatchObject({ mayExpire: true });
    expect(result.get('b')).toMatchObject({ mayExpire: false });
    expect(minutes(result.get('b')?.estimatedAt)).toBe(120);
  });

  it('the expiry boundary is inclusive, as in the worker', () => {
    const settings = { last_delivery_at: at(-1), next_delivery_at: null, min_interval_minutes: 2, send_window_minutes: 0 };
    const result = estimateQueue(settings, [row('a', -1, { queue_expires_at: at(1) })], now);
    expect(result.get('a')?.mayExpire).toBe(true);
  });

  it('a send postponed for a WhatsApp retry is overtaken by the next one', () => {
    const settings = { last_delivery_at: null, next_delivery_at: null, min_interval_minutes: 5, send_window_minutes: 0 };
    const result = estimateQueue(settings, [row('a', -2, { next_attempt_at: at(1) }), row('b', -1)], now);
    expect(minutes(result.get('b')?.estimatedAt)).toBe(0);
    expect(minutes(result.get('a')?.estimatedAt)).toBe(5);
    expect(result.get('a')?.position).toBe(1);
  });
});
