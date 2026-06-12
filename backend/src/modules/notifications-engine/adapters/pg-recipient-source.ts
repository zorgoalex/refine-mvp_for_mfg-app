import type { DatabaseClient } from '../../../database/database.types';
import type { NotificationEventContext } from '../domain/notification-rule.types';
import type { RecipientResolverKind } from '../domain/notification-event-registry';
import type { RecipientSourcePort } from '../ports/recipient-source.port';
import { ROLE_TO_ROLE_ID } from '../../../permissions/permissions';

export class PgRecipientSourceAdapter implements RecipientSourcePort {
  async resolveDynamic(client: DatabaseClient, kind: RecipientResolverKind, ctx: NotificationEventContext): Promise<number[]> {
    if (ctx.orderId == null) return [];
    switch (kind) {
      case 'order_manager': {
        const res = await client.query<{ manager_id: string | number }>(
          `SELECT manager_id FROM public.orders WHERE order_id = $1::bigint AND delete_flag = false AND manager_id IS NOT NULL`,
          [ctx.orderId],
        );
        return res.rows.map((r) => Number(r.manager_id)).filter(Number.isFinite);
      }
      case 'stage_assignee': {
        const res = await client.query<{ user_id: string | number }>(
          `SELECT DISTINCT u.user_id
           FROM public.order_workshops ow
           JOIN public.users u ON u.employee_id = ow.responsible_employee_id AND u.is_active = true
           WHERE ow.order_id = $1::bigint AND ow.delete_flag = false AND ow.responsible_employee_id IS NOT NULL`,
          [ctx.orderId],
        );
        return res.rows.map((r) => Number(r.user_id)).filter(Number.isFinite);
      }
      case 'project_participants': {
        // Fan out over projects linked to this deadline event via BOTH the
        // order link (`project_order_projects`) AND the generic deadline link
        // (`project_entity_links` with `entity_type_code='deadline_instance'`),
        // matching the legacy P8 port's `deadline_links UNION order_links`
        // query so the engine reaches every project the inline path reached.
        // `ctx.deadlineInstanceId` is the deadline_instances.deadline_id (UUID)
        // stored as `entity_id_text`; when null the deadline_links branch is
        // empty (text `= NULL` is never true) and this degrades to order-only.
        const res = await client.query<{ user_id: string | number }>(
          `SELECT DISTINCT pp.participant_id_text::bigint AS user_id
           FROM (
             SELECT pop.project_id
             FROM public.project_order_projects pop
             WHERE pop.order_id = $1::bigint AND pop.valid_to IS NULL
             UNION
             SELECT pel.project_id
             FROM public.project_entity_links pel
             WHERE pel.entity_type_code = 'deadline_instance'
               AND pel.entity_id_text = $2
               AND pel.valid_to IS NULL
           ) linked_projects
           JOIN public.project_participants pp
             ON pp.project_id = linked_projects.project_id
            AND pp.valid_to IS NULL
            AND pp.participant_type = 'user'`,
          [ctx.orderId, ctx.deadlineInstanceId],
        );
        return res.rows.map((r) => Number(r.user_id)).filter(Number.isFinite);
      }
      case 'workshop_head': {
        const res = await client.query<{ user_id: string | number }>(
          `SELECT DISTINCT wh.user_id
           FROM public.order_workshops ow
           JOIN public.workshop_heads wh
             ON wh.workshop_id = ow.workshop_id AND wh.is_active = true
           JOIN public.users u
             ON u.user_id = wh.user_id AND u.is_active = true
           WHERE ow.order_id = $1::bigint AND ow.delete_flag = false`,
          [ctx.orderId],
        );
        return res.rows.map((r) => Number(r.user_id)).filter(Number.isFinite);
      }
      default:
        return [];
    }
  }

  async resolveRoleMembers(client: DatabaseClient, roleCodes: string[]): Promise<number[]> {
    const roleIds = roleCodes
      .map((code) => (ROLE_TO_ROLE_ID as Record<string, number | undefined>)[code])
      .filter((id): id is number => typeof id === 'number');
    if (roleIds.length === 0) return [];
    const res = await client.query<{ user_id: string | number }>(
      `SELECT user_id FROM public.users WHERE role_id = ANY($1::int[]) AND is_active = true`,
      [roleIds],
    );
    return res.rows.map((r) => Number(r.user_id)).filter(Number.isFinite);
  }

  async filterActiveUsers(client: DatabaseClient, userIds: number[]): Promise<number[]> {
    if (userIds.length === 0) return [];
    const res = await client.query<{ user_id: string | number }>(
      `SELECT user_id FROM public.users WHERE user_id = ANY($1::bigint[]) AND is_active = true`,
      [userIds],
    );
    const active = new Set(res.rows.map((r) => Number(r.user_id)));
    return userIds.filter((id) => active.has(id));
  }
}
