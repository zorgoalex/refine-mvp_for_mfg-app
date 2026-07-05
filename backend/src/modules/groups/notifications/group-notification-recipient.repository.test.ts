import { describe, expect, it } from 'vitest';
import { PgGroupNotificationRecipientRepository } from './group-notification-recipient.repository';

describe('PgGroupNotificationRecipientRepository', () => {
  it('returns only current user participants for a group', async () => {
    const database = fakeDatabase();
    const repository = new PgGroupNotificationRecipientRepository(database);

    await expect(repository.listCurrentUserParticipants(groupId())).resolves.toEqual([
      { userId: '1', username: 'admin', roleCode: 'manager' },
    ]);

    const sql = database.queries[0].text;
    expect(sql).toContain('pp.valid_to IS NULL');
    expect(sql).toContain("pp.participant_type = 'user'");
    expect(sql).toContain('u.user_id = pp.participant_id_text::bigint');
  });

  it('excludes employee-only participants without login user id from persisted notification recipients', async () => {
    const database = fakeDatabase({ participants: [] });
    const repository = new PgGroupNotificationRecipientRepository(database);

    await expect(repository.listCurrentUserParticipants(groupId())).resolves.toEqual([]);
  });

  it('requires orders.view for order-linked notification recipients', async () => {
    const database = fakeDatabase({
      orderRows: [
        userOrderRow({ userId: '1', roleId: 1 }),
        userOrderRow({ userId: '2', roleId: 20 }),
      ],
    });
    const repository = new PgGroupNotificationRecipientRepository(database);

    await expect(repository.filterRecipientsByBaseVisibility({
      recipients: [
        { userId: '1', username: 'admin', roleCode: 'manager' },
        { userId: '2', username: 'worker', roleCode: 'observer' },
      ],
      linkedEntity: { entityType: 'order', entityId: '15' },
    })).resolves.toEqual([{ userId: '1', username: 'admin', roleCode: 'manager' }]);
  });

  it('redacts affected user member identity unless recipient has users.view', async () => {
    const repository = new PgGroupNotificationRecipientRepository(fakeDatabase({
      users: [userPermissionRow({ userId: '2', roleId: 20 })],
    }));

    await expect(repository.canRecipientViewMemberIdentity({
      recipient: { userId: '2', username: 'worker', roleCode: 'observer' },
      participantType: 'user',
    })).resolves.toBe(false);
  });

  it('redacts affected employee member identity unless recipient has employees.view', async () => {
    const repository = new PgGroupNotificationRecipientRepository(fakeDatabase({
      users: [userPermissionRow({ userId: '1', roleId: 1 })],
    }));

    await expect(repository.canRecipientViewMemberIdentity({
      recipient: { userId: '1', username: 'admin', roleCode: 'manager' },
      participantType: 'employee',
    })).resolves.toBe(true);
  });

  it('does not use group participation to grant finance, audit, deadline worker, or production command permissions', async () => {
    const repository = new PgGroupNotificationRecipientRepository(fakeDatabase({
      users: [userPermissionRow({ userId: '2', roleId: 20 })],
    }));

    const recipients = [{ userId: '2', username: 'worker', roleCode: 'observer' }];
    await expect(repository.filterRecipientsByBaseVisibility({
      recipients,
      linkedEntity: { entityType: 'client', entityId: '1' },
    })).resolves.toEqual([]);
  });

  it('returns no recipients when base linked entity visibility is denied', async () => {
    const repository = new PgGroupNotificationRecipientRepository(fakeDatabase({
      orderRows: [userOrderRow({ userId: '2', roleId: 20 })],
    }));

    await expect(repository.filterRecipientsByBaseVisibility({
      recipients: [{ userId: '2', username: 'worker', roleCode: 'observer' }],
      linkedEntity: { entityType: 'order', entityId: '15' },
    })).resolves.toEqual([]);
  });
});

function fakeDatabase({
  participants = [{ user_id: '1', username: 'admin', role_code: 'manager' }],
  users = [userPermissionRow({ userId: '1', roleId: 1 })],
  orderRows = [userOrderRow({ userId: '1', roleId: 1 })],
}: {
  participants?: unknown[];
  users?: unknown[];
  orderRows?: unknown[];
} = {}) {
  return {
    queries: [] as Array<{ text: string; params: readonly unknown[] }>,
    async query<T>(text: string, params: readonly unknown[] = []) {
      this.queries.push({ text, params });
      if (text.includes('FROM public.group_participants')) return { rows: participants as T[] };
      if (text.includes('CROSS JOIN public.orders')) return { rows: orderRows as T[] };
      if (text.includes('FROM public.users u')) return { rows: users as T[] };
      return { rows: [] as T[] };
    },
  };
}

function userPermissionRow({ userId, roleId }: { userId: string; roleId: number }) {
  return { user_id: userId, username: `user-${userId}`, role_id: roleId };
}

function userOrderRow({ userId, roleId }: { userId: string; roleId: number }) {
  return {
    ...userPermissionRow({ userId, roleId }),
    order_id: '15',
    created_by: '99',
    manager_id: '99',
  };
}

function groupId(): string {
  return '11111111-1111-4111-8111-111111111111';
}
