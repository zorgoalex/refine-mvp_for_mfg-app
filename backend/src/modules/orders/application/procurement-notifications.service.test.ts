import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { ServiceRuleState } from '../adapters/pg-procurement-notifications-repository';
import { ProcurementNotificationsService, type ProcurementNotificationsRepositoryPort } from './procurement-notifications.service';

const user = (id: string): CurrentUser => ({ id, username: id, role: 'manager', roleId: 10, permissions: ['procurement.view', 'procurement.manage'] });
const MORNING = new Date('2026-10-02T04:00:00Z'); // 09:00 Almaty
const rule = (ruleCode: string, isEnabled: boolean, recipients: Partial<Pick<ServiceRuleState, 'roleCodes' | 'userIds'>> = {}): ServiceRuleState => ({
  ruleCode, isEnabled, roleCodes: recipients.roleCodes ?? [], userIds: recipients.userIds ?? [], recipientsHash: `hash-${ruleCode}`,
});
const RECEIPTS = [
  { documentId: 55, number: 'П-1', docDate: '2026-09-10', supplierName: 'Альфа', lines: 2, remainingHash: 'h1' },
  { documentId: 56, number: 'П-2', docDate: '2026-09-28', supplierName: null, lines: 1, remainingHash: 'h2' },
];

function fakes(rules: Record<string, boolean>, overrides: Partial<ProcurementNotificationsRepositoryPort> = {}) {
  const repository: ProcurementNotificationsRepositoryPort = {
    isRuleEnabled: vi.fn(async (code: string) => rules[code] === true),
    loadRule: vi.fn(async (code: string) => rule(code, rules[code] === true)),
    loadSettings: vi.fn(async () => ({ digestTime: '08:30', unallocatedAlertDays: 2 })),
    ruleRecipients: vi.fn(async () => [user('7'), user('8')]),
    scanDemandChanges: vi.fn(async () => 2),
    unallocatedReceipts: vi.fn(async (_older: string, _notBefore: string, after?: unknown) => (after ? [] : RECEIPTS)),
    writeServiceNotification: vi.fn(async () => true),
    ...overrides,
  };
  const worklist = { worklistTotals: vi.fn(async (viewer: CurrentUser) => (
    viewer.id === '7' ? { uncovered: 3, urgent: 1, deficitM2: 2, deficitLm: 0 } : { uncovered: 0, urgent: 0, deficitM2: 0, deficitLm: 0 })) };
  return { repository, worklist };
}

const make = (f: ReturnType<typeof fakes>, extra: Partial<ConstructorParameters<typeof ProcurementNotificationsService>[0]> = {}) =>
  new ProcurementNotificationsService({ ...f, enabled: () => true, supplierRequestsEnabled: () => true, now: () => MORNING, ...extra });

describe('ProcurementNotificationsService.runOnce', () => {
  it('flag off: nothing is read or written', async () => {
    const f = fakes({});
    expect(await make(f, { enabled: () => false }).runOnce()).toMatchObject({ skipped: 'disabled' });
    expect(f.repository.loadSettings).not.toHaveBeenCalled();
  });

  it('every kind runs only with its rule switched on; the run reports the rule state', async () => {
    const f = fakes({});
    expect(await make(f).runOnce()).toEqual({
      demandEvents: 0, digests: 0, unallocated: 0, failed: 0, rulesEnabled: { demandChanged: false, digest: false, unallocated: false },
    });
    expect(f.repository.scanDemandChanges).not.toHaveBeenCalled();
    expect(f.repository.ruleRecipients).not.toHaveBeenCalled();
    expect(f.repository.writeServiceNotification).not.toHaveBeenCalled();
  });

  it('deficit digest: recipients from the rule (default procurement.manage, always required), own worklist, guard with the rule hash', async () => {
    const f = fakes({ 'procurement-deficit-digest': true });
    expect((await make(f).runOnce()).digests).toBe(1);
    expect(f.repository.ruleRecipients).toHaveBeenCalledWith(expect.objectContaining({ ruleCode: 'procurement-deficit-digest' }), 'procurement.manage', ['procurement.manage']);
    expect(f.worklist.worklistTotals).toHaveBeenCalledTimes(2);
    expect(f.repository.writeServiceNotification).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'procurement.deficit_digest', key: 'procurement_digest:7:2026-10-02', userId: 7, entityType: 'procurement_worklist', entityId: null,
    }), { ruleCode: 'procurement-deficit-digest', recipientsHash: 'hash-procurement-deficit-digest' });
  });

  it('before the digest time nothing scheduled runs (both summaries are daily)', async () => {
    const f = fakes({ 'procurement-deficit-digest': true, 'procurement-receipt-unallocated': true });
    await make(f, { now: () => new Date('2026-10-02T03:00:00Z') }).runOnce();
    expect(f.worklist.worklistTotals).not.toHaveBeenCalled();
    expect(f.repository.unallocatedReceipts).not.toHaveBeenCalled();
  });

  it('unallocated: ONE daily summary per recipient (procurement.view required), aggregate user, key per user and date', async () => {
    const f = fakes({ 'procurement-receipt-unallocated': true, 'procurement-demand-changed': true });
    expect(await make(f).runOnce()).toMatchObject({ demandEvents: 2, digests: 0, unallocated: 2, failed: 0 });
    expect(f.repository.ruleRecipients).toHaveBeenCalledWith(expect.objectContaining({ ruleCode: 'procurement-receipt-unallocated' }), 'procurement.manage', ['procurement.view']);
    expect(f.repository.unallocatedReceipts).toHaveBeenCalledWith('2026-09-30', '2026-08-31', null);
    expect(f.repository.unallocatedReceipts).toHaveBeenCalledWith('2026-09-30', '2026-08-31', { docDate: '2026-09-28', documentId: 56 });
    expect(f.repository.writeServiceNotification).toHaveBeenCalledTimes(2);
    expect(f.repository.writeServiceNotification).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'procurement.receipt_unallocated', aggregateType: 'user', aggregateId: '8',
      key: 'procurement_unallocated_digest:8:2026-10-02', entityType: 'procurement_receipts', entityId: null,
      title: 'Нераспределённые поступления на 02.10.2026',
      message: 'Не распределены поступления 1С: 2 (строк — 3), из них старше 7 дней — 1. Поступления: № П-1 от 10.09.2026 (Альфа), № П-2 от 28.09.2026. Подробности — экран снабжения, «Приходы».',
    }), { ruleCode: 'procurement-receipt-unallocated', recipientsHash: 'hash-procurement-receipt-unallocated' });
  });

  it('unallocated: nothing pending → no summary; no recipients → receipts are not even read', async () => {
    const empty = fakes({ 'procurement-receipt-unallocated': true }, { unallocatedReceipts: vi.fn(async () => []) });
    expect((await make(empty).runOnce()).unallocated).toBe(0);
    expect(empty.repository.writeServiceNotification).not.toHaveBeenCalled();
    const nobody = fakes({ 'procurement-receipt-unallocated': true }, { ruleRecipients: vi.fn(async () => []) });
    await make(nobody).runOnce();
    expect(nobody.repository.unallocatedReceipts).not.toHaveBeenCalled();
  });

  it('flag switched off mid-run stops writing', async () => {
    let on = true;
    const f = fakes({ 'procurement-receipt-unallocated': true }, { writeServiceNotification: vi.fn(async () => { on = false; return true; }) });
    expect((await make(f, { enabled: () => on }).runOnce()).unallocated).toBe(1);
  });

  it('CR1-3: switching the rule off during the digest stops it before the next write', async () => {
    let ruleOn = true;
    const f = fakes({}, {
      isRuleEnabled: vi.fn(async (code: string) => code === 'procurement-deficit-digest' && ruleOn),
      loadRule: vi.fn(async (code: string) => rule(code, code === 'procurement-deficit-digest' && ruleOn)),
      ruleRecipients: vi.fn(async () => [user('7'), user('9')]),
    });
    f.worklist.worklistTotals = vi.fn(async () => { ruleOn = false; return { uncovered: 5, urgent: 1, deficitM2: 1, deficitLm: 0 }; });
    expect((await make(f).runOnce()).digests).toBe(0);
    expect(f.repository.writeServiceNotification).not.toHaveBeenCalled();
    expect(f.worklist.worklistTotals).toHaveBeenCalledTimes(1);
  });

  it('a guarded write refused by the repository (rule off / recipients changed) is not counted', async () => {
    const f = fakes({ 'procurement-receipt-unallocated': true }, { writeServiceNotification: vi.fn(async () => false) });
    expect((await make(f).runOnce()).unallocated).toBe(0);
  });

  it('CR1-2: one recipient failing (any error) does not stop the others or the next kind', async () => {
    const f = fakes({ 'procurement-deficit-digest': true, 'procurement-receipt-unallocated': true });
    f.worklist.worklistTotals = vi.fn(async (viewer: CurrentUser) => {
      if (viewer.id === '7') throw Object.assign(new Error('too many'), { code: 'PROCUREMENT_WORKLIST_TOO_MANY' });
      return { uncovered: 2, urgent: 0, deficitM2: 1, deficitLm: 0 };
    });
    const logger = { error: vi.fn() };
    expect(await make(f, { logger }).runOnce()).toMatchObject({ digests: 1, unallocated: 2, failed: 1 });
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ scope: 'digest:7', errorCode: 'PROCUREMENT_WORKLIST_TOO_MANY' }));
  });
});
