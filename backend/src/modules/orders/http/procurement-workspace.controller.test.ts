import { describe, expect, it } from 'vitest';
import { ProcurementWorkspaceService } from '../application/procurement-workspace.service';
import { savedViewsSchema, settingsSchema, worklistQuerySchema } from './procurement-workspace.controller';

describe('worklist query parsing', () => {
  it('defaults to «требует действия», без группировки, по сроку', () => {
    expect(worklistQuerySchema.parse({})).toEqual({ preset: 'action', groupBy: 'none', sort: 'due' });
  });

  it('parses every server-side filter', () => {
    expect(worklistQuerySchema.parse({
      preset: 'urgent', search: '  2972 ', dueFrom: '2026-09-01', dueTo: '2026-09-30', kind: 'film',
      supplierKey: 's:3', coverage: 'none,partial,none', onecDocumentId: '17', groupBy: 'supplier', sort: 'deficit',
    })).toEqual({
      preset: 'urgent', search: '2972', dueFrom: '2026-09-01', dueTo: '2026-09-30', kind: 'film',
      supplierKey: 's:3', coverage: ['none', 'partial'], onecDocumentId: 17, groupBy: 'supplier', sort: 'deficit',
    });
  });

  it.each([
    [{ preset: 'hot' }],
    [{ dueFrom: '2026-02-30' }],
    [{ dueFrom: '2026-10-02', dueTo: '2026-10-01' }],
    [{ coverage: 'none,unknown' }],
    [{ supplierKey: 'x:1' }],
    [{ unexpected: '1' }],
    [{ onecDocumentId: '0' }],
  ])('rejects %j', (query) => {
    expect(worklistQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('settings and saved views validation', () => {
  const valid = { leadDays: 2, criticalDays: 3, soonDays: 7, wastePercent: 5, digestTime: '08:30', unallocatedAlertDays: 2, overdueWindowDays: 30, expectedVersion: 1 };

  it('CR3-1: the OpenAPI body schema lists exactly the fields the validator requires', async () => {
    const { readFileSync } = await import('node:fs');
    const { load } = await import('js-yaml');
    const root = process.cwd().endsWith('backend') ? '.' : 'backend';
    const contract = load(readFileSync(`${root}/contracts/04-api-contract.openapi.yaml`, 'utf8')) as {
      paths: Record<string, { put: { requestBody: { content: { 'application/json': { schema: { required: string[]; properties: Record<string, unknown> } } } } } }>;
    };
    const schema = contract.paths['/api/v1/procurement/settings'].put.requestBody.content['application/json'].schema;
    expect([...schema.required].sort()).toEqual(Object.keys(valid).sort());
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(valid).sort());
  });

  it('accepts the defaults and checks the ranges', () => {
    expect(settingsSchema.safeParse(valid).success).toBe(true);
    expect(settingsSchema.safeParse({ ...valid, wastePercent: 0 }).success).toBe(true);
    expect(settingsSchema.safeParse({ ...valid, criticalDays: 8 }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...valid, wastePercent: 5.555 }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...valid, digestTime: '24:00' }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...valid, leadDays: 61 }).success).toBe(false);
  });

  it('limits saved views to 20 unique entries', () => {
    const view = (id: string) => ({ id, name: 'Срочно', query: 'preset=urgent' });
    expect(savedViewsSchema.safeParse({ views: [view('11111111-1111-4111-8111-111111111111')] }).success).toBe(true);
    const same = '22222222-2222-4222-8222-222222222222';
    expect(savedViewsSchema.safeParse({ views: [view(same), view(same)] }).success).toBe(false);
    expect(savedViewsSchema.safeParse({ views: [{ ...view(same), query: '?preset=all' }] }).success).toBe(false);
  });
});

describe('ProcurementWorkspaceService permissions', () => {
  const repo = {
    getSettings: async () => ({}) as never,
    updateSettings: async () => ({ changed: true, settings: {} as never }),
    listWorklist: async () => ({}) as never,
    getSavedViews: async () => [],
    replaceSavedViews: async () => [],
  };
  const user = (permissions: string[]) => ({ id: '5', username: 'u', role: 'manager', roleId: 10, permissions });

  it('worklist and saved views require procurement.view literally', async () => {
    const service = new ProcurementWorkspaceService({ repository: repo });
    const options = { procurementEnabled: true, supplyWorkspaceEnabled: true };
    await expect(service.listWorklist(user(['orders.view']), { preset: 'all', groupBy: 'none', sort: 'due' }, options))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(service.getSavedViews(user(['procurement.manage']))).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.getSavedViews(user(['procurement.view']))).resolves.toEqual([]);
  });

  it('settings: read with procurement.view or settings.manage, write only with settings.manage + denied audit', async () => {
    const denied: unknown[] = [];
    const auditClient = { query: async (_sql: string, params: unknown[]) => { denied.push(params); return { rows: [], rowCount: 1 }; } };
    const service = new ProcurementWorkspaceService({ repository: repo, auditClient: auditClient as never });
    await expect(service.getSettings(user(['procurement.view']))).resolves.toBeDefined();
    await expect(service.getSettings(user(['settings.manage']))).resolves.toBeDefined();
    await expect(service.getSettings(user(['orders.view']))).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.updateSettings({
      currentUser: user(['procurement.view', 'procurement.manage']), requestId: 'r1', expectedVersion: 1,
      settings: { leadDays: 2, criticalDays: 3, soonDays: 7, wastePercent: 5, digestTime: '08:30', unallocatedAlertDays: 2, overdueWindowDays: 30 },
    })).rejects.toMatchObject({ statusCode: 403 });
    expect(denied.length).toBeGreaterThan(0);
    await expect(service.updateSettings({
      currentUser: user(['settings.manage']), requestId: 'r2', expectedVersion: 1,
      settings: { leadDays: 2, criticalDays: 3, soonDays: 7, wastePercent: 5, digestTime: '08:30', unallocatedAlertDays: 2, overdueWindowDays: 30 },
    })).resolves.toMatchObject({ changed: true });
  });
});
