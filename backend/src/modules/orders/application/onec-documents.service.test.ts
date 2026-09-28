import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { OnecDocumentsService, type OnecDocumentsPort } from './onec-documents.service';

function user(permissions: CurrentUser['permissions']): CurrentUser {
  return {
    id: '7',
    username: 'e2e-test-snabzhenets@example.test',
    role: 'viewer',
    roleId: 7,
    permissions,
  };
}

function fakeAuditClient() {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    return { rows: [{ audit_id: 'audit-1' }] };
  });
  return { query, calls } as unknown as { query: typeof query; calls: typeof calls };
}

function fakePort(overrides: Partial<OnecDocumentsPort> = {}): OnecDocumentsPort {
  return {
    list: vi.fn(),
    getCard: vi.fn(),
    addAllocation: vi.fn(),
    removeAllocation: vi.fn(),
    ...overrides,
  } as unknown as OnecDocumentsPort;
}

// --- readOptions --------------------------------------------------------

describe('OnecDocumentsService.readOptions', () => {
  it('grants canSeeAmounts only with finance.view (literal permission check)', () => {
    const service = new OnecDocumentsService({ documents: fakePort() });
    expect(service.readOptions(user(['procurement.view']), true)).toEqual({ procurementEnabled: true, canSeeAmounts: false });
    expect(service.readOptions(user(['procurement.view', 'finance.view']), true)).toEqual({ procurementEnabled: true, canSeeAmounts: true });
  });

  it('forwards procurementEnabled unchanged', () => {
    const service = new OnecDocumentsService({ documents: fakePort() });
    expect(service.readOptions(user([]), false)).toMatchObject({ procurementEnabled: false });
    expect(service.readOptions(user([]), true)).toMatchObject({ procurementEnabled: true });
  });
});

// --- list / getCard: procurement.view gate -------------------------------

describe('OnecDocumentsService.list / getCard permission gate', () => {
  it('denies list() without procurement.view and never calls the port', async () => {
    const list = vi.fn();
    const service = new OnecDocumentsService({ documents: fakePort({ list }) });
    await expect(service.list(user([]), { tab: 'receipts', page: 1, pageSize: 20 }, true))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });
    expect(list).not.toHaveBeenCalled();
  });

  it('denies getCard() without procurement.view and never calls the port', async () => {
    const getCard = vi.fn();
    const service = new OnecDocumentsService({ documents: fakePort({ getCard }) });
    await expect(service.getCard(user([]), 501, true))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });
    expect(getCard).not.toHaveBeenCalled();
  });

  it('a role granted only procurement.manage cannot list (literal procurement.view check)', async () => {
    const list = vi.fn();
    const service = new OnecDocumentsService({ documents: fakePort({ list }) });
    await expect(service.list(user(['procurement.manage']), { tab: 'receipts', page: 1, pageSize: 20 }, true))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });
    expect(list).not.toHaveBeenCalled();
  });

  it('delegates list() with procurement.view, passing readOptions as the third argument', async () => {
    const expected = { data: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 }, capabilities: {}, amountsVisible: false };
    const list = vi.fn().mockResolvedValue(expected);
    const service = new OnecDocumentsService({ documents: fakePort({ list }) });
    const query = { tab: 'receipts' as const, page: 1, pageSize: 20 };
    const currentUser = user(['procurement.view', 'finance.view']);

    await expect(service.list(currentUser, query, true)).resolves.toBe(expected);
    expect(list).toHaveBeenCalledWith(currentUser, query, { procurementEnabled: true, canSeeAmounts: true });
  });

  it('delegates getCard() with procurement.view, passing readOptions as the third argument', async () => {
    const expected = { data: {}, capabilities: {}, amountsVisible: false };
    const getCard = vi.fn().mockResolvedValue(expected);
    const service = new OnecDocumentsService({ documents: fakePort({ getCard }) });
    const currentUser = user(['procurement.view']);

    await expect(service.getCard(currentUser, 501, false)).resolves.toBe(expected);
    expect(getCard).toHaveBeenCalledWith(currentUser, 501, { procurementEnabled: false, canSeeAmounts: false });
  });
});

// --- addAllocation / removeAllocation: procurement.manage gate + denied audit --

describe('OnecDocumentsService.addAllocation / removeAllocation permission gate', () => {
  function addCommand(overrides: Partial<Parameters<OnecDocumentsService['addAllocation']>[0]> = {}) {
    return {
      currentUser: user(['procurement.manage']),
      documentId: 701,
      lineId: 1,
      orderId: 501,
      resourceKey: 'sheet_material:11',
      quantity: 3,
      expectedVersion: 0,
      expectedDemandFingerprint: 'a'.repeat(64),
      requestId: 'req-add-1',
      ...overrides,
    };
  }

  function removeCommand(overrides: Partial<Parameters<OnecDocumentsService['removeAllocation']>[0]> = {}) {
    return {
      currentUser: user(['procurement.manage']),
      documentId: 701,
      lineId: 1,
      allocationId: 9,
      expectedVersion: 0,
      requestId: 'req-remove-1',
      ...overrides,
    };
  }

  it('denies addAllocation without procurement.manage, records a denied audit row, and never calls the port', async () => {
    const addAllocation = vi.fn();
    const auditClient = fakeAuditClient();
    const service = new OnecDocumentsService({
      documents: fakePort({ addAllocation }),
      auditClient: auditClient as never,
    });

    await expect(service.addAllocation(addCommand({ currentUser: user(['procurement.view']) })))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });

    expect(addAllocation).not.toHaveBeenCalled();
    expect(auditClient.calls.length).toBeGreaterThan(0);
    const [firstCall] = auditClient.calls;
    expect(firstCall.text).toContain('INSERT INTO audit_log');
    expect(firstCall.params[0]).toBe('order_resource.onec_allocation_denied');
  });

  it('denies removeAllocation without procurement.manage, records a denied audit row, and never calls the port', async () => {
    const removeAllocation = vi.fn();
    const auditClient = fakeAuditClient();
    const service = new OnecDocumentsService({
      documents: fakePort({ removeAllocation }),
      auditClient: auditClient as never,
    });

    await expect(service.removeAllocation(removeCommand({ currentUser: user([]) })))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });

    expect(removeAllocation).not.toHaveBeenCalled();
    const [firstCall] = auditClient.calls;
    expect(firstCall.text).toContain('INSERT INTO audit_log');
    expect(firstCall.params[0]).toBe('order_resource.onec_allocation_denied');
  });

  it('a permission granted with only procurement.view is not enough for addAllocation (literal procurement.manage check)', async () => {
    const addAllocation = vi.fn();
    const service = new OnecDocumentsService({ documents: fakePort({ addAllocation }) });
    await expect(service.addAllocation(addCommand({ currentUser: user(['procurement.view']) })))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });
    expect(addAllocation).not.toHaveBeenCalled();
  });

  it('does not throw building the denied audit when no auditClient port is configured', async () => {
    const addAllocation = vi.fn();
    const service = new OnecDocumentsService({ documents: fakePort({ addAllocation }) });
    await expect(service.addAllocation(addCommand({ currentUser: user([]) })))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });
    expect(addAllocation).not.toHaveBeenCalled();
  });

  it('delegates a valid addAllocation call unchanged', async () => {
    const expected = { changed: true, allocationId: 1, orderId: 501, resourceKey: 'sheet_material:11', line: {} };
    const addAllocation = vi.fn().mockResolvedValue(expected);
    const service = new OnecDocumentsService({ documents: fakePort({ addAllocation }) });
    const command = addCommand();

    await expect(service.addAllocation(command)).resolves.toBe(expected);
    expect(addAllocation).toHaveBeenCalledWith(command);
  });

  it('delegates a valid removeAllocation call unchanged', async () => {
    const expected = { changed: true, allocationId: 9, orderId: 501, resourceKey: 'sheet_material:11', line: {} };
    const removeAllocation = vi.fn().mockResolvedValue(expected);
    const service = new OnecDocumentsService({ documents: fakePort({ removeAllocation }) });
    const command = removeCommand();

    await expect(service.removeAllocation(command)).resolves.toBe(expected);
    expect(removeAllocation).toHaveBeenCalledWith(command);
  });
});

describe('OnecDocumentsService — finance refusals are audited after the command rolls back (R1)', () => {
  it('records a denied audit when the port refuses a payment for missing finance.view, then rethrows', async () => {
    const { ApiError } = await import('../../../common/errors/api-error');
    const auditClient = fakeAuditClient();
    const refusal = new ApiError(403, 'PERMISSION_DENIED', 'Оплаты распределяет только пользователь с правом на финансы', {
      requiredPermissions: ['finance.view'],
    });
    const service = new OnecDocumentsService({
      documents: fakePort({ addAllocation: vi.fn().mockRejectedValue(refusal) }),
      auditClient: auditClient as never,
    });
    await expect(service.addAllocation({
      currentUser: user(['procurement.view', 'procurement.manage']), documentId: 7, lineId: 9, orderId: 11,
      resourceKey: 'sheet_material:1', amount: 100, expectedVersion: 0, expectedDemandFingerprint: 'a'.repeat(64), requestId: 'E2E-Тест-req',
    })).rejects.toBe(refusal);
    expect(auditClient.calls.some((call) => call.text.includes('INSERT INTO audit_log')
      && call.params.includes('order_resource.onec_allocation_denied'))).toBe(true);
  });

  it('does not audit other errors as finance refusals', async () => {
    const { ApiError } = await import('../../../common/errors/api-error');
    const auditClient = fakeAuditClient();
    const service = new OnecDocumentsService({
      documents: fakePort({ removeAllocation: vi.fn().mockRejectedValue(new ApiError(409, 'PROCUREMENT_VERSION_CONFLICT', 'stale')) }),
      auditClient: auditClient as never,
    });
    await expect(service.removeAllocation({
      currentUser: user(['procurement.view', 'procurement.manage']), documentId: 7, lineId: 9, allocationId: 3,
      expectedVersion: 1, requestId: 'E2E-Тест-req',
    })).rejects.toMatchObject({ code: 'PROCUREMENT_VERSION_CONFLICT' });
    expect(auditClient.calls).toHaveLength(0);
  });
});
