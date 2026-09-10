/** Source identity, never an authorization principal. */
export interface BitrixActor {
  bitrixUserId: string;
  displayName: string | null;
  erpUserId?: number | null;
  erpDisplayName?: string | null;
}

export function bitrixActorId(value: unknown): string | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const id = String(value);
  return /^[1-9][0-9]{0,15}$/.test(id) && Number.isSafeInteger(Number(id)) ? id : null;
}

export function bitrixFullName(user: Record<string, unknown>): string | null {
  return [user.NAME ?? user.name, user.SECOND_NAME ?? user.secondName, user.LAST_NAME ?? user.lastName]
    .filter((part): part is string => typeof part === 'string')
    .map(part => part.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).filter(Boolean).join(' ').slice(0, 300) || null;
}

// Trusted SQL expressions only; never request input.
export function actorSql(id: string, name: string): string {
  return `(SELECT CASE WHEN ${id} IS NULL THEN NULL ELSE jsonb_build_object(
    'bitrixUserId', ${id}, 'displayName', ${name},
    'erpUserId', target.user_id, 'erpDisplayName', COALESCE(NULLIF(target.full_name,''),target.username)) END
    FROM (SELECT 1) identity_anchor
    LEFT JOIN bitrix24_user_mapping actor_mapping ON actor_mapping.bitrix_user_id=${id} AND actor_mapping.is_active=true
    LEFT JOIN users target ON target.user_id=actor_mapping.erp_user_id AND target.is_active=true AND target.is_service_account=false)`;
}

export function dealCreatorSql(dealId: string): string {
  return `(SELECT ${actorSql("state.raw_snapshot->>'createdBy'", "state.raw_snapshot->>'createdByName'")}
    FROM bitrix24_remote_state state WHERE state.object_type='deal' AND state.bitrix_id=${dealId})`;
}

export const PAYMENT_AUTHORSHIP_SQL = `jsonb_build_object(
  'createdBy', ${actorSql('command.bitrix_actor_user_id', 'command.bitrix_actor_name')},
  'paidBy', ${actorSql('payment.paid_by_id', 'payment.paid_by_name')})`;
