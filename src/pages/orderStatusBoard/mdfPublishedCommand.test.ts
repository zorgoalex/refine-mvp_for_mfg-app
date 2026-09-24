import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { authSession } from '../../api/authSession';
import { mdfPublishedApi } from '../../api/mdfPublishedApi';
import type { MdfSessionSnapshot } from '../../api/types/mdfPublishedApi.types';
import { mdfPublishedJobProgress,prepareMdfPublishedCommand } from './mdfPublishedCommand';

const source={ kind: 'packet' as const,id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
const jobId='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
function view(): MdfSessionSnapshot {
  return { sessionGeneration: authSession.getSessionGeneration(),snapshot: {
    schemaVersion: 1,mode: 'active',revision: '1',generatedAt: 'now',dateFrom: '2026-07-22',dateTo: '2026-09-22',
    cards: [{ ...source,displayName: 'E2E file',column: 'parsed',sourceCreatedAt: '2026-09-01',
      acceptedRevision: 'r1',receivedRevision: 'r1',commandToken: 'a'.repeat(64),issues: [] }],
    members: [],positions: [],pendingJobs: [],trackedJobs: [],issues: [],
  } };
}
const json=(body: unknown,status=200) => new Response(JSON.stringify(body),{ status,headers: { 'Content-Type': 'application/json' } });
const user=(id='1') => ({ id,username: `E2E ${id}`,role: 'admin',permissions: ['orders.view','production.tasks.update'] });

describe('session-bound MDF publication command protocol',() => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL','');
    authSession.clear();authSession.setUser(user());authSession.setAccessToken('test-token');
  });
  afterEach(() => { authSession.clear();vi.unstubAllGlobals();vi.unstubAllEnvs(); });
  it('freezes the displayed version, coalesces double clicks, and reuses exact payload on explicit retry',async () => {
    const fetchMock=vi.fn().mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce(json({ jobId }));
    vi.stubGlobal('fetch',fetchMock);
    const displayed=view(),prepared=prepareMdfPublishedCommand(displayed,source,'completed');
    displayed.snapshot.cards[0].commandToken='b'.repeat(64);
    const first=prepared.execute();
    expect(prepared.execute()).toBe(first);
    await expect(first).rejects.toThrow('lost response');
    await expect(prepared.execute()).resolves.toEqual({ jobId });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [,options] of fetchMock.mock.calls) {
      expect(options.body).toBe(JSON.stringify({ targetColumn: 'completed' }));
      expect(new Headers(options.headers).get('X-Mdf-Source-Token')).toBe('a'.repeat(64));
      expect(new Headers(options.headers).get('Idempotency-Key')).toBe(prepared.command.idempotencyKey);
    }
    expect(Object.isFrozen(prepared.command)).toBe(true);
  });
  it('sends explicit clear with the same proof contract',async () => {
    const fetchMock=vi.fn().mockResolvedValue(json({ jobId }));vi.stubGlobal('fetch',fetchMock);
    await prepareMdfPublishedCommand(view(),source,null).execute();
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });
  it.each(['read_only','null-token','issue','pending','different-revision','wrong-id','wrong-kind','wrong-target'])(
    'rejects non-commandable displayed state: %s',reason => {
      const displayed=view();
      if (reason==='read_only') displayed.snapshot.mode='read_only';
      if (reason==='null-token') displayed.snapshot.cards[0].commandToken=null;
      if (reason==='issue') displayed.snapshot.cards[0].issues=['VERIFY'];
      if (reason==='different-revision') displayed.snapshot.cards[0].acceptedRevision='old';
      if (reason==='pending') displayed.snapshot.pendingJobs=[{ ...source,jobId,status: 'pending',code: null,attempts: 0,orderIds: [1] }];
      const requested=reason==='wrong-id' ? { ...source,id: 'other' }
        : reason==='wrong-kind' ? { ...source,kind: 'bath' as const } : source;
      expect(() => prepareMdfPublishedCommand(displayed,requested,reason==='wrong-target' ? 'baths' : 'completed'))
        .toThrow('MDF_COMMAND_NOT_READY');
    });
  it('rejects old snapshots and old retries after logout/login, even for the same user',async () => {
    const displayed=view(),prepared=prepareMdfPublishedCommand(displayed,source,'completed');
    const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
    authSession.clear();authSession.setUser(user());authSession.setAccessToken('new-token');
    expect(() => prepared.execute()).toThrow('MDF_SESSION_CHANGED');
    expect(() => prepareMdfPublishedCommand(displayed,source,'completed')).toThrow('MDF_SESSION_CHANGED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([200,401])('quarantines late %i and never replays under the new user',async status => {
    let finish!: (r: Response) => void;
    const fetchMock=vi.fn().mockImplementation(() => new Promise<Response>(resolve => { finish=resolve; }));
    vi.stubGlobal('fetch',fetchMock);
    const promise=prepareMdfPublishedCommand(view(),source,'completed').execute();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    authSession.setUser(user('2'));authSession.setAccessToken('other-token');
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    finish(json({ jobId },status));
    await expect(promise).rejects.toThrow('MDF_SESSION_CHANGED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('does not retry 401 or call successful HTTP response an applied command',async () => {
    const fetchMock=vi.fn().mockResolvedValueOnce(json({},401)).mockResolvedValueOnce(json({ changed: true }));
    vi.stubGlobal('fetch',fetchMock);
    const prepared=prepareMdfPublishedCommand(view(),source,'completed');
    await expect(prepared.execute()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(prepared.execute()).rejects.toThrow('MDF_COMMAND_RECEIPT_MISSING');
  });
  it('tracks only exact jobs, preserving missing, pending, superseded and attention states',() => {
    const displayed=view();
    expect(mdfPublishedJobProgress(displayed,jobId,source)).toBe('missing');
    for (const status of ['pending','done','superseded','needs_attention'] as const) {
      displayed.snapshot.trackedJobs=[{ ...source,jobId,status,code: null,attempts: 1,orderIds: [1] }];
      expect(mdfPublishedJobProgress(displayed,jobId,source)).toBe(status);
      expect(mdfPublishedJobProgress(displayed,jobId,{ ...source,id: 'other' })).toBe('missing');
    }
    displayed.snapshot.mode='legacy';
    expect(mdfPublishedJobProgress(displayed,jobId,source)).toBe('unavailable');
  });
  it('reads the exact typed publication with encoded query, signal, and no legacy fallback/cache',async () => {
    const displayed=view(),fetchMock=vi.fn().mockResolvedValue(json(displayed.snapshot));vi.stubGlobal('fetch',fetchMock);
    const controller=new AbortController();
    const result=await mdfPublishedApi.get({ dateTo: '2026-09-22',focus: { kind: 'bath',id: 'cut-result:42' },
      orderIds: [3,4],jobIds: [jobId] },controller.signal);
    expect(result).toEqual(displayed);
    const [url,options]=fetchMock.mock.calls[0];
    expect(url).toBe(`/api/v1/orders/status-board/mdf?dateTo=2026-09-22&focusKind=bath&focusId=cut-result%3A42&orderIds=3%2C4&jobIds=${jobId}`);
    expect(options.signal).toBe(controller.signal);expect(options.cache).toBe('no-store');
  });
  it('quarantines a publication loaded by a previous session',async () => {
    let finish!: (r: Response) => void;
    const fetchMock=vi.fn().mockImplementation(() => new Promise<Response>(resolve => { finish=resolve; }));
    vi.stubGlobal('fetch',fetchMock);
    const displayed=view(),promise=mdfPublishedApi.get();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    authSession.setUser(user('2'));finish(json(displayed.snapshot));
    await expect(promise).rejects.toThrow('MDF_SESSION_CHANGED');
  });
});
