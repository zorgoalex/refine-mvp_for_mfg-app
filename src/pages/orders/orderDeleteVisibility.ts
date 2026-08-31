import type { UserIdentity } from '../../types/auth';

export interface OrderDeleteVisibilitySubject {
  created_by?: string | number | null;
  manager_id?: string | number | null;
}

function sameUserId(value: string | number | null | undefined, userId: string): boolean {
  return value !== null && value !== undefined && String(value) === userId;
}

export function canDeleteOrderForUser(
  user: UserIdentity | null | undefined,
  order: unknown,
): boolean {
  if (!user?.permissions?.includes('orders.delete')) return false;

  const scope = user.policyScopes?.orders.delete;
  if (scope === 'all') return true;
  if (scope !== 'own' || !order || typeof order !== 'object') return false;

  const subject = order as OrderDeleteVisibilitySubject;

  return sameUserId(subject.created_by, user.id) || sameUserId(subject.manager_id, user.id);
}
