import type { CurrentUser } from '../current-user';
import type { Scope } from './role-policies';

export interface ScopedEntity {
  createdByUserId?: string | null;
  ownerUserId?: string | null;
  managerUserId?: string | null;
  assignedUserIds?: readonly string[];
}

export function isOwn(user: CurrentUser, entity: ScopedEntity): boolean {
  return [entity.createdByUserId, entity.ownerUserId, entity.managerUserId].includes(user.id);
}

export function isAssigned(user: CurrentUser, entity: ScopedEntity): boolean {
  return entity.assignedUserIds?.includes(user.id) ?? false;
}

export function allowsScope(user: CurrentUser, scope: Scope, entity: ScopedEntity): boolean {
  switch (scope) {
    case 'all':
      return true;
    case 'own':
      return isOwn(user, entity);
    case 'assigned':
      return isAssigned(user, entity);
    case 'none':
      return false;
  }
}
