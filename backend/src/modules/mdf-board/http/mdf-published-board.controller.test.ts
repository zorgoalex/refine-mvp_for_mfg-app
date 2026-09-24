import { afterEach,describe,expect,it,vi } from 'vitest';
import type { Response } from 'express';
import type { CurrentUser } from '../../../permissions/current-user';
import { PermissionsService } from '../../../permissions/permissions.service';
import { MdfPublishedBoardService } from '../application/mdf-published-board.service';
import { MdfPublishedBoardController,mdfPublishedEtag,parseMdfPublishedQuery } from './mdf-published-board.controller';

const user: CurrentUser = { id: '1',username: 'test',role: 'admin',roleId: 2,permissions: ['orders.view'] };
const snapshot: Awaited<ReturnType<MdfPublishedBoardService['get']>> = {
  schemaVersion: 1,mode: 'active',revision: '1',generatedAt: '2026-09-21T12:00:00Z',dateFrom: '2026-07-21',dateTo: '2026-09-21',
  cards: [],positions: [],members: [],pendingJobs: [],trackedJobs: [],issues: [],
};
describe('published MDF read endpoint', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('normalizes bounded order selection without allowing arbitrary period length', () => {
    expect(parseMdfPublishedQuery({ orderIds: '12,5,12',dateTo: '2026-09-21',focusKind: 'bath',focusId: 'cut-result:14' }))
      .toEqual({ dateTo: '2026-09-21',orderIds: [5,12],focus: { kind: 'bath',id: 'cut-result:14' } });
  });
  it('normalizes exact job IDs and includes terminal results in the ETag', () => {
    const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    expect(parseMdfPublishedQuery({ jobIds: `${id.toUpperCase()},${id}` })).toEqual({ jobIds: [id] });
    const pending={ ...snapshot,trackedJobs: [{ jobId: id,kind: 'packet',id: 'p',status: 'pending',code: null,attempts: 0,orderIds: [1] }] };
    expect(mdfPublishedEtag(user,{}, { ...pending,trackedJobs: [{ ...pending.trackedJobs[0],status: 'done' }] }))
      .not.toBe(mdfPublishedEtag(user,{},pending));
  });
  it.each([
    { dateFrom: '2020-01-01' },{ dateTo: '2026-02-30' },{ dateTo: ['2026-09-21'] },{ dateTo: '0000-01-01' },
    { focusKind: 'packet' },{ focusKind: 'order',focusId: '1' },{ focusKind: 'bath',focusId: 'cut-result:9007199254740992' },
    { orderIds: '0' },{ orderIds: '9007199254740992' },{ orderIds: ['1'] },{ orderIds: '1 OR true' },
    { orderIds: Array.from({ length: 101 },(_,i) => i+1).join(',') },
    { jobIds: '' },{ jobIds: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'] },{ jobIds: 'not-a-uuid' },
    { jobIds: Array.from({ length: 21 },(_,i) => `${String(i).padStart(8,'0')}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`).join(',') },
  ])('rejects malformed/unbounded query %o',raw => {
    expect(() => parseMdfPublishedQuery(raw)).toThrow('Неверный период');
  });
  it('ETag excludes clock but includes pending state and current authorization', () => {
    const tag=mdfPublishedEtag(user,{},snapshot);
    expect(mdfPublishedEtag(user,{}, { ...snapshot,generatedAt: 'later' })).toBe(tag);
    expect(mdfPublishedEtag(user,{}, { ...snapshot,pendingJobs: [{ jobId: 'j',kind: 'packet',id: 'p',status: 'pending',code: null,attempts: 0,orderIds: [1] }] })).not.toBe(tag);
    expect(mdfPublishedEtag({ ...user,permissionsVersion: 2 },{},snapshot)).not.toBe(tag);
    expect(mdfPublishedEtag({ ...user,permissions: [] },{},snapshot)).not.toBe(tag);
    expect(mdfPublishedEtag(user,{ orderIds: [1] },snapshot)).not.toBe(tag);
  });
  it('checks permission before disabled flag/DB and before any matching-tag response', async () => {
    const database={ transaction: vi.fn() };
    const service=new MdfPublishedBoardService(database,new PermissionsService());
    const controller=new MdfPublishedBoardController(service);
    const denied={ ...user,permissions: [] };
    const response={ setHeader: vi.fn(),status: vi.fn(),end: vi.fn() } as unknown as Response;
    vi.stubEnv('BACKEND_MDF_PUBLISHED_READS','true');
    await expect(controller.get({ user: denied },{},mdfPublishedEtag(denied,{},snapshot),response))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(database.transaction).not.toHaveBeenCalled();
    expect(response.setHeader).not.toHaveBeenCalled();
    vi.stubEnv('BACKEND_MDF_PUBLISHED_READS','false');
    expect(() => service.get(user,{})).toThrow('Новый механизм');
    expect(database.transaction).not.toHaveBeenCalled();
  });
  it('requires authenticated user before parsing or accessing the service', async () => {
    const service=new MdfPublishedBoardService({ transaction: vi.fn() },new PermissionsService());
    const get=vi.spyOn(service,'get');
    const controller=new MdfPublishedBoardController(service);
    await expect(controller.get({}, { unexpected: true },undefined,{} as Response)).rejects.toMatchObject({ statusCode: 401 });
    expect(get).not.toHaveBeenCalled();
  });
  it('returns 304 only after an authorized fresh snapshot', async () => {
    const service=new MdfPublishedBoardService({ transaction: vi.fn() },new PermissionsService());
    const get=vi.spyOn(service,'get').mockResolvedValue(snapshot);
    const response={ setHeader: vi.fn(),status: vi.fn().mockReturnThis(),end: vi.fn() } as unknown as Response;
    const controller=new MdfPublishedBoardController(service);
    expect(await controller.get({ user },{},mdfPublishedEtag(user,{},snapshot),response)).toBeUndefined();
    expect(get).toHaveBeenCalledWith(user,{});
    expect(response.status).toHaveBeenCalledWith(304);
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control','private, no-cache');
  });
});
