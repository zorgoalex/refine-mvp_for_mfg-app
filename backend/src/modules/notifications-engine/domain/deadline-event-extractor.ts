export const DEADLINE_ENVELOPE_EVENT_TYPE = 'deadline.event.created';

export interface DeadlineEnvelopeLike {
  eventType: string;
  payload?: Record<string, unknown> | null;
}

/**
 * Maps an outbox event to the engine's effective event type.
 *
 * The deadline worker enqueues terminal deadline events under a single envelope
 * `event_type='deadline.event.created'`, with the real terminal type stored in
 * `payload.eventType` (see `pg-deadline-repository.enqueueOutboxEvent`). The
 * engine registry and rule set are keyed on the terminal type
 * (`DEADLINE_EXPIRED`, `DEADLINE_COMPLETED_*`), so the engine resolves the
 * effective type at consumption time — the outbox row itself stays the envelope.
 *
 * For non-envelope events the function is a no-op pass-through.
 *
 * Unknown / missing / non-string inner types fall back to the envelope so the
 * registry lookup returns `undefined` and the engine takes its normal safe-skip
 * path (`{ matched: 0, skipped: 'not_engine_owned' }`). This is the documented
 * fail-closed behavior for malformed producer payloads.
 */
export function resolveEffectiveEventType(event: DeadlineEnvelopeLike): string {
  if (event.eventType !== DEADLINE_ENVELOPE_EVENT_TYPE) {
    return event.eventType;
  }

  const inner = event.payload?.eventType;
  return typeof inner === 'string' && inner.trim() !== '' ? inner : event.eventType;
}
