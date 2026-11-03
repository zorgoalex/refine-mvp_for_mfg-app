import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import { resolveOrderManagerAssignment, type OrderManagerAssignmentInput } from './order-manager-assignment';

const base: OrderManagerAssignmentInput = {
  mode: 'update',
  currentUserId: '7',
  storedManagerId: '10',
  managerUserId: undefined,
  legacyManagerId: undefined,
  canChangeManager: false,
};

function failure(input: Partial<OrderManagerAssignmentInput>): ApiError {
  try {
    resolveOrderManagerAssignment({ ...base, ...input });
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected an ApiError');
}

describe('resolveOrderManagerAssignment', () => {
  it('create: no manager given → the current user, not a change', () => {
    expect(resolveOrderManagerAssignment({ ...base, mode: 'create', storedManagerId: null }))
      .toEqual({ managerId: '7', changed: false, previousManagerId: null });
  });

  it('create: another manager needs orders.manager.change', () => {
    expect(failure({ mode: 'create', storedManagerId: null, managerUserId: 10 }).code).toBe('ORDER_MANAGER_CHANGE_FORBIDDEN');
    expect(resolveOrderManagerAssignment({ ...base, mode: 'create', storedManagerId: null, managerUserId: 10, canChangeManager: true }))
      .toEqual({ managerId: '10', changed: true, previousManagerId: null });
  });

  it('update: absent or null keeps the stored manager (it no longer goes to whoever saves)', () => {
    expect(resolveOrderManagerAssignment(base)).toEqual({ managerId: '10', changed: false, previousManagerId: '10' });
    expect(resolveOrderManagerAssignment({ ...base, managerUserId: null, legacyManagerId: null }).managerId).toBe('10');
    expect(resolveOrderManagerAssignment({ ...base, storedManagerId: null }).managerId).toBeNull();
  });

  it('update: the same manager is not a change and needs no permission', () => {
    expect(resolveOrderManagerAssignment({ ...base, managerUserId: 10 }).changed).toBe(false);
  });

  it('update: another manager needs the permission; with it the change is reported with both ids', () => {
    expect(failure({ managerUserId: 12 }).statusCode).toBe(403);
    expect(resolveOrderManagerAssignment({ ...base, managerUserId: 12, canChangeManager: true }))
      .toEqual({ managerId: '12', changed: true, previousManagerId: '10' });
  });

  it('former field: «no change» passes, any other value is an outdated form (409), even for an administrator', () => {
    expect(resolveOrderManagerAssignment({ ...base, legacyManagerId: 10 }).managerId).toBe('10');
    const outdated = failure({ legacyManagerId: 3, canChangeManager: true });
    expect(outdated.statusCode).toBe(409);
    expect(outdated.code).toBe('ORDER_FORM_OUTDATED');
    expect(failure({ mode: 'create', storedManagerId: null, legacyManagerId: 3, canChangeManager: true }).code)
      .toBe('ORDER_FORM_OUTDATED');
    expect(resolveOrderManagerAssignment({ ...base, mode: 'create', storedManagerId: null, legacyManagerId: 7 }).managerId)
      .toBe('7');
  });

  it('the new field wins over the former one', () => {
    expect(resolveOrderManagerAssignment({ ...base, managerUserId: 12, legacyManagerId: 3, canChangeManager: true }).managerId)
      .toBe('12');
  });
});
