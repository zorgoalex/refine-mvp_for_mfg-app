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
      case 'group_participants': {
        if (ctx.groupIds.length === 0) return [];
        const res = await client.query<{ user_id: string | number }>(
          `SELECT DISTINCT pp.participant_id_text::bigint AS user_id
           FROM public.group_participants pp
           WHERE pp.group_id = ANY($1::uuid[])
             AND pp.valid_to IS NULL
             AND pp.participant_type = 'user'`,
          [ctx.groupIds],
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
      case 'direction_head': {
        const res = await client.query<{ user_id: string | number }>(
          `SELECT DISTINCT dh.user_id
           FROM (
             SELECT dw.direction_id
             FROM public.order_workshops ow
             JOIN public.direction_workshops dw ON dw.workshop_id = ow.workshop_id
             WHERE ow.order_id = $1::bigint AND ow.delete_flag = false
             UNION
             SELECT dwc.direction_id
             FROM public.order_workshops ow
             JOIN public.work_centers wc ON wc.workshop_id = ow.workshop_id
             JOIN public.direction_work_centers dwc ON dwc.workcenter_id = wc.workcenter_id
             WHERE ow.order_id = $1::bigint AND ow.delete_flag = false
           ) matched_directions
           JOIN public.directions d
             ON d.direction_id = matched_directions.direction_id AND d.is_active = true
           JOIN public.direction_heads dh
             ON dh.direction_id = d.direction_id AND dh.is_active = true
           JOIN public.users u
             ON u.user_id = dh.user_id AND u.is_active = true`,
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
