import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Bitrix24ApiClient, Bitrix24ApiError, type Bitrix24ApiPort, type Bitrix24CommentPage, type FetchFn } from '../adapters/bitrix24-api-client';
import type {
  NotificationPatch,
  NotificationReadiness,
  NotificationSkipReason,
  PaymentNotification,
  PgCrmSyncPaymentNotificationRepository,
} from '../adapters/pg-crm-sync-payment-notification-repository';
import { Bitrix24PaymentNotificationWorker, classifyCreateError, STEP_MAX_ATTEMPTS } from './bitrix24-payment-notification-worker';
import { notificationMarker } from './bitrix24-payment-notification-text';

const MINUTE = 60_000;

interface StoredRow extends Omit<PaymentNotification, 'leaseToken'> {
  status: 'pending' | 'sent' | 'skipped' | 'failed';
  skipReason: NotificationSkipReason | null;
  leaseToken: string | null;
  nextAttemptAt: number;
  notifyAttemptStartedAt: Date | null;
  lastError: string | null;
}

/** In-memory twin of PgCrmSyncPaymentNotificationRepository (same fencing and state rules). */
class FakeStore {
  rows = new Map<string, StoredRow>();
  dealId: string | null = '7001';
  readinessValue: NotificationReadiness = { synced: true, broken: false };
  audits: Array<{ event: string; row: StoredRow; details: unknown }> = [];
  /** Fault injection: the next update matching `when` throws, before or after it is applied (lost acknowledgement). */
  fault: { when: (patch: NotificationPatch) => boolean; applied: boolean } | null = null;
  constructor(private readonly clock: { now: number }) {}

  add(overrides: Partial<StoredRow> = {}): StoredRow {
    const row: StoredRow = {
      notificationId: randomUUID(), erpOrderId: '11501', correlationRequestId: 'req', actorUserId: '7', syncEventId: null,
      payload: { orderName: '1258тест', finalAmount: 1000, paidAfter: 999, statusAfter: null, actorName: 'Иван', paymentIds: [1], lines: [{ kind: 'changed', amountBefore: 1000, amountAfter: 999 }] },
      readyAt: null, syncIncomplete: false, bitrixDealId: null, bitrixUserId: null,
      commentState: 'none', commentAttemptStartedAt: null, commentAttempts: 0, commentNextAt: null, commentId: null,
      notifyState: 'none', notifyAttempts: 0, notifyNextAt: null, attempts: 0, createdAt: new Date(this.clock.now),
      status: 'pending', skipReason: null, leaseToken: null, nextAttemptAt: this.clock.now, notifyAttemptStartedAt: null, lastError: null,
      ...overrides,
    };
    this.rows.set(row.notificationId, row);
    return row;
  }

  only(): StoredRow {
    return [...this.rows.values()][0];
  }

  async expireUntouched() {
    for (const row of this.rows.values()) {
      if (row.status === 'pending' && !row.commentAttemptStartedAt && !row.notifyAttemptStartedAt && this.clock.now - row.createdAt.getTime() > 60 * MINUTE) {
        Object.assign(row, { status: 'skipped', skipReason: 'expired_untouched' });
        this.audits.push({ event: 'skipped', row, details: { skipReason: 'expired_untouched' } });
      }
    }
    return 0;
  }

  async purgeFinished() { return 0; }

  async claimDue(limit: number, _leaseMs: number, orderIds: ReadonlySet<string>): Promise<PaymentNotification[]> {
    const due = [...this.rows.values()].filter((row) => row.status === 'pending' && row.nextAttemptAt <= this.clock.now && row.leaseToken === null
      && (orderIds.size === 0 || orderIds.has(row.erpOrderId))).slice(0, limit);
    return due.map((row) => {
      row.leaseToken = randomUUID();
      return { ...row, leaseToken: row.leaseToken } as PaymentNotification;
    });
  }

  private apply(row: StoredRow, patch: NotificationPatch) {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      const map: Record<string, string> = { notifiedAt: 'notifiedAt' };
      const target = map[key] ?? key;
      if (key === 'nextAttemptAt') row.nextAttemptAt = (value as Date).getTime();
      else (row as unknown as Record<string, unknown>)[target] = value === 'now' ? new Date(this.clock.now) : value;
    }
  }

  async update(claimed: PaymentNotification, patch: NotificationPatch) {
    const row = this.rows.get(claimed.notificationId)!;
    if (row.leaseToken !== claimed.leaseToken || row.status !== 'pending') return false;
    const fault = this.fault && this.fault.when(patch) ? this.fault : null;
    if (fault) this.fault = null;
    if (fault && !fault.applied) throw new Error('connection terminated');
    this.apply(row, patch);
    if (fault) throw new Error('connection terminated after commit');
    return true;
  }

  async release(claimed: PaymentNotification, next: Date, patch: NotificationPatch = {}) {
    const row = this.rows.get(claimed.notificationId)!;
    if (row.leaseToken !== claimed.leaseToken || row.status !== 'pending') return false;
    this.apply(row, { ...patch, nextAttemptAt: next });
    row.leaseToken = null;
    return true;
  }

  async finish(claimed: PaymentNotification, status: 'sent' | 'skipped' | 'failed', patch: NotificationPatch, details: { skipReason?: NotificationSkipReason }) {
    const row = this.rows.get(claimed.notificationId)!;
    if (row.leaseToken !== claimed.leaseToken || row.status !== 'pending') return false;
    this.apply(row, patch);
    Object.assign(row, { status, skipReason: details.skipReason ?? null, leaseToken: null });
    this.audits.push({ event: status, row, details });
    return true;
  }

  async findDealId() { return this.dealId; }
  async readiness() { return this.readinessValue; }
}

type Step = 'ok' | Error;

class FakePortal implements Partial<Bitrix24ApiPort> {
  comments: Array<{ id: string; comment: string }> = [];
  notifications: Array<{ userId: string; message: string }> = [];
  commentPlan: Step[] = [];
  notifyPlan: Step[] = [];
  listComplete = true;
  assignedById: unknown = 42;
  dealError: Error | null = null;
  calls: string[] = [];

  withRequestGuard<T>(guard: () => Promise<void>, operation: () => Promise<T>) { return guard().then(operation); }
  async getCrmItem() {
    this.calls.push('crm.item.get');
    if (this.dealError) throw this.dealError;
    return { id: 7001, assignedById: this.assignedById };
  }
  async addDealComment(_dealId: string, comment: string) {
    this.calls.push('comment.add');
    const step = this.commentPlan.shift() ?? 'ok';
    const created = { id: String(900 + this.comments.length), comment };
    // An unknown outcome (5xx, network) is modelled as «created, but the answer was lost».
    if (step === 'ok' || classifyCreateError(step) === 'unknown') this.comments.push(created);
    if (step !== 'ok') throw step;
    return created.id;
  }
  async listDealComments(): Promise<Bitrix24CommentPage> {
    this.calls.push('comment.list');
    return { comments: this.listComplete ? this.comments : [], complete: this.listComplete };
  }
  async notifyUser(userId: string, message: string) {
    this.calls.push('notify');
    const step = this.notifyPlan.shift() ?? 'ok';
    if (step === 'ok' || classifyCreateError(step) === 'unknown') this.notifications.push({ userId, message });
    if (step !== 'ok') throw step;
  }
}

function setup(policy = { enabled: true, orderIds: new Set<string>() as ReadonlySet<string> }) {
  const clock = { now: Date.parse('2026-10-19T10:00:00Z') };
  const store = new FakeStore(clock);
  const portal = new FakePortal();
  const worker = new Bitrix24PaymentNotificationWorker({
    bitrix: portal as unknown as Bitrix24ApiPort,
    store: store as unknown as PgCrmSyncPaymentNotificationRepository,
    policy: () => policy,
    erpBaseUrl: 'https://mebelkz.app',
    portalHost: 'portal.bitrix24.kz',
    now: () => clock.now,
    logger: { log() {}, error() {}, warn() {} } as never,
  });
  const tick = async (advanceMs = 0) => {
    clock.now += advanceMs;
    return worker.runDue(async () => undefined);
  };
  return { clock, store, portal, worker, tick };
}

const lost = () => new Bitrix24ApiError('crm.timeline.comment.add', 'HTTP_ERROR', 500, 'Internal');
const network = () => new Bitrix24ApiError('im.notify.system.add', 'NETWORK_ERROR', 0, 'socket hang up');
const refused = (code = 'QUERY_LIMIT_EXCEEDED') => new Bitrix24ApiError('x', code, 503, 'refused');

describe('classifyCreateError', () => {
  it('treats only allowlisted Bitrix24 codes as proven refusals', () => {
    expect(classifyCreateError(refused())).toBe('refused');
    expect(classifyCreateError(refused('ERROR_ARGUMENT'))).toBe('refused');
    expect(classifyCreateError(refused('insufficient_scope'))).toBe('no_scope');
    expect(classifyCreateError(refused('ACCESS_DENIED'))).toBe('no_scope');
    expect(classifyCreateError(lost())).toBe('unknown');
    expect(classifyCreateError(network())).toBe('unknown');
    expect(classifyCreateError(new Bitrix24ApiError('x', 'UNEXPECTED_RESPONSE', 200, ''))).toBe('unknown');
    expect(classifyCreateError(Object.assign(new Error('lost'), { name: 'OwnershipLost' }))).toBe('refused');
    expect(classifyCreateError(new TypeError("Cannot read properties of null (reading 'time')"))).toBe('unknown');
    expect(classifyCreateError(new Error('anything else'))).toBe('unknown');
  });
});

describe('Bitrix24PaymentNotificationWorker', () => {
  it('sends the comment and the notification to the deal owner and finishes the row', async () => {
    const { store, portal, tick } = setup();
    const row = store.add();
    await tick();
    expect(portal.comments).toHaveLength(1);
    expect(portal.comments[0].comment).toContain(notificationMarker(row.notificationId));
    expect(portal.notifications).toEqual([{ userId: '42', message: expect.stringContaining('1258тест') }]);
    expect(store.only()).toMatchObject({ status: 'sent', commentState: 'created', commentId: '900', notifyState: 'sent', bitrixDealId: '7001', bitrixUserId: '42' });
    expect(store.audits.map((audit) => audit.event)).toEqual(['sent']);
  });

  it('does nothing while the flag is off, and only canary orders when a list is set', async () => {
    const off = setup({ enabled: false, orderIds: new Set() });
    off.store.add();
    await off.tick();
    expect(off.portal.calls).toEqual([]);

    const canary = setup({ enabled: true, orderIds: new Set(['11501']) });
    canary.store.add({ erpOrderId: '999' });
    const own = canary.store.add();
    await canary.tick();
    expect(canary.store.rows.get(own.notificationId)!.status).toBe('sent');
    expect(canary.portal.comments).toHaveLength(1);
  });

  it('waits for the Bitrix24 sync, then sends anyway after 15 minutes with the warning', async () => {
    const { store, portal, tick } = setup();
    store.readinessValue = { synced: false, broken: false };
    store.add();
    await tick();
    expect(portal.calls).toEqual([]);
    expect(store.only().status).toBe('pending');
    await tick(16 * MINUTE);
    expect(store.only()).toMatchObject({ status: 'sent', syncIncomplete: true });
    expect(portal.comments[0].comment).toContain('Оплата в Bitrix ещё не обновлена');
  });

  it('sends at once with the warning when the sync failed or a paid operation is stuck', async () => {
    const { store, portal, tick } = setup();
    store.readinessValue = { synced: false, broken: true };
    store.add();
    await tick();
    expect(store.only()).toMatchObject({ status: 'sent', syncIncomplete: true });
    expect(portal.notifications[0].message).toContain('проверьте в ERP');
  });

  it('a synced order gets no warning', async () => {
    const { store, portal, tick } = setup();
    store.add();
    await tick();
    expect(portal.comments[0].comment).not.toContain('не обновлена');
  });

  it('waits up to 30 minutes for a deal, then skips with no_deal', async () => {
    const { store, portal, tick } = setup();
    store.dealId = null;
    store.add();
    await tick();
    expect(store.only().status).toBe('pending');
    await tick(31 * MINUTE);
    expect(store.only()).toMatchObject({ status: 'skipped', skipReason: 'no_deal' });
    expect(portal.calls).toEqual([]);
  });

  it('a deal deleted in Bitrix24 is skipped as no_deal', async () => {
    const { store, portal, tick } = setup();
    portal.dealError = new Bitrix24ApiError('crm.item.get', 'NOT_FOUND', 400, 'Not found');
    store.add();
    await tick();
    expect(store.only()).toMatchObject({ status: 'skipped', skipReason: 'no_deal' });
  });

  it('without a responsible user only the comment is added', async () => {
    const { store, portal, tick } = setup();
    portal.assignedById = null;
    store.add();
    await tick();
    expect(portal.notifications).toHaveLength(0);
    expect(store.only()).toMatchObject({ status: 'sent', commentState: 'created', notifyState: 'no_recipient' });
  });

  it('a lost comment answer is never repeated: the marker is found later and the comment resolved', async () => {
    const { store, portal, tick } = setup();
    portal.commentPlan = [lost()];
    store.add();
    await tick();
    expect(portal.comments).toHaveLength(1);
    expect(store.only()).toMatchObject({ status: 'pending', commentState: 'unresolved', notifyState: 'sent' });
    await tick(11 * MINUTE);
    expect(portal.calls.filter((call) => call === 'comment.add')).toHaveLength(1);
    expect(store.only()).toMatchObject({ status: 'sent', commentState: 'resolved', commentId: '900' });
  });

  it('an unresolved comment whose marker never shows up becomes unknown after 24 hours, without a second comment', async () => {
    const { store, portal, tick } = setup();
    portal.commentPlan = [lost()];
    portal.listComplete = false;
    store.add();
    await tick();
    for (let i = 0; i < 6; i += 1) await tick(4 * 60 * MINUTE + MINUTE);
    expect(portal.calls.filter((call) => call === 'comment.add')).toHaveLength(1);
    expect(store.only()).toMatchObject({ status: 'sent', commentState: 'unknown', notifyState: 'sent' });
  });

  it('a crash after the comment call started (state attempting) is treated as unresolved, not repeated', async () => {
    const { store, portal, tick } = setup();
    store.add({ readyAt: new Date(), bitrixDealId: '7001', bitrixUserId: '42', commentState: 'attempting', commentAttemptStartedAt: new Date(), commentAttempts: 1 });
    portal.comments.push({ id: '555', comment: `x\n${notificationMarker(store.only().notificationId)}` });
    await tick();
    expect(portal.calls).not.toContain('comment.add');
    expect(portal.calls).toContain('comment.list');
    expect(store.only()).toMatchObject({ status: 'sent', commentState: 'resolved', commentId: '555' });
  });

  it('a proven refusal of the comment is retried with backoff and fails after the last attempt', async () => {
    const { store, portal, tick } = setup();
    portal.commentPlan = Array.from({ length: STEP_MAX_ATTEMPTS }, () => refused('ERROR_ARGUMENT'));
    store.add();
    await tick();
    expect(store.only()).toMatchObject({ status: 'pending', commentState: 'none', commentAttempts: 1, notifyState: 'sent' });
    for (let i = 0; i < STEP_MAX_ATTEMPTS + 2; i += 1) await tick(61 * MINUTE);
    expect(portal.calls.filter((call) => call === 'comment.add')).toHaveLength(STEP_MAX_ATTEMPTS);
    expect(store.only()).toMatchObject({ status: 'sent', commentState: 'failed', notifyState: 'sent' });
  });

  it('a lost notification answer becomes unknown and is never repeated', async () => {
    const { store, portal, tick } = setup();
    portal.notifyPlan = [network()];
    store.add();
    await tick();
    await tick(61 * MINUTE);
    expect(portal.calls.filter((call) => call === 'notify')).toHaveLength(1);
    expect(store.only()).toMatchObject({ status: 'sent', commentState: 'created', notifyState: 'unknown' });
  });

  it('a refused notification is retried; a missing im scope stops it as no_scope', async () => {
    const retried = setup();
    retried.portal.notifyPlan = [refused()];
    retried.store.add();
    await retried.tick();
    expect(retried.store.only()).toMatchObject({ status: 'pending', notifyState: 'none', notifyAttempts: 1 });
    await retried.tick(2 * MINUTE);
    expect(retried.store.only()).toMatchObject({ status: 'sent', notifyState: 'sent' });
    expect(retried.portal.notifications).toHaveLength(1);

    const scope = setup();
    scope.portal.notifyPlan = [refused('insufficient_scope')];
    scope.store.add();
    await scope.tick();
    expect(scope.store.only()).toMatchObject({ status: 'sent', commentState: 'created', notifyState: 'no_scope' });
  });

  it('both steps failing finishes the row as failed', async () => {
    const { store, portal, tick } = setup();
    portal.commentPlan = Array.from({ length: STEP_MAX_ATTEMPTS }, () => refused('ERROR_ARGUMENT'));
    portal.notifyPlan = [refused('ACCESS_DENIED')];
    store.add();
    await tick();
    for (let i = 0; i < STEP_MAX_ATTEMPTS + 2; i += 1) await tick(61 * MINUTE);
    expect(store.only()).toMatchObject({ status: 'failed', commentState: 'failed', notifyState: 'no_scope' });
    expect(store.audits.map((audit) => audit.event)).toEqual(['failed']);
  });

  it('an exhausted comment does not end the row while the notification still has attempts, and vice versa', async () => {
    const { store, portal, tick } = setup();
    store.add({ readyAt: new Date(), bitrixDealId: '7001', bitrixUserId: '42', commentState: 'failed', commentAttemptStartedAt: new Date(), notifyAttempts: 3, notifyNextAt: new Date(Date.parse('2026-10-19T10:30:00Z')) });
    await tick();
    expect(store.only().status).toBe('pending');
    expect(portal.calls).toEqual([]);
    await tick(31 * MINUTE);
    expect(store.only()).toMatchObject({ status: 'sent', notifyState: 'sent' });
  });

  it('expires only untouched rows older than an hour; a started row continues after the flag was off', async () => {
    const { store, portal, tick } = setup();
    const untouched = store.add();
    const started = store.add({ readyAt: new Date(), bitrixDealId: '7001', bitrixUserId: '42', notifyState: 'unknown', notifyAttemptStartedAt: new Date() });
    await tick(2 * 60 * MINUTE);
    expect(store.rows.get(untouched.notificationId)).toMatchObject({ status: 'skipped', skipReason: 'expired_untouched' });
    expect(store.rows.get(started.notificationId)).toMatchObject({ status: 'sent', commentState: 'created', notifyState: 'unknown' });
    expect(portal.calls.filter((call) => call === 'notify')).toHaveLength(0);
  });

  it('a crashed notification attempt (attempting) becomes unknown and is not repeated', async () => {
    const { store, portal, tick } = setup();
    store.add({ readyAt: new Date(), bitrixDealId: '7001', bitrixUserId: '42', commentState: 'created', commentId: '1', notifyState: 'attempting', notifyAttemptStartedAt: new Date() });
    await tick();
    expect(portal.calls).toEqual([]);
    expect(store.only()).toMatchObject({ status: 'sent', notifyState: 'unknown' });
  });

  it('a lost lease after the comment was created writes nothing; the next owner resolves it by the marker', async () => {
    const { store, portal, tick } = setup();
    const row = store.add();
    const original = portal.addDealComment.bind(portal);
    portal.addDealComment = async (dealId, comment) => {
      const id = await original(dealId, comment);
      store.rows.get(row.notificationId)!.leaseToken = 'stolen';
      return id;
    };
    await tick();
    expect(store.only()).toMatchObject({ status: 'pending', commentState: 'attempting', commentId: null });
    store.only().leaseToken = null;
    portal.addDealComment = original;
    await tick(MINUTE);
    expect(portal.calls.filter((call) => call === 'comment.add')).toHaveLength(1);
    expect(portal.comments).toHaveLength(1);
    expect(store.only()).toMatchObject({ status: 'sent', commentState: 'resolved' });
  });

  it('lost relay ownership before the request left records a refusal and stops the batch', async () => {
    const { store, portal, worker } = setup();
    store.add();
    store.add();
    let calls = 0;
    const guard = async () => {
      calls += 1;
      if (calls > 0) throw Object.assign(new Error('ownership lost'), { name: 'OwnershipLost' });
    };
    // The guard runs before every request: here before the deal read.
    await worker.runDue(guard);
    expect(portal.comments).toHaveLength(0);
    expect([...store.rows.values()].every((row) => row.status === 'pending' && row.commentState === 'none')).toBe(true);
  });

  it.each([false, true])('a database failure after a created comment never allows a second one (committed=%s)', async (applied) => {
    const { store, portal, tick } = setup();
    store.add();
    store.fault = { when: (patch) => patch.commentState === 'created', applied };
    await tick();
    expect(portal.calls.filter((call) => call === 'comment.add')).toHaveLength(1);
    expect(store.only().commentState).toBe(applied ? 'created' : 'attempting');
    await tick(2 * MINUTE);
    await tick(11 * MINUTE);
    expect(portal.calls.filter((call) => call === 'comment.add')).toHaveLength(1);
    expect(store.only()).toMatchObject({ status: 'sent' });
    expect(['created', 'resolved']).toContain(store.only().commentState);
  });

  it.each([false, true])('a database failure after a sent notification never repeats it (committed=%s)', async (applied) => {
    const { store, portal, tick } = setup();
    store.add();
    store.fault = { when: (patch) => patch.notifyState === 'sent', applied };
    await tick();
    await tick(2 * MINUTE);
    expect(portal.calls.filter((call) => call === 'notify')).toHaveLength(1);
    expect(store.only()).toMatchObject({ status: 'sent', notifyState: applied ? 'sent' : 'unknown' });
  });

  it('a malformed answer of the real client after the request left is an unknown outcome, not a refusal', async () => {
    const { store, worker, clock } = setup();
    const fetchFn = async (url: string) => {
      if (url.endsWith('/crm.item.get')) return new Response(JSON.stringify({ result: { item: { id: 7001, assignedById: 42 } } }));
      if (url.endsWith('/crm.timeline.comment.list')) return new Response(JSON.stringify({ result: [] }));
      return new Response('null');
    };
    const client = new Bitrix24ApiClient('https://portal.bitrix24.kz/rest/1/abcdef0123456789abcd', fetchFn as FetchFn, 30000, { now: () => clock.now, sleep: async (ms: number) => { clock.now += ms; } });
    (worker as unknown as { deps: { bitrix: Bitrix24ApiPort } }).deps.bitrix = client;
    store.add();
    await worker.runDue(async () => undefined);
    expect(store.only()).toMatchObject({ status: 'pending', commentState: 'unresolved', notifyState: 'unknown' });
  });

  it('never stores a webhook path or a token in last_error', async () => {
    const { store, portal, tick } = setup();
    portal.commentPlan = [new Bitrix24ApiError('crm.timeline.comment.add', 'HTTP_ERROR', 500, 'POST /rest/1/abcdef0123456789abcd/crm.timeline.comment.add access_token=zz11yy22 failed')];
    portal.assignedById = null;
    store.add();
    await tick();
    expect(store.only().lastError).toBeTruthy();
    expect(store.only().lastError).not.toContain('abcdef0123456789abcd');
    expect(store.only().lastError).not.toContain('zz11yy22');
  });
});
