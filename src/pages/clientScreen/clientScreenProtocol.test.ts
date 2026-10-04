import { describe, expect, it } from 'vitest';
import { clientScreenMessage, clientScreenRandomId, parseClientScreenMessage, type ClientScreenMessage } from './clientScreenProtocol';
import type { ClientScreenSnapshot, ClientScreenUi } from './clientScreenSnapshotSchema';
import {
  CLIENT_SCREEN_WORKSTATION_DEFAULT, clientScreenAllowed, disableClientScreenWorkstation, enableClientScreenWorkstation,
  parseClientScreenWorkstation, serializeClientScreenWorkstation,
} from './clientScreenWorkstation';

export const snapshot: ClientScreenSnapshot = {
  title: 'Заказ № 2418',
  summary: [{ code: 'summary.client', label: 'Клиент', value: 'Садыков Арман' }],
  tabs: [{ key: 'basic', label: 'Основное' }, { key: 'details', label: 'Детали', counter: '2' }],
  basic: [{ code: 'basic.client', label: 'Клиент', value: 'Садыков Арман' }],
  details: {
    columns: [{ code: 'details.name', label: 'Наименование', align: 'left' }, { code: 'details.area', label: 'Площадь', align: 'right' }],
    rows: [{ id: 'rowaaaaaa', cells: ['Фасад', '1,13 м²'] }, { id: 'rowbbbbbb', cells: ['Цоколь', '0,48 м²'] }],
  },
};
export const ui: ClientScreenUi = { tab: 'details', focus: { code: 'details.name', rowId: 'rowaaaaaa' }, editing: null, scroll: { ratio: 0.5 }, page: { current: 1, size: 50 } };

const A = 'windowaaaaaaaaaa';
const V = 'viewervvvvvvvvvv';
const all: ClientScreenMessage[] = [
  clientScreenMessage('hello', { viewerId: V }),
  clientScreenMessage('claim', { candidateId: A, claimId: 'claimcccccccccccc', gen: 0 }),
  clientScreenMessage('resume', { candidateId: A, claimId: 'claimcccccccccccc', gen: 0, viewerId: V, resumeEpoch: 5 }),
  clientScreenMessage('grant', { epoch: 6, ownerId: A, claimId: 'claimcccccccccccc', viewerId: V }),
  clientScreenMessage('owner-ready', { epoch: 6, gen: 0 }),
  clientScreenMessage('state', { epoch: 6, gen: 0, seq: 1, policyVersion: 3, validUntil: 1000, mode: 'order', snapshot }),
  clientScreenMessage('state', { epoch: 6, gen: 0, seq: 2, policyVersion: 3, validUntil: 1000, mode: 'blank', snapshot: null }),
  clientScreenMessage('ui', { epoch: 6, gen: 0, stateSeq: 1, ui }),
  clientScreenMessage('confirm', { epoch: 6, gen: 0, policyVersion: 3, validUntil: 2000 }),
  clientScreenMessage('release', { epoch: 6, gen: 0 }),
  clientScreenMessage('shutdown', {}),
];

describe('client screen protocol', () => {
  it('every message a sender can build passes the receiver validation unchanged (also after structured clone)', () => {
    expect(new Set(all.map((message) => message.t)).size).toBe(10);
    for (const message of all) {
      expect(parseClientScreenMessage(structuredClone(message))).toEqual(message);
      expect(parseClientScreenMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
    }
  });

  it('drops anything with an unknown key, a wrong version, a wrong type or a foreign shape', () => {
    const state = all[5];
    for (const bad of [
      null, 'state', 42, {}, { ...state, v: 2 }, { ...state, t: 'takeover' }, { ...state, extra: 1 },
      { ...state, snapshot: { ...snapshot, header: { order_id: 7 } } },
      { ...state, snapshot: { ...snapshot, summary: [{ code: 'orders.secret', label: 'x', value: 'y' }] } },
      { ...state, snapshot: { ...snapshot, details: { ...snapshot.details!, rows: [{ id: 'rowaaaaaa', cells: ['only one'] }] } } },
      { ...state, snapshot: { ...snapshot, details: { ...snapshot.details!, rows: [{ id: 'order:17', cells: ['a', 'b'] }] } } },
      { ...state, mode: 'blank' }, { ...all[6], mode: 'order' },
      { ...all[7], ui: { ...ui, selection: 'x' } }, { ...all[7], ui: { ...ui, scroll: { ratio: 2 } } },
      { ...all[4], gen: undefined }, { ...all[9], gen: undefined }, { ...all[1], gen: -1 },
    ]) expect(parseClientScreenMessage(bad)).toBeNull();
  });

  it('a sender cannot build a message receivers would drop', () => {
    expect(() => clientScreenMessage('state', { epoch: 6, gen: 0, seq: 1, policyVersion: 3, validUntil: 1, mode: 'order', snapshot: null })).toThrow();
    expect(() => clientScreenMessage('claim', { candidateId: 'x', claimId: 'claimcccccccccccc', gen: 0 })).toThrow();
  });

  it('random ids are lowercase alphanumeric of the requested length and differ', () => {
    const ids = new Set(Array.from({ length: 50 }, () => clientScreenRandomId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{16}$/);
    expect(clientScreenRandomId(10)).toHaveLength(10);
  });
});

describe('workstation record', () => {
  it('a missing record allows presenting; an unreadable one forbids it', () => {
    expect(parseClientScreenWorkstation(null)).toEqual(CLIENT_SCREEN_WORKSTATION_DEFAULT);
    for (const raw of ['', '{', 'null', '[]', '{"disabled":"no","gen":1}', '{"disabled":false,"gen":-1}', '{"disabled":false}']) {
      expect(parseClientScreenWorkstation(raw).disabled).toBe(true);
    }
  });

  it('switch-off starts a new generation in the same record; re-enabling keeps it', () => {
    const off = disableClientScreenWorkstation({ disabled: false, gen: 4 });
    expect(off).toEqual({ disabled: true, gen: 5 });
    expect(parseClientScreenWorkstation(serializeClientScreenWorkstation(off))).toEqual(off);
    const on = enableClientScreenWorkstation(off);
    expect(on).toEqual({ disabled: false, gen: 5 });
    // A second switch-off (from another tab, serialized by the lock) never repeats a generation.
    expect(disableClientScreenWorkstation(off).gen).toBe(6);
  });

  it('only the current generation of an enabled workstation is allowed', () => {
    expect(clientScreenAllowed({ disabled: false, gen: 5 }, 5)).toBe(true);
    expect(clientScreenAllowed({ disabled: false, gen: 5 }, 4)).toBe(false);
    expect(clientScreenAllowed({ disabled: true, gen: 5 }, 5)).toBe(false);
  });
});
