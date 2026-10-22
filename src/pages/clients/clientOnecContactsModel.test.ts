import { describe, expect, it } from 'vitest';
import type { SupplierOnecProfile } from '../../api/partyContactsApi';
import { canSyncClientOnec, clientOnecStatusView, deferredReloadNow } from './clientOnecContactsModel';

const profile = (over: Partial<SupplierOnecProfile> = {}): SupplierOnecProfile => ({
  sourceId: 1, refKey1c: 'k1', counterpartyName: null, identificationNumber: null, counterpartyState: 'active',
  contactsState: 'available', snapshotVersion: 'v1', skipped: 0, syncedAt: '2026-10-22T10:30:00Z', ...over,
});
const now = new Date('2026-10-22T12:00:00Z');

describe('clientOnecStatusView', () => {
  it('says nothing without a link or without the 1C copy', () => {
    expect(clientOnecStatusView(null).visible).toBe(false);
    expect(clientOnecStatusView({ refKey1c: null, onec: profile() }).visible).toBe(false);
    expect(clientOnecStatusView({ refKey1c: 'k1', onec: null }).visible).toBe(false);
    expect(clientOnecStatusView({ refKey1c: 'k1' }).visible).toBe(false);
  });

  it('shows the last sync without warnings for a healthy copy', () => {
    const view = clientOnecStatusView({ refKey1c: 'k1', onec: profile() }, now);
    expect(view.visible).toBe(true);
    expect(view.syncedText).toMatch(/^Сверено с 1С /);
    expect(view.warnings).toEqual([]);
  });

  it('warns that the 1C data is unavailable and counts skipped values', () => {
    for (const contactsState of ['revoked', 'expired', 'unavailable'] as const) {
      expect(clientOnecStatusView({ refKey1c: 'k1', onec: profile({ contactsState }) }, now).warnings)
        .toEqual(['Данные 1С сейчас недоступны: контакты из 1С скрыты']);
    }
    expect(clientOnecStatusView({ refKey1c: 'k1', onec: profile({ skipped: 3 }) }, now).warnings).toEqual(['Не распознано значений из 1С: 3']);
    expect(clientOnecStatusView({ refKey1c: 'k1', onec: profile({ contactsState: 'not_loaded' }) }, now).warnings).toEqual([]);
  });
});

describe('canSyncClientOnec', () => {
  const all = () => true;
  it('needs the link, the switch and both permissions', () => {
    expect(canSyncClientOnec({ refKey1c: 'k1', onecSyncEnabled: true }, all)).toBe(true);
    expect(canSyncClientOnec({ refKey1c: null, onecSyncEnabled: true }, all)).toBe(false);
    expect(canSyncClientOnec({ refKey1c: 'k1', onecSyncEnabled: false }, all)).toBe(false);
    expect(canSyncClientOnec({ refKey1c: 'k1' }, all)).toBe(false);
    expect(canSyncClientOnec({ refKey1c: 'k1', onecSyncEnabled: true }, (permission) => permission === 'clients.update')).toBe(false);
    expect(canSyncClientOnec({ refKey1c: 'k1', onecSyncEnabled: true }, (permission) => permission === 'clients.onec_data.view')).toBe(false);
    expect(canSyncClientOnec(null, all)).toBe(false);
  });
});

describe('deferredReloadNow', () => {
  it('a reload asked for after a link change waits for unsaved edits and for a change in flight, then runs once', () => {
    // The user started editing between the immediate reload and the later one: the draft is kept.
    expect(deferredReloadNow(true, true, false)).toBe(false);
    expect(deferredReloadNow(true, false, true)).toBe(false);
    // Saved or cancelled: the waiting reload runs now.
    expect(deferredReloadNow(true, false, false)).toBe(true);
    // Nothing asked for: nothing runs.
    expect(deferredReloadNow(false, false, false)).toBe(false);
  });
});
