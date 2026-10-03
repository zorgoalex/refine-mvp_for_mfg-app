/** Rows of the queue as the estimate needs them (whatsapp_order_sends in state queued/sending). */
export interface QueueRow {
  send_id: string;
  state: string;
  created_at: Date;
  next_attempt_at: Date;
  queue_expires_at: Date;
  send_started_at: Date | null;
}

export interface QueueGate {
  last_delivery_at: Date | null;
  next_delivery_at: Date | null;
  min_interval_minutes: number;
  send_window_minutes: number;
}

export interface QueueEstimate {
  /** 1-based place in the queue (FIFO by the command time). */
  position: number;
  /** Approximate start of the delivery: the start for a sending one. */
  estimatedAt: Date;
  /** Expected to expire before its turn. */
  mayExpire: boolean;
}

/** End of the threshold since the last delivery. */
export function nextAllowed(settings: Pick<QueueGate, 'last_delivery_at' | 'min_interval_minutes'>): Date | null {
  if (!settings.last_delivery_at) return null;
  return new Date(settings.last_delivery_at.getTime() + settings.min_interval_minutes * 60_000);
}

/** The delivery gate: the threshold plus the random delay drawn at the last delivery (whichever is later). */
export function deliveryAllowedAt(settings: Pick<QueueGate, 'last_delivery_at' | 'min_interval_minutes' | 'next_delivery_at'>): Date | null {
  const threshold = nextAllowed(settings);
  if (!threshold) return null;
  return settings.next_delivery_at && settings.next_delivery_at.getTime() > threshold.getTime() ? settings.next_delivery_at : threshold;
}

/**
 * «≈ когда» for every waiting send, by replaying the worker: at the moment `t` the oldest queued send
 * with `next_attempt_at <= t` that has not expired goes (a send postponed for a WhatsApp retry may be
 * overtaken); each delivery moves `t` by the threshold plus half the window (the expected random
 * delay). A send whose life ends before its turn takes no slot and is marked `mayExpire`
 * (the worker refuses at `expires <= now`, so the boundary is inclusive).
 */
export function estimateQueue(settings: QueueGate, rows: readonly QueueRow[], now: Date): Map<string, QueueEstimate> {
  const result = new Map<string, QueueEstimate>();
  const ordered = [...rows].sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.send_id.localeCompare(b.send_id));
  const position = new Map(ordered.map((row, index) => [row.send_id, index + 1]));
  const step = settings.min_interval_minutes * 60_000 + (settings.send_window_minutes * 60_000) / 2;
  for (const row of ordered) {
    if (row.state === 'sending') {
      result.set(row.send_id, { position: position.get(row.send_id) ?? 0, estimatedAt: row.send_started_at ?? now, mayExpire: false });
    }
  }
  let t = Math.max(now.getTime(), deliveryAllowedAt(settings)?.getTime() ?? 0);
  let remaining = ordered.filter((row) => row.state === 'queued');
  while (remaining.length) {
    const expired = remaining.filter((row) => row.queue_expires_at.getTime() <= Math.max(t, row.next_attempt_at.getTime()));
    for (const row of expired) {
      result.set(row.send_id, { position: position.get(row.send_id) ?? 0, estimatedAt: row.queue_expires_at, mayExpire: true });
    }
    remaining = remaining.filter((row) => !expired.includes(row));
    if (!remaining.length) break;
    const due = remaining.find((row) => row.next_attempt_at.getTime() <= t);
    if (!due) {
      t = Math.min(...remaining.map((row) => row.next_attempt_at.getTime()));
      continue;
    }
    result.set(due.send_id, { position: position.get(due.send_id) ?? 0, estimatedAt: new Date(t), mayExpire: false });
    remaining = remaining.filter((row) => row !== due);
    t += step;
  }
  return result;
}
