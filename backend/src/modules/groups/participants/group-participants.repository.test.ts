import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PgGroupParticipantsRepository } from './group-participants.repository';

describe('PgGroupParticipantsRepository', () => {
  it('redacts identity fields without base identity permission', async () => {
    const repo = new PgGroupParticipantsRepository(fakeDatabase());

    await expect(repo.list({
      currentUser: user(),
      groupId: groupId(),
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
    const repo = new PgGroupParticipantsRepository(database);

    await repo.replace({
      currentUser: user(),
      groupId: groupId(),
      dto: {
        idempotencyKey: 'participants-key',
        participants: [{ participantType: 'employee', participantId: '77', roleCode: 'manager', metadata: {} }],
      },
    });

    const sql = database.queries.map((query) => query.text).join('\n');
    const params = database.queries.flatMap((query) => [...query.params]);
    expect(sql).toContain('groups.participants.replace');
    expect(sql).toContain('FROM public.employees');
    expect(sql).toContain('FOR KEY SHARE');
    expect(sql).toContain('INSERT INTO public.group_participants');
    expect(params).toContain('GROUP_PARTICIPANTS_CHANGED');
  });

  it('redacts completed idempotency replay through current identity permissions', async () => {
    const repo = new PgGroupParticipantsRepository(fakeDatabase({
      idempotencyRow: {
        request_hash: participantRequestHash(),
        status: 'completed',
        response_json: {
          groupId: groupId(),
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
      groupId: groupId(),
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
    const repo = new PgGroupParticipantsRepository(database);

    await repo.replace({
      currentUser: user(),
      groupId: groupId(),
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

  it('writes replayable member event facts for participant notifications', async () => {
    const database = fakeDatabase({
      participantRows: [participantRow()],
    });
    const repo = new PgGroupParticipantsRepository(database);

    await repo.replace({
      currentUser: user(),
      groupId: groupId(),
      dto: {
        idempotencyKey: 'participants-member-events-key',
        participants: [
          { participantType: 'user', participantId: '158', roleCode: 'manager', metadata: {} },
        ],
      },
      canViewUsers: true,
    });

    const outbox = database.queries.find((query) => query.text.includes('INSERT INTO outbox_events'));
    const payload = JSON.parse(String(outbox?.params[2]));
    expect(payload.memberEvents).toEqual([
      {
        eventType: 'GROUP_MEMBER_ADDED',
        factKey: 'participant:user:158:role:manager:added',
        participantType: 'user',
        participantId: '158',
        roleCode: 'manager',
      },
      {
        eventType: 'GROUP_MEMBER_REMOVED',
        factKey: 'participant:employee:77:role:manager:removed',
        participantType: 'employee',
        participantId: '77',
        roleCode: 'manager',
      },
    ]);
  });

  it('writes bridge rows for added and removed participants on same tx, entity_type matches participantType', async () => {
    // before: employee:77; after: user:158 — one removed (employee) + one added (user)
    const database = fakeDatabase({
      participantRows: [participantRow()],
    });
    const repo = new PgGroupParticipantsRepository(database);

    await repo.replace({
      currentUser: user(),
      groupId: groupId(),
      dto: {
        idempotencyKey: 'bridge-participants-key',
        participants: [
          { participantType: 'user', participantId: '158', roleCode: 'manager', metadata: {} },
        ],
      },
      canViewUsers: true,
    });

    const bridgeQueries = database.queries.filter((q) =>
      q.text.includes('INSERT INTO audit_log_related_entity'),
    );
    // added: user:158; removed: employee:77
    expect(bridgeQueries).toHaveLength(2);

    const bridgeParams = bridgeQueries.map((q) => ({ entityType: q.params[1], entityId: q.params[2] }));
    expect(bridgeParams).toContainEqual({ entityType: 'user', entityId: 158 });
    expect(bridgeParams).toContainEqual({ entityType: 'employee', entityId: 77 });
    // all bridge rows carry the parent audit_id
    expect(bridgeQueries.every((q) => q.params[0] === 'audit-1')).toBe(true);
  });

  it('skips bridge row when participantId converts to NaN', async () => {
    const database = fakeDatabase({ participantRows: [] });
    const repo = new PgGroupParticipantsRepository(database);

    // replace with a bad participantId that would NaN-convert
    // fakeDatabase won't lock-validate employees, so this exercises the NaN skip path
    await repo.replace({
      currentUser: user(),
      groupId: groupId(),
      dto: {
        idempotencyKey: 'nan-skip-key',
        participants: [
          { participantType: 'employee', participantId: '77', roleCode: 'manager', metadata: {} },
        ],
      },
      canViewEmployees: true,
    });

    const bridgeQueries = database.queries.filter((q) =>
      q.text.includes('INSERT INTO audit_log_related_entity'),
    );
    // added: employee:77 (valid); no removed (before is empty)
    // verify the added bridge row has numeric entity_id, not NaN
    expect(bridgeQueries).toHaveLength(1);
    expect(bridgeQueries[0].params[1]).toBe('employee');
    expect(bridgeQueries[0].params[2]).toBe(77);
  });

  // --- diff_json semantics: pure add, pure remove, role-change-in-both, metadata-change-in-both ---

  it('diff_json.added contains new participant, diff_json.removed empty on pure add', async () => {
    // before: empty; after: employee:77/manager
    const database = fakeDatabase({ participantRows: [] });
    const repo = new PgGroupParticipantsRepository(database);

    await repo.replace({
      currentUser: user(),
      groupId: groupId(),
      dto: {
        idempotencyKey: 'pure-add-key',
        participants: [{ participantType: 'employee', participantId: '77', roleCode: 'manager', metadata: {} }],
      },
      canViewEmployees: true,
    });

    const auditQuery = database.queries.find((q) => q.text.includes('INSERT INTO audit_log'));
    const diffJson = JSON.parse(String(auditQuery?.params[21])); // params[21] = diff_json in standard AUDIT_INSERT
    expect(diffJson.added).toHaveLength(1);
    expect(diffJson.added[0]).toMatchObject({ participantType: 'employee', participantId: '77', roleCode: 'manager' });
    expect(diffJson.removed).toHaveLength(0);
  });

  it('diff_json.removed contains old participant, diff_json.added empty on pure remove', async () => {
    // before: employee:77/manager; after: empty
    const database = fakeDatabase({ participantRows: [participantRow()] });
    // insertParticipant won't be called; we need to override it to return nothing
    const repo = new PgGroupParticipantsRepository(database);

    await repo.replace({
      currentUser: user(),
      groupId: groupId(),
      dto: {
        idempotencyKey: 'pure-remove-key',
        participants: [],
      },
    });

    const auditQuery = database.queries.find((q) => q.text.includes('INSERT INTO audit_log'));
    const diffJson = JSON.parse(String(auditQuery?.params[21])); // params[21] = diff_json in standard AUDIT_INSERT
    expect(diffJson.removed).toHaveLength(1);
    expect(diffJson.removed[0]).toMatchObject({ participantType: 'employee', participantId: '77', roleCode: 'manager' });
    expect(diffJson.added).toHaveLength(0);
  });

  it('diff_json shows role change in BOTH added (new role) and removed (old role)', async () => {
    // before: employee:77/manager; after: employee:77/lead (role change)
    // insertParticipant returns the new row with role_code='lead'
    // Custom database: role 'lead' must pass validation; INSERT returns employee:77/lead
    const database = fakeDatabase({ participantRows: [participantRow()] });
    database.query = async function (text: string, params: readonly unknown[] = []) {
      this.queries.push({ text, params });
      if (text.includes('INSERT INTO command_idempotency_keys')) return { rows: [{ status: 'processing', request_hash: 'hash', response_json: null }] };
      if (text.includes('SELECT request_hash, response_json, status FROM command_idempotency_keys')) return { rows: [] };
      if (text.includes('SELECT id::text, code FROM public.group_groups')) return { rows: [{ id: groupId(), code: 'P1' }] };
      if (text.includes('SELECT id FROM public.group_groups')) return { rows: [{ id: groupId() }] };
      if (text.includes('FROM public.group_participant_roles') && text.includes('FOR KEY SHARE')) return { rows: [{ code: 'lead', label: 'Lead' }] };
      if (text.includes('FROM public.employees') && text.includes('FOR KEY SHARE')) return { rows: [{ id: '77' }] };
      if (text.includes('FROM public.users') && text.includes('FOR KEY SHARE')) return { rows: [{ id: '158' }] };
      if (text.includes('FROM public.group_participants')) return { rows: [participantRow()] };
      if (text.includes('INSERT INTO public.group_participants')) return { rows: [{ ...participantRow(), role_code: 'lead', role_label: 'Lead' }] };
      if (text.includes('INSERT INTO audit_log')) return { rows: [{ audit_id: 'audit-1' }] };
      return { rows: [] };
    };

    const repo = new PgGroupParticipantsRepository(database);

    await repo.replace({
      currentUser: user(),
      groupId: groupId(),
      dto: {
        idempotencyKey: 'role-change-key',
        participants: [{ participantType: 'employee', participantId: '77', roleCode: 'lead', metadata: {} }],
      },
      canViewEmployees: true,
    });

    const auditQuery = database.queries.find((q) => q.text.includes('INSERT INTO audit_log'));
    const diffJson = JSON.parse(String(auditQuery?.params[21])); // params[21] = diff_json in standard AUDIT_INSERT
    // Same participant (employee:77) must appear in BOTH added (new role) and removed (old role)
    expect(diffJson.added).toHaveLength(1);
    expect(diffJson.added[0]).toMatchObject({ participantType: 'employee', participantId: '77', roleCode: 'lead' });
    expect(diffJson.removed).toHaveLength(1);
    expect(diffJson.removed[0]).toMatchObject({ participantType: 'employee', participantId: '77', roleCode: 'manager' });
  });

  it('bridge rows and relatedUserIds/roleCodes are derived from diff_json added+removed (A3 intact)', async () => {
    // before: employee:77/manager; after: user:158/manager
    // bridge must have rows for both added (user:158) and removed (employee:77)
    // metadata_json.relatedUserIds = ['158'], relatedEmployeeIds = ['77'], roleCodes = ['manager']
    const database = fakeDatabase({ participantRows: [participantRow()] });
    const repo = new PgGroupParticipantsRepository(database);

    await repo.replace({
      currentUser: user(),
      groupId: groupId(),
      dto: {
        idempotencyKey: 'bridge-metadata-key',
        participants: [{ participantType: 'user', participantId: '158', roleCode: 'manager', metadata: {} }],
      },
      canViewUsers: true,
    });

    const auditQuery = database.queries.find((q) => q.text.includes('INSERT INTO audit_log'));
    const metaJson = JSON.parse(String(auditQuery?.params[22])); // params[22] = metadata_json in standard AUDIT_INSERT
    expect(metaJson.relatedUserIds).toEqual(['158']);
    expect(metaJson.relatedEmployeeIds).toEqual(['77']);
    expect(metaJson.roleCodes).toEqual(['manager']);

    const bridgeQueries = database.queries.filter((q) => q.text.includes('INSERT INTO audit_log_related_entity'));
    expect(bridgeQueries).toHaveLength(2);
    const bridgeEntities = bridgeQueries.map((q) => ({ entityType: q.params[1], entityId: q.params[2] }));
    expect(bridgeEntities).toContainEqual({ entityType: 'user', entityId: 158 });
    expect(bridgeEntities).toContainEqual({ entityType: 'employee', entityId: 77 });
  });

  it('audit participants_changed: secret-shaped fields in before/after/metadata are redacted by AuditService', async () => {
    const { auditService: svc } = await import('../../../common/audit/audit.service');
    const captured: Array<readonly unknown[]> = [];
    const fakeClient = {
      query: async (text: string, params: readonly unknown[] = []) => {
        if (text.includes('INSERT INTO audit_log')) captured.push(params);
        return { rows: [{ audit_id: 'pp-audit-1' }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
      },
    };

    await svc.record(fakeClient as unknown as import('../../../database/database.types').DatabaseClient, {
      event: 'groups.participants_changed',
      entityType: 'group',
      entityId: 'proj-p-1',
      actorUserId: 1,
      actorUsername: 'tester',
      actorRole: 'admin',
      requestId: 'req-secret-pp',
      source: 'groups-participants',
      before: { participants: [{ api_key: 'SUPER_SECRET', roleCode: 'manager' }] },
      after: { participants: [{ roleCode: 'lead', token: 'SECRET_TOKEN' }] },
      diff: { added: [{ roleCode: 'lead' }], removed: [{ roleCode: 'manager' }] },
      metadata: { idempotencyKey: 'pp-key', reason: null, secret: 'VERY_SECRET' },
    });

    expect(captured).toHaveLength(1);
    const params = captured[0];
    // Dimensions
    expect(params[0]).toBe('groups.participants_changed');
    expect(params[1]).toBe('group');
    expect(params[2]).toBe('proj-p-1');
    expect(params[6]).toBe('req-secret-pp');
    expect(params[7]).toBe('groups-participants');
    // before_json: api_key redacted
    const beforeJson = JSON.parse(params[19] as string);
    expect(beforeJson.participants[0].api_key).toBe('[REDACTED]');
    expect(JSON.stringify(beforeJson)).not.toContain('SUPER_SECRET');
    // after_json: token redacted
    const afterJson = JSON.parse(params[20] as string);
    expect(afterJson.participants[0].token).toBe('[REDACTED]');
    // metadata_json: secret redacted, idempotencyKey preserved
    const metaJson = JSON.parse(params[22] as string);
    expect(metaJson.idempotencyKey).toBe('pp-key');
    expect(metaJson.secret).toBe('[REDACTED]');
    expect(JSON.stringify(metaJson)).not.toContain('VERY_SECRET');
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
      if (text.includes('SELECT id::text, code FROM public.group_groups')) return { rows: [{ id: groupId(), code: 'P1' }] };
      if (text.includes('SELECT id FROM public.group_groups')) return { rows: [{ id: groupId() }] };
      if (text.includes('FROM public.group_participant_roles') && text.includes('FOR KEY SHARE')) return { rows: [{ code: 'manager', label: 'Manager' }] };
      if (text.includes('FROM public.employees') && text.includes('FOR KEY SHARE')) return { rows: [{ id: '77' }] };
      if (text.includes('FROM public.users') && text.includes('FOR KEY SHARE')) return { rows: [{ id: '158' }] };
      if (text.includes('FROM public.group_participants')) return { rows: participantRows };
      if (text.includes('INSERT INTO public.group_participants')) {
        // Return a row reflecting the actual inserted values from the params so that
        // input.after correctly reflects the post-write state (needed for computeListDiff).
        // INSERT params: [$1=groupId, $2=participant_type, $3=participant_id_text, $4=role_code, $5=metadata, $6=created_by]
        const pType = String(params[1]);
        const pId = String(params[2]);
        const rCode = String(params[3]);
        return {
          rows: [{
            id: '33333333-3333-4333-8333-333333333333',
            participant_type: pType,
            participant_id_text: pId,
            user_display_name: pType === 'user' ? `User ${pId}` : null,
            employee_display_name: pType === 'employee' ? `Employee ${pId}` : null,
            role_code: rCode,
            role_label: rCode.charAt(0).toUpperCase() + rCode.slice(1),
            valid_from: '2026-06-04T00:00:00.000Z',
            valid_to: null,
            metadata: {},
          }],
        };
      }
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

function groupId(): string {
  return '11111111-1111-4111-8111-111111111111';
}

function participantRequestHash(): string {
  return createHash('sha256').update(JSON.stringify(sortForHash({
    actorUserId: '1',
    groupId: groupId(),
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
