/**
 * Emergency state of the workstation, shared by every tab and by the customer window: one
 * localStorage record that is always replaced and read as a whole. It holds no customer data.
 * `gen` grows with every switch-off; claims and owner messages carry the `gen` read when
 * «Показать клиенту» was pressed, so nothing of an earlier generation is accepted after re-enabling.
 * Writers call the transitions only inside the Web Lock CLIENT_SCREEN_WORKSTATION_LOCK.
 */
export const CLIENT_SCREEN_WORKSTATION_KEY = 'erp.clientScreen.workstation';
export const CLIENT_SCREEN_WORKSTATION_LOCK = 'erp-client-screen-workstation';

export interface ClientScreenWorkstation {
  disabled: boolean;
  gen: number;
}

export const CLIENT_SCREEN_WORKSTATION_DEFAULT: ClientScreenWorkstation = { disabled: false, gen: 0 };

/** Anything unreadable counts as switched off: an unknown state must not allow a presentation. */
export function parseClientScreenWorkstation(raw: string | null): ClientScreenWorkstation {
  if (raw === null) return CLIENT_SCREEN_WORKSTATION_DEFAULT;
  try {
    const value = JSON.parse(raw) as Partial<ClientScreenWorkstation> | null;
    if (value && typeof value.disabled === 'boolean' && Number.isSafeInteger(value.gen) && (value.gen as number) >= 0) {
      return { disabled: value.disabled, gen: value.gen as number };
    }
  } catch {
    // fall through
  }
  return { disabled: true, gen: 0 };
}

export function serializeClientScreenWorkstation(record: ClientScreenWorkstation): string {
  return JSON.stringify({ disabled: record.disabled, gen: record.gen });
}

/** Switch-off starts a new generation and forbids presenting in the same replacement. */
export function disableClientScreenWorkstation(record: ClientScreenWorkstation): ClientScreenWorkstation {
  return { disabled: true, gen: record.gen + 1 };
}

/** Re-enabling keeps the generation: only a claim made afterwards can start a presentation. */
export function enableClientScreenWorkstation(record: ClientScreenWorkstation): ClientScreenWorkstation {
  return { disabled: false, gen: record.gen };
}

export function clientScreenAllowed(record: ClientScreenWorkstation, messageGen: number): boolean {
  return !record.disabled && record.gen === messageGen;
}
