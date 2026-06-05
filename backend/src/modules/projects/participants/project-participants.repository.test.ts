import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PgProjectParticipantsRepository } from './project-participants.repository';

describe('PgProjectParticipantsRepository', () => {
  it('redacts identity fields without base identity permission', async () => {
    const repo = new PgProjectParticipantsRepository(fakeDatabase());

    await expect(repo.list({
      currentUser: user(),
      projectId: projectId(),
      canViewUsers: false,
      canViewEmployees: false,
    })).resolves.toMatchObject({
      participants: [{
        participantType: 'employee',
        participantId: null,
        displayName: null,
        role: { code: 'manager', label: 'Manager' },
      }],
    });
  });

  it('replace validates identities with locks and writes participant idempotency command', async () => {
    const database = fakeDatabase({ participantRows: [] });
    const repo = new PgProjectParticipantsRepository(database);

    await repo.replace({
      currentUser: user(),
      projectId: projectId(),
      dto: {
        idempotencyKey: 'participants-key',
        participants: [{ participantType: 'employee', participantId: '77', roleCode: 'manager', metadata: {} }],
      },
    });

    const sql = database.queries.map((query) => query.text).join('\n');
    const params = database.queries.flatMap((query) => [...query.params]);
    expect(sql).toContain('projects.participants.replace');
    expect(sql).toContain('FROM public.employees');
    expect(sql).toContain('FOR KEY SHARE');
    expect(sql).toContain('INSERT INTO public.project_participants');
    expect(params).toContain('PROJECT_PARTICIPANTS_CHANGED');
  });

  it('redacts completed idempotency replay through current identity permissions', async () => {
    const repo = new PgProjectParticipantsRepository(fakeDatabase({
      idempotencyRow: {
        request_hash: participantRequestHash(),
        status: 'completed',
        response_json: {
          projectId: projectId(),
          requestId: 'request-id',
          participants: [{
            id: '22222222-2222-4222-8222-222222222222',
            participantType: 'employee',
            participantId: '77',
            displayName: 'Employee 77',
            role: { code: 'manager', label: 'Manager' },
            validFrom: '2026-06-04T00:00:00.000Z',
            validTo: null,
            metadata: {},
          }],
        },
      },
    }));

    await expect(repo.replace({
      currentUser: user(),
      projectId: projectId(),
      dto: {
        idempotencyKey: 'participants-key',
        participants: [{ participantType: 'employee', participantId: '77', roleCode: 'manager', metadata: {} }],
      },
      canViewEmployees: false,
      canViewUsers: false,
    })).resolves.toMatchObject({
      participants: [{ participantId: null, displayName: null }],
    });
  });

  it('writes participant audit rows without display names', async () => {
    const database = fakeDatabase({ participantRows: [] });
    const repo = new PgProjectParticipantsRepository(database);

    await repo.replace({
      currentUser: user(),
      projectId: projectId(),
      dto: {
        idempotencyKey: 'participants-key',
        participants: [{ participantType: 'employee', participantId: '77', roleCode: 'manager', metadata: {} }],
      },
      canViewEmployees: true,
    });

    const auditQuery = database.queries.find((query) => query.text.includes('INSERT INTO audit_log'));
    expect(auditQuery?.params.join('\n')).toContain('"participantType":"employee"');
    expect(auditQuery?.params.join('\n')).toContain('"participantId":"77"');
    expect(auditQuery?.params.join('\n')).not.toContain('Employee 77');
    expect(auditQuery?.params.join('\n')).not.toContain('displayName');
  });
});

function fakeDatabase({
  participantRows = [participantRow()],
  idempotencyRow,
}: {
  participantRows?: unknown[];
  idempotencyRow?: unknown;
} = {}) {
  const database = {
    queries: [] as Array<{ text: string; params: readonly unknown[] }>,
    async query(text: string, params: readonly unknown[] = []) {
      this.queries.push({ text, params });
      if (text.includes('INSERT INTO command_idempotency_keys')) return { rows: idempotencyRow ? [] : [{ status: 'processing', request_hash: 'hash', response_json: null }] };
      if (text.includes('SELECT request_hash, response_json, status FROM command_idempotency_keys')) return { rows: idempotencyRow ? [idempotencyRow] : [] };
      if (text.includes('SELECT id::text, code FROM public.project_projects')) return { rows: [{ id: projectId(), code: 'P1' }] };
      if (text.includes('SELECT id FROM public.project_projects')) return { rows: [{ id: projectId() }] };
      if (text.includes('FROM public.project_participant_roles') && text.includes('FOR KEY SHARE')) return { rows: [{ code: 'manager', label: 'Manager' }] };
      if (text.includes('FROM public.employees') && text.includes('FOR KEY SHARE')) return { rows: [{ id: '77' }] };
      if (text.includes('FROM public.project_participants')) return { rows: participantRows };
      if (text.includes('INSERT INTO public.project_participants')) return { rows: [participantRow()] };
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

function user() {
  return { id: '1', username: 'tester', role: 'admin', roleId: 1, permissions: [] };
}

function projectId(): string {
  return '11111111-1111-4111-8111-111111111111';
}

function participantRequestHash(): string {
  return createHash('sha256').update(JSON.stringify(sortForHash({
    actorUserId: '1',
    projectId: projectId(),
    participants: [{
      participantType: 'employee',
      participantId: '77',
      roleCode: 'manager',
      metadata: {},
    }],
    reason: null,
  }))).digest('hex');
}

function sortForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForHash);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortForHash(nested)]));
  }
  return value;
}
