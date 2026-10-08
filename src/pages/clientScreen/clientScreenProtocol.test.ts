import { describe, expect, it } from 'vitest';
import {
  CLIENT_SCREEN_ANY_OWNER_LOCK_PREFIX, CLIENT_SCREEN_CHANNEL, CLIENT_SCREEN_OWNER_LOCK_PREFIX, CLIENT_SCREEN_PROTOCOL_VERSION, CLIENT_SCREEN_RETIRED_VIEWERS, CLIENT_SCREEN_VIEWER_LOCK,
  clientScreenMessage, clientScreenOwnerLock, clientScreenRandomId, parseClientScreenMessage, type ClientScreenMessage,
} from './clientScreenProtocol';
import { CLIENT_SCREEN_CODES } from './clientScreenRegistry';
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
      null, 'state', 42, {}, { ...state, v: 1 }, { ...state, v: 5 }, { ...state, v: 7 }, { ...state, t: 'takeover' }, { ...state, extra: 1 },
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

describe('wire version', () => {
  it('names of the channel and of the locks carry the version, so windows of different builds never meet', () => {
    expect(CLIENT_SCREEN_PROTOCOL_VERSION).toBe(6);
    expect(CLIENT_SCREEN_CHANNEL).toBe('erp-client-screen-v6');
    expect(CLIENT_SCREEN_VIEWER_LOCK).toBe('erp-client-screen-viewer-v6');
    expect(clientScreenOwnerLock(7)).toBe('erp-client-screen-owner-v6-7');
    expect('erp-client-screen-owner-v5-7'.startsWith(CLIENT_SCREEN_ANY_OWNER_LOCK_PREFIX)).toBe(true);
    expect('erp-client-screen-owner-v4-7'.startsWith(CLIENT_SCREEN_ANY_OWNER_LOCK_PREFIX)).toBe(true);
    expect('erp-client-screen-owner-v3-7'.startsWith(CLIENT_SCREEN_ANY_OWNER_LOCK_PREFIX)).toBe(true);
    expect('erp-client-screen-owner-v2-7'.startsWith(CLIENT_SCREEN_ANY_OWNER_LOCK_PREFIX)).toBe(true);
    expect(clientScreenOwnerLock(7).startsWith(CLIENT_SCREEN_OWNER_LOCK_PREFIX)).toBe(true);
    // Presence of a presentation is recognised for every build: this one and the previous one.
    expect(clientScreenOwnerLock(7).startsWith(CLIENT_SCREEN_ANY_OWNER_LOCK_PREFIX)).toBe(true);
    expect('erp-client-screen-owner-7'.startsWith(CLIENT_SCREEN_ANY_OWNER_LOCK_PREFIX)).toBe(true);
    expect(CLIENT_SCREEN_VIEWER_LOCK.startsWith(CLIENT_SCREEN_ANY_OWNER_LOCK_PREFIX)).toBe(false);
    const retired = CLIENT_SCREEN_RETIRED_VIEWERS.map((item) => item.channel);
    expect(retired).toEqual(['erp-client-screen', 'erp-client-screen-v2', 'erp-client-screen-v3', 'erp-client-screen-v4', 'erp-client-screen-v5']);
    expect(retired).not.toContain(CLIENT_SCREEN_CHANNEL);
  });

  it('a message of the previous version is not a message; the closing message for old windows is theirs, not ours', () => {
    expect(parseClientScreenMessage({ v: 1, t: 'shutdown' })).toBeNull();
    expect(parseClientScreenMessage({ v: 1, t: 'hello', viewerId: 'aaaaaaaaaaaaaaaa' })).toBeNull();
    expect(parseClientScreenMessage({ v: 2, t: 'shutdown' })).toBeNull();
    expect(CLIENT_SCREEN_RETIRED_VIEWERS.map((item) => item.shutdown)).toEqual([{ v: 1, t: 'shutdown' }, { v: 2, t: 'shutdown' }, { v: 3, t: 'shutdown' }, { v: 4, t: 'shutdown' }, { v: 5, t: 'shutdown' }]);
    expect(parseClientScreenMessage({ v: 5, t: 'shutdown' })).toBeNull();
    expect(parseClientScreenMessage({ v: 4, t: 'shutdown' })).toBeNull();
    expect(parseClientScreenMessage({ v: 3, t: 'shutdown' })).toBeNull();
    expect(parseClientScreenMessage({ v: CLIENT_SCREEN_PROTOCOL_VERSION, t: 'shutdown' })).not.toBeNull();
  });

  // The registry of codes is wire data: a customer window of an older build drops a snapshot with a
  // code it does not know. Changing this list means: raise CLIENT_SCREEN_PROTOCOL_VERSION, add the
  // previous channel to CLIENT_SCREEN_RETIRED_VIEWERS, then update the pair below.
  it('the registry of codes is pinned to the wire version', () => {
    expect({ version: CLIENT_SCREEN_PROTOCOL_VERSION, codes: CLIENT_SCREEN_CODES.join(' ') }).toEqual({
      version: 6,
      codes: 'summary.number summary.order_name summary.client summary.client_phone summary.client_phones summary.deadline summary.positions '
        + 'summary.parts summary.area summary.material summary.milling_type summary.edge_type summary.film '
        + 'summary.final summary.discount summary.surcharge summary.paid summary.debt '
        + 'summary.designer summary.basis_project summary.project summary.order_status summary.payment_status summary.production_status '
        + 'summary.priority summary.created_by '
        + 'tab.basic basic.client basic.order_name basic.order_date basic.order_status basic.payment_status basic.production_status basic.manager '
        + 'basic.priority basic.doweling basic.notes '
        + 'tab.details details.n details.name details.height details.width details.quantity details.area details.material details.milling_type '
        + 'details.edge_type details.film details.price_per_sqm details.cost details.note details.production_status '
        + 'details.hdf_parameter details.doweling details.cut_job details.bath_cut_job details.bazis_cut_sets details.priority '
        + 'details.basis_project details.basis_product details.basis_data details.basis_designation '
        + 'tab.hdf hdf.min_threshold hdf.total hdf.position hdf.milling_type hdf.source_height hdf.source_width hdf.source_quantity '
        + 'hdf.parameter hdf.height hdf.width hdf.quantity hdf.area hdf.status hdf.production_status hdf.cut_job hdf.bazis_cut_sets '
        + 'tab.dates dates.planned dates.completion dates.issue '
        + 'tab.finance finance.total finance.discount finance.surcharge finance.final finance.paid finance.debt finance.payments finance.payments_note '
        + 'tab.services services.name services.quantity services.price services.sum '
        + 'tab.requirements requirements.film_name requirements.film_area requirements.film_details requirements.film_meters requirements.film_sheets '
        + 'requirements.film_cut_jobs requirements.film_stock requirements.film_coverage '
        + 'requirements.sheet_name requirements.sheet_area requirements.sheet_details requirements.sheet_stock requirements.sheet_coverage',
    });
  });
});
