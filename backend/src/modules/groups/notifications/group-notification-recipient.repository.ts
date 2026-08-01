import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { OrderAccessPolicy } from '../../../permissions/policies/order-access.policy';
import { filterUserIdsByOrderVisibility, mapUserRow } from '../../../permissions/visibility/order-visibility-filter';
import type { GroupLinkedEntityRef, GroupNotificationRecipient } from './group-notification.types';

interface ParticipantRow extends QueryResultRow {
  user_id: string | number;
  username: string | null;
  role_code: string;
}

interface UserPermissionRow extends QueryResultRow {
  user_id: string | number;
  username: string | null;
  role_id: string | number;
}

interface OrderVisibilityRow extends UserPermissionRow {
  order_id: string | number;
  created_by: string | number | null;
  manager_id: string | number | null;
}

interface DeadlineVisibilityRow extends OrderVisibilityRow {
  deadline_id: string | number;
}

const ENTITY_VIEW_PERMISSIONS = {
  user: 'users.view',
  employee: 'employees.view',
  client: 'clients.view',
  workshop: 'workshops.view',
} as const satisfies Record<'user' | 'employee' | 'client' | 'workshop', PermissionName>;

export class PgGroupNotificationRecipientRepository {
  private readonly orderAccessPolicy = new OrderAccessPolicy();

  constructor(private readonly database: DatabaseClient) {}

  async listCurrentUserParticipants(groupId: string): Promise<GroupNotificationRecipient[]> {
    const result = await this.database.query<ParticipantRow>(
      `
      SELECT
        u.user_id::text AS user_id,
        u.username,
        pp.role_code
      FROM public.group_participants pp
      INNER JOIN public.users u
        ON pp.participant_type = 'user'
       AND u.user_id = pp.participant_id_text::bigint
      WHERE pp.group_id = $1::uuid
        AND pp.valid_to IS NULL
        AND pp.participant_type = 'user'
      ORDER BY pp.role_code ASC, u.user_id ASC
      `,
      [groupId],
    );

    return result.rows.map((row) => ({
      userId: String(row.user_id),
      username: row.username,
      roleCode: row.role_code,
    }));
  }

  async filterRecipientsByBaseVisibility(input: {
    recipients: GroupNotificationRecipient[];
    linkedEntity: GroupLinkedEntityRef;
  }): Promise<GroupNotificationRecipient[]> {
    if (input.recipients.length === 0) return [];

    switch (input.linkedEntity.entityType) {
      case 'order':
        return this.filterByOrderVisibility(input.recipients, input.linkedEntity.entityId);
      case 'deadline_instance':
        return this.filterByDeadlineVisibility(input.recipients, input.linkedEntity.entityId);
      case 'user':
      case 'employee':
      case 'client':
      case 'workshop':
        return this.filterByPermission(input.recipients, ENTITY_VIEW_PERMISSIONS[input.linkedEntity.entityType]);
    }
  }

  async canRecipientViewMemberIdentity(input: {
    recipient: GroupNotificationRecipient;
    participantType: 'user' | 'employee';
  }): Promise<boolean> {
    const permission: PermissionName = input.participantType === 'user' ? 'users.view' : 'employees.view';
    const currentUser = await this.loadCurrentUser(input.recipient.userId);
    return currentUser?.permissions.includes(permission) ?? false;
  }

  private async filterByOrderVisibility(
    recipients: GroupNotificationRecipient[],
    orderId: string,
  ): Promise<GroupNotificationRecipient[]> {
    const allowed = await filterUserIdsByOrderVisibility(this.database, recipients.map((r) => r.userId), orderId);
    return recipients.filter((recipient) => allowed.has(recipient.userId));
  }

  private async filterByDeadlineVisibility(
    recipients: GroupNotificationRecipient[],
    deadlineInstanceId: string,
  ): Promise<GroupNotificationRecipient[]> {
    const rows = await this.database.query<DeadlineVisibilityRow>(
      `
      SELECT
        u.user_id::text AS user_id,
        u.username,
        u.role_id,
        di.deadline_id,
        o.order_id,
        o.created_by,
        o.manager_id
      FROM public.users u
      CROSS JOIN public.deadline_instances di
      INNER JOIN public.orders o
       ON o.order_id = di.order_id
       AND o.delete_flag = false
       AND o.order_kind = 'production_order'
      WHERE u.user_id = ANY($1::bigint[])
        AND di.deadline_id = $2::uuid
      `,
      [recipients.map((recipient) => recipient.userId), deadlineInstanceId],
    );
    const recipientById = new Map(recipients.map((recipient) => [recipient.userId, recipient]));

    return rows.rows
      .filter((row) => {
        const currentUser = mapUserRow(row);
        return Boolean(currentUser)
          && currentUser!.permissions.includes('deadlines.view')
          && this.orderAccessPolicy.canView(currentUser!, {
            orderId: row.order_id,
            createdByUserId: nullableString(row.created_by),
            managerUserId: nullableString(row.manager_id),
            ownerUserId: nullableString(row.manager_id),
          });
      })
      .map((row) => recipientById.get(String(row.user_id)))
      .filter((recipient): recipient is GroupNotificationRecipient => Boolean(recipient));
  }

  private async filterByPermission(
    recipients: GroupNotificationRecipient[],
    permission: PermissionName,
  ): Promise<GroupNotificationRecipient[]> {
    const rows = await this.database.query<UserPermissionRow>(
      `
      SELECT u.user_id::text AS user_id, u.username, u.role_id
      FROM public.users u
      WHERE u.user_id = ANY($1::bigint[])
      `,
      [recipients.map((recipient) => recipient.userId)],
    );
    const allowedUserIds = new Set(
      rows.rows
        .map(mapUserRow)
        .filter((user): user is CurrentUser => Boolean(user))
        .filter((user) => user.permissions.includes(permission))
        .map((user) => user.id),
    );
    return recipients.filter((recipient) => allowedUserIds.has(recipient.userId));
  }

  private async loadCurrentUser(userId: string): Promise<CurrentUser | null> {
    const result = await this.database.query<UserPermissionRow>(
      `
      SELECT u.user_id::text AS user_id, u.username, u.role_id
      FROM public.users u
      WHERE u.user_id = $1::bigint
      `,
      [userId],
    );
    return result.rows[0] ? mapUserRow(result.rows[0]) : null;
  }
}

export class UnavailableGroupNotificationRecipientRepository {
  async listCurrentUserParticipants(): Promise<GroupNotificationRecipient[]> {
    return [];
  }

  async filterRecipientsByBaseVisibility(): Promise<GroupNotificationRecipient[]> {
    return [];
  }

  async canRecipientViewMemberIdentity(): Promise<boolean> {
    return false;
  }
}

function nullableString(value: string | number | null): string | null {
  return value == null ? null : String(value);
}
