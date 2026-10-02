import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { ProcurementNotificationsService, type ProcurementNotificationsRepositoryPort } from './procurement-notifications.service';

const user = (id: string): CurrentUser => ({ id, username: id, role: 'manager', roleId: 10, permissions: ['procurement.view', 'procurement.manage'] });
const MORNING = new Date('2026-10-02T04:00:00Z'); // 09:00 Almaty

function fakes(rules: Record<string, boolean>, overrides: Partial<ProcurementNotificationsRepositoryPort> = {}) {
  const repository: ProcurementNotificationsRepositoryPort = {
    isRuleEnabled: vi.fn(async (code: string) => rules[code] === true),
    loadSettings: vi.fn(async () => ({ digestTime: '08:30', unallocatedAlertDays: 2 })),
    permissionHolders: vi.fn(async () => [user('7'), user('8')]),
    scanDemandChanges: vi.fn(async () => 2),
    unallocatedReceipts: vi.fn(async (_older: string, _notBefore: string, after?: unknown) => (after ? [] : [{ documentId: 55, number: 'П-1', docDate: '2026-09-25', supplierName: null, lines: 2, remainingHash: 'h1' }])),
    writeServiceNotification: vi.fn(async () => true),
    ...overrides,
  };
  const worklist = { worklistTotals: vi.fn(async (viewer: CurrentUser) => (
    viewer.id === '7' ? { uncovered: 3, urgent: 1, deficitM2: 2, deficitLm: 0 } : { uncovered: 0, urgent: 0, deficitM2: 0, deficitLm: 0 })) };
  return { repository, worklist };
}

describe('ProcurementNotificationsService.runOnce', () => {
  it('flag off: nothing is read or written', async () => {
    const { repository, worklist } = fakes({});
    const service = new ProcurementNotificationsService({ repository, worklist, enabled: () => false, supplierRequestsEnabled: () => true, now: () => MORNING });
    expect(await service.runOnce()).toMatchObject({ skipped: 'disabled' });
    expect(repository.loadSettings).not.toHaveBeenCalled();
  });

  it('every kind runs only with its rule switched on', async () => {
    const { repository, worklist } = fakes({});
    const service = new ProcurementNotificationsService({ repository, worklist, enabled: () => true, supplierRequestsEnabled: () => true, now: () => MORNING });
    expect(await service.runOnce()).toEqual({ demandEvents: 0, digests: 0, unallocated: 0, failed: 0 });
    expect(repository.scanDemandChanges).not.toHaveBeenCalled();
    expect(repository.writeServiceNotification).not.toHaveBeenCalled();
  });

  it('digest per procurement.manage holder under his own worklist; empty digest skipped; keys per user and date', async () => {
    const { repository, worklist } = fakes({ 'procurement-deficit-digest': true });
    const service = new ProcurementNotificationsService({ repository, worklist, enabled: () => true, supplierRequestsEnabled: () => true, now: () => MORNING });
    expect((await service.runOnce()).digests).toBe(1);
    expect(repository.permissionHolders).toHaveBeenCalledWith('procurement.manage');
    expect(worklist.worklistTotals).toHaveBeenCalledTimes(2);
    expect(repository.writeServiceNotification).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'procurement.deficit_digest', key: 'procurement_digest:7:2026-10-02', userId: 7, entityType: 'procurement_worklist', entityId: null,
    }));
    // До времени сводки — ничего.
    const early = fakes({ 'procurement-deficit-digest': true });
    await new ProcurementNotificationsService({ ...early, enabled: () => true, supplierRequestsEnabled: () => true, now: () => new Date('2026-10-02T03:00:00Z') }).runOnce();
    expect(early.worklist.worklistTotals).not.toHaveBeenCalled();
  });

  it('unallocated: procurement.view holders × documents, key with the remaining hash; demand scan when its rule is on', async () => {
    const { repository, worklist } = fakes({ 'procurement-receipt-unallocated': true, 'procurement-demand-changed': true });
    const service = new ProcurementNotificationsService({ repository, worklist, enabled: () => true, supplierRequestsEnabled: () => true, now: () => MORNING });
    expect(await service.runOnce()).toEqual({ demandEvents: 2, digests: 0, unallocated: 2, failed: 0 });
    expect(repository.permissionHolders).toHaveBeenCalledWith('procurement.view');
    expect(repository.unallocatedReceipts).toHaveBeenCalledWith('2026-09-30', '2026-08-31', null);
    // Порции — по курсору до пустой.
    expect(repository.unallocatedReceipts).toHaveBeenCalledWith('2026-09-30', '2026-08-31', { docDate: '2026-09-25', documentId: 55 });
    expect(repository.writeServiceNotification).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'procurement.receipt_unallocated', key: 'procurement_unallocated:8:55:h1', entityType: 'onec_document', entityId: '55',
    }));
  });

  it('flag switched off mid-run stops writing', async () => {
    let on = true;
    const { repository, worklist } = fakes({ 'procurement-receipt-unallocated': true }, {
      writeServiceNotification: vi.fn(async () => { on = false; return true; }),
    });
    const service = new ProcurementNotificationsService({ repository, worklist, enabled: () => on, supplierRequestsEnabled: () => true, now: () => MORNING });
    expect((await service.runOnce()).unallocated).toBe(1);
  });

  it('CR1-3: switching the rule off during the digest stops it before the next write; the scanner gets the live check', async () => {
    let ruleOn = true;
    const { repository, worklist } = fakes({}, {
      isRuleEnabled: vi.fn(async (code: string) => code === 'procurement-deficit-digest' && ruleOn),
      permissionHolders: vi.fn(async () => [user('7'), user('9')]),
    });
    worklist.worklistTotals = vi.fn(async () => { ruleOn = false; return { uncovered: 5, urgent: 1, deficitM2: 1, deficitLm: 0 }; });
    const service = new ProcurementNotificationsService({ repository, worklist, enabled: () => true, supplierRequestsEnabled: () => true, now: () => MORNING });
    expect((await service.runOnce()).digests).toBe(0);
    expect(repository.writeServiceNotification).not.toHaveBeenCalled();
    expect(worklist.worklistTotals).toHaveBeenCalledTimes(1);
  });

  it('CR1-2: one recipient failing (any error) does not stop the others or the next kind', async () => {
    const { repository, worklist } = fakes({ 'procurement-deficit-digest': true, 'procurement-receipt-unallocated': true });
    worklist.worklistTotals = vi.fn(async (viewer: CurrentUser) => {
      if (viewer.id === '7') throw Object.assign(new Error('too many'), { code: 'PROCUREMENT_WORKLIST_TOO_MANY' });
      return { uncovered: 2, urgent: 0, deficitM2: 1, deficitLm: 0 };
    });
    const logger = { error: vi.fn() };
    const service = new ProcurementNotificationsService({ repository, worklist, enabled: () => true, supplierRequestsEnabled: () => true, now: () => MORNING, logger });
    expect(await service.runOnce()).toMatchObject({ digests: 1, unallocated: 2, failed: 1 });
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ scope: 'digest:7', errorCode: 'PROCUREMENT_WORKLIST_TOO_MANY' }));
  });
});

