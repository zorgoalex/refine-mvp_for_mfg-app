import { describe, expect, it, vi } from 'vitest';
import { OrgController } from './org.controller';

const enabledWritable = { getFeatureFlags: () => ({ orgEnabled: true, orgReadOnly: false }) } as any;
const disabled = { getFeatureFlags: () => ({ orgEnabled: false, orgReadOnly: true }) } as any;
const readOnly = { getFeatureFlags: () => ({ orgEnabled: true, orgReadOnly: true }) } as any;
const user = { id: '3', username: 'a', role: 'admin', roleId: 1, permissions: ['org.view', 'org.manage'] };
const req = (u: any = user) => ({ user: u, requestId: 'req-1' }) as any;

function build(rc: any) {
  const service = {
    listDirections: vi.fn().mockResolvedValue([]),
    getDirection: vi.fn().mockResolvedValue({ directionId: 1 }),
    createDirection: vi.fn().mockResolvedValue({ directionId: 1 }),
    updateDirection: vi.fn().mockResolvedValue({ directionId: 1 }),
    deleteDirection: vi.fn().mockResolvedValue({ directionId: 1 }),
    replaceDirectionWorkshops: vi.fn().mockResolvedValue({ directionId: 1 }),
    replaceDirectionWorkCenters: vi.fn().mockResolvedValue({ directionId: 1 }),
    replaceDirectionHeads: vi.fn().mockResolvedValue({ directionId: 1 }),
    listWorkshopHeads: vi.fn().mockResolvedValue([]),
    replaceWorkshopHeads: vi.fn().mockResolvedValue([]),
    assignableUsers: vi.fn().mockResolvedValue([]),
    lookupWorkshops: vi.fn().mockResolvedValue([]),
    lookupWorkCenters: vi.fn().mockResolvedValue([]),
  } as any;
  return { service, controller: new OrgController(service, rc) };
}

const validReplace = { idempotencyKey: 'k1', ids: [1] };

const readCalls: Array<[string, (c: any) => Promise<unknown>]> = [
  ['listDirections', (c) => c.listDirections(req())],
  ['getDirection', (c) => c.getDirection(req(), '1')],
  ['listWorkshopHeads', (c) => c.listWorkshopHeads(req(), '1')],
  ['assignableUsers', (c) => c.assignableUsers(req())],
  ['lookupWorkshops', (c) => c.lookupWorkshops(req())],
  ['lookupWorkCenters', (c) => c.lookupWorkCenters(req())],
];
const writeCalls: Array<[string, (c: any) => Promise<unknown>]> = [
  ['createDirection', (c) => c.createDirection(req(), { name: 'X' })],
  ['updateDirection', (c) => c.updateDirection(req(), '1', { name: 'X' })],
  ['deleteDirection', (c) => c.deleteDirection(req(), '1', 'true')],
  ['replaceDirectionWorkshops', (c) => c.replaceDirectionWorkshops(req(), '1', validReplace)],
  ['replaceDirectionWorkCenters', (c) => c.replaceDirectionWorkCenters(req(), '1', validReplace)],
  ['replaceDirectionHeads', (c) => c.replaceDirectionHeads(req(), '1', validReplace)],
  ['replaceWorkshopHeads', (c) => c.replaceWorkshopHeads(req(), '1', validReplace)],
];

describe('OrgController gates', () => {
  it.each([...readCalls, ...writeCalls])('%s returns 503 when the flag is disabled', async (_name, call) => {
    const { controller } = build(disabled);
    await expect(call(controller)).rejects.toMatchObject({ statusCode: 503 });
  });

  it.each(writeCalls)('%s returns 503 when read-only', async (_name, call) => {
    const { controller } = build(readOnly);
    await expect(call(controller)).rejects.toMatchObject({ statusCode: 503 });
  });

  it('401 when unauthenticated', async () => {
    const { controller } = build(enabledWritable);
    const noUser = { user: undefined, requestId: 'req-1' } as any;
    await expect(controller.listDirections(noUser)).rejects.toMatchObject({ statusCode: 401 });
    await expect(controller.createDirection(noUser, { name: 'X' })).rejects.toMatchObject({ statusCode: 401 });
  });

  it('delegates create when enabled + writable', async () => {
    const { controller, service } = build(enabledWritable);
    await controller.createDirection(req(), { name: 'Покраска' });
    expect(service.createDirection).toHaveBeenCalled();
  });

  it('rejects hard delete without confirm=true (422), delegates with confirm', async () => {
    const { controller, service } = build(enabledWritable);
    await expect(controller.deleteDirection(req(), '1', undefined as any)).rejects.toMatchObject({ statusCode: 422 });
    await controller.deleteDirection(req(), '1', 'true');
    expect(service.deleteDirection).toHaveBeenCalled();
  });
});
