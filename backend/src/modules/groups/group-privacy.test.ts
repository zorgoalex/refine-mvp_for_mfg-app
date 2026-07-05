import { describe, expect, it } from 'vitest';
import { parseReplaceGroupEntityLinksRequest } from './entity-links/group-entity-links.dto';
import { GroupEntityLinksService } from './entity-links/group-entity-links.service';
import { PgGroupParticipantsRepository } from './participants/group-participants.repository';

describe('group privacy boundaries', () => {
  it('denies typed entity link list without entity-specific visibility', async () => {
    const service = new GroupEntityLinksService({
      links: {
        async list() {
          throw new Error('repository must not be called');
        },
        async replace() {
          throw new Error('repository must not be called');
        },
        async append() {
          throw new Error('repository must not be called');
        },
      },
    });

    await expect(
      service.list({
        currentUser: { id: '1', username: 'tester', role: 'admin', roleId: 1, permissions: ['groups.view'] },
        groupId: groupId(),
        entityType: 'client',
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      details: { requiredPermissions: ['clients.view'] },
    });
  });

  it('rejects IDs that would otherwise become SQL cast errors', () => {
    expect(() => parseReplaceGroupEntityLinksRequest({
      idempotencyKey: 'key-1',
      links: [{ entityType: 'client', entityId: 'abc' }],
    })).toThrow(/VALIDATION_ERROR/);
    expect(() => parseReplaceGroupEntityLinksRequest({
      idempotencyKey: 'key-1',
      links: [{ entityType: 'deadline_instance', entityId: '123' }],
    })).toThrow(/VALIDATION_ERROR/);
  });

  it('redacts participant identities after replace when base identity permissions are absent', async () => {
    const repo = new PgGroupParticipantsRepository(fakeParticipantDatabase());

    await expect(repo.replace({
      currentUser: { id: '1', username: 'tester', role: 'admin', roleId: 1, permissions: [] },
      groupId: groupId(),
      dto: {
        idempotencyKey: 'participants-key',
        participants: [{ participantType: 'employee', participantId: '77', roleCode: 'manager', metadata: {} }],
      },
      canViewUsers: false,
      canViewEmployees: false,
    })).resolves.toMatchObject({
      participants: [{ participantId: null, displayName: null }],
    });
  });
});

function fakeParticipantDatabase() {
  const database = {
    async query(text: string) {
      if (text.includes('INSERT INTO command_idempotency_keys')) return { rows: [{ status: 'processing', request_hash: 'hash', response_json: null }] };
      if (text.includes('SELECT id::text, code FROM public.group_groups')) return { rows: [{ id: groupId(), code: 'P1' }] };
      if (text.includes('FROM public.group_participant_roles') && text.includes('FOR KEY SHARE')) return { rows: [{ code: 'manager', label: 'Manager' }] };
      if (text.includes('FROM public.employees') && text.includes('FOR KEY SHARE')) return { rows: [{ id: '77' }] };
      if (text.includes('FROM public.group_participants')) return { rows: [] };
      if (text.includes('INSERT INTO public.group_participants')) return { rows: [participantRow()] };
      if (text.includes('INSERT INTO audit_log')) return { rows: [{ audit_id: 'audit-1' }] };
      return { rows: [] };
    },
    async transaction<T>(handler: (client: typeof database) => Promise<T>): Promise<T> {
      return handler(this);
    },
  };
  return database;
}

function participantRow() {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    participant_type: 'employee',
    participant_id_text: '77',
    user_display_name: null,
    employee_display_name: 'Employee 77',
    role_code: 'manager',
    role_label: 'Manager',
    valid_from: '2026-06-04T00:00:00.000Z',
    valid_to: null,
    metadata: {},
  };
}

function groupId(): string {
  return '11111111-1111-4111-8111-111111111111';
}
