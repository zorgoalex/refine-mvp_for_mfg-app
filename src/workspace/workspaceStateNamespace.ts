import type { UserIdentity } from '../types/auth';
import { authSession } from '../api/authSession';
import { getUserAuthorizationScopeKey } from '../api/authScopeIdentity';

export interface WorkspaceStateNamespaceParts {
  actorUserId: string;
  sessionGeneration: number;
  scopeFingerprint: string;
}

export function getWorkspaceStateNamespaceParts(): WorkspaceStateNamespaceParts {
  const user = authSession.getUser();
  return {
    actorUserId: user ? String(user.id) : 'anonymous',
    sessionGeneration: authSession.getSessionGeneration(),
    scopeFingerprint: fingerprintWorkspaceScope(
      user ? getUserAuthorizationScopeKey(user) : 'anonymous',
    ),
  };
}

export function getWorkspaceStateNamespace(): string {
  return getWorkspaceStateNamespaceForUser(authSession.getUser(), authSession.getSessionGeneration());
}

/** Computes the destination before authSession publishes an identity transition. */
export function getWorkspaceStateNamespaceForUser(user: UserIdentity | null, sessionGeneration: number): string {
  const parts: WorkspaceStateNamespaceParts = {
    actorUserId: user ? String(user.id) : 'anonymous',
    sessionGeneration,
    scopeFingerprint: fingerprintWorkspaceScope(user ? getUserAuthorizationScopeKey(user) : 'anonymous'),
  };
  return [
    `actor:${encodeURIComponent(parts.actorUserId)}`,
    `session:${parts.sessionGeneration}`,
    `scope:${parts.scopeFingerprint}`,
  ].join('|');
}

function fingerprintWorkspaceScope(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
