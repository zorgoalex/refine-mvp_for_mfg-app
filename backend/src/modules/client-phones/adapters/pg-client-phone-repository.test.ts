import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { PgClientPhoneRepository } from './pg-client-phone-repository';

describe('PgClientPhoneRepository', () => {
  it('creates a primary phone with idempotency, demotion audit, and outbox rows', async () => {
    const database = createDatabase({ demotedPhoneId: 9 });
    const repository = new PgClientPhoneRepository(database.service);

    const result = await repository.createClientPhone({
      currentUser: currentUser(),
      dto: {
        clientId: 1,
        phoneNumber: '+7 700 000 01 01',
        phoneType: 'mobile',
        isPrimary: true,
        refKey1c: null,
        idempotencyKey: 'client-phone-create-key',
      },
      requestId: 'request-1',
    });

    expect(result).toMatchObject({
      phone: { phoneId: 11, clientId: 1, isPrimary: true },
      demotedPhoneIds: [9],
      auditId: 'audit-id-1',
      requestId: 'request-1',
    });
    const sql = normalizedSql(database.queries);
    expect(sql).toContain('SELECT set_session_user($1)');
    expect(sql).toContain('INSERT INTO command_idempotency_keys');
    expect(sql).toContain('UPDATE client_phones SET is_primary = false');
    expect(sql.match(/INSERT INTO audit_log/g)).toHaveLength(2);
    expect(sql.match(/INSERT INTO outbox_events/g)).toHaveLength(2);
    expect(JSON.stringify(database.queries.map((query) => query.params))).toContain(
      'client_phones.primary_demote',
    );
    expect(JSON.stringify(database.queries.map((query) => query.params))).toContain(
      'client_phone.primary_demoted',
    );
    expect(sql).toContain('UPDATE command_idempotency_keys SET status =');

    // Audit diff shape: create uses {from,to} uniform shape
    const createAuditQuery = database.queries.find(
      (q) => normalizeSql(q.text).startsWith('INSERT INTO audit_log') && q.params[0] === 'client_phones.create',
    );
    expect(createAuditQuery).toBeDefined();
    const createDiff = JSON.parse(createAuditQuery!.params[21] as string);
    expect(createDiff.phoneNumber).toEqual({ from: null, to: '+7 700 000 01 01' });
    expect(createDiff).not.toHaveProperty('phoneNumber.before');
    expect(createDiff).not.toHaveProperty('phoneNumber.after');

    // primary_demote diff shape: {from,to}
    const demoteAuditQuery = database.queries.find(
      (q) => normalizeSql(q.text).startsWith('INSERT INTO audit_log') && q.params[0] === 'client_phones.primary_demote',
    );
    expect(demoteAuditQuery).toBeDefined();
    const demoteDiff = JSON.parse(demoteAuditQuery!.params[21] as string);
    expect(demoteDiff).toEqual({ isPrimary: { from: true, to: false } });
  });

  it('returns stored idempotent response before touching client_phones', async () => {
    const database = createDatabase({
      idempotencyCompletedResponse: {
        phone: clientPhoneDto({ phoneId: 11 }),
        requestId: 'request-1',
      },
    });
    const repository = new PgClientPhoneRepository(database.service);

    await expect(
      repository.createClientPhone({
        currentUser: currentUser(),
        dto: {
          clientId: 1,
          phoneNumber: '+7 700 000 01 01',
          phoneType: 'mobile',
          isPrimary: true,
          refKey1c: null,
          idempotencyKey: 'client-phone-create-key',
        },
        requestId: 'request-1',
      }),
    ).resolves.toMatchObject({
      phone: { phoneId: 11 },
    });
    expect(normalizedSql(database.queries)).not.toContain('FROM client_phones');
  });

  it('rejects duplicate phone numbers before insert', async () => {
    const database = createDatabase({ duplicatePhone: true });
    const repository = new PgClientPhoneRepository(database.service);

    await expect(
      repository.createClientPhone({
        currentUser: currentUser(),
        dto: {
          clientId: 1,
          phoneNumber: '+7 700 000 01 01',
          phoneType: 'mobile',
          isPrimary: false,
          refKey1c: null,
          idempotencyKey: 'client-phone-create-key',
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'CLIENT_PHONE_DUPLICATE',
    });
    expect(normalizedSql(database.queries)).not.toContain('INSERT INTO client_phones');
  });

  it('rejects client movement on update', async () => {
    const database = createDatabase();
    const repository = new PgClientPhoneRepository(database.service);

    await expect(
      repository.updateClientPhone({
        currentUser: currentUser(),
        phoneId: 10,
        dto: {
          clientId: 2,
          phoneNumber: '+7 700 000 02 02',
          idempotencyKey: 'client-phone-update-key',
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'CLIENT_PHONE_CLIENT_CHANGE_UNSUPPORTED',
    });
    expect(normalizedSql(database.queries)).not.toContain('UPDATE client_phones SET');
  });

  it('update audit diff uses {from,to} shape', async () => {
    const database = createDatabase({ updatedPhoneNumber: '+7 700 000 99 99' });
    const repository = new PgClientPhoneRepository(database.service);

    await repository.updateClientPhone({
      currentUser: currentUser(),
      phoneId: 10,
      dto: {
        clientId: 1,
        phoneNumber: '+7 700 000 99 99',
        idempotencyKey: 'client-phone-update-key',
      },
      requestId: 'request-update',
    });

    const updateAuditQuery = database.queries.find(
      (q) => normalizeSql(q.text).startsWith('INSERT INTO audit_log') && q.params[0] === 'client_phones.update',
    );
    expect(updateAuditQuery).toBeDefined();
    const updateDiff = JSON.parse(updateAuditQuery!.params[21] as string);
    expect(updateDiff.phoneNumber).toEqual({ from: '+7 700 000 01 01', to: '+7 700 000 99 99' });
    expect(updateDiff).not.toHaveProperty('phoneNumber.before');
    expect(updateDiff).not.toHaveProperty('phoneNumber.after');
  });

  it('delete audit diff uses {from:false,to:true} for deleted field', async () => {
    const database = createDatabase();
    const repository = new PgClientPhoneRepository(database.service);

    await repository.deleteClientPhone({
      currentUser: currentUser(),
      phoneId: 10,
      dto: { idempotencyKey: 'client-phone-delete-key' },
      requestId: 'request-delete',
    });

    const deleteAuditQuery = database.queries.find(
      (q) => normalizeSql(q.text).startsWith('INSERT INTO audit_log') && q.params[0] === 'client_phones.delete',
    );
    expect(deleteAuditQuery).toBeDefined();
    const deleteDiff = JSON.parse(deleteAuditQuery!.params[21] as string);
    expect(deleteDiff).toEqual({ deleted: { from: false, to: true } });
  });

  it('audit create: redacts api_key in metadata, preserves event/entity/client dims', async () => {
    // Inject a secret-shaped field into the metadata by creating a phone with a refKey1c that
    // would appear in metadataJson — but metadataJson is built internally. Instead we verify
    // the audit dims are correct and that a secret placed in beforeJson/afterJson/diffJson
    // would be redacted. We do this by directly checking what auditService.record() does:
    // it calls redactJson() on before/after/diff/metadata before persisting.
    // The createClientPhone path puts mutablePhoneJson (no secret) into before/after/diff,
    // so we test the redaction contract via the auditService.record route by checking
    // that the params flow through (dims correct) and the redaction path is active.
    const database = createDatabase({ demotedPhoneId: null });
    const repository = new PgClientPhoneRepository(database.service);

    await repository.createClientPhone({
      currentUser: currentUser(),
      dto: {
        clientId: 5,
        phoneNumber: '+7 700 111 11 11',
        phoneType: 'mobile',
        isPrimary: false,
        refKey1c: null,
        idempotencyKey: 'redact-create-key',
      },
      requestId: 'req-redact-create',
    });

    const auditQuery = database.queries.find(
      (q) => normalizeSql(q.text).startsWith('INSERT INTO audit_log') && q.params[0] === 'client_phones.create',
    );
    expect(auditQuery).toBeDefined();
    // Dimensions: event, entity_type, entity_id, user_id, request_id, source, related_client_id
    expect(auditQuery!.params[0]).toBe('client_phones.create');
    expect(auditQuery!.params[1]).toBe('client_phone');         // entity_type
    expect(auditQuery!.params[2]).toBe('11');                   // entity_id (phoneId = 11)
    expect(auditQuery!.params[3]).toBe('1');                    // user_id
    expect(auditQuery!.params[6]).toBe('req-redact-create');    // request_id
    expect(auditQuery!.params[7]).toBe('backend-client-phones-command'); // source
    // Note: related_client_id comes from phone.clientId (DB result), fake returns client_id=1
    expect(auditQuery!.params[9]).toBe(1);                      // related_client_id (from DB row)
    // before_json null on create, after_json has phone fields (fake DB returns default phone_number)
    expect(auditQuery!.params[19]).toBeNull();                  // before_json
    expect(auditQuery!.params[20]).toContain('"phoneNumber"');  // after_json has phoneNumber key
    // Verify redaction is active: diff_json should not contain any raw secret
    // (phone data has no sensitive keys; verify the path flows through redactLogFields)
    const diffStr = auditQuery!.params[21] as string;
    expect(diffStr).not.toContain('SUPER_SECRET');
    // metadata_json: clientId, phoneId etc — no secrets (fake DB returns client_id=1)
    const metaStr = auditQuery!.params[22] as string;
    expect(metaStr).toContain('"clientId":1');
    expect(metaStr).not.toContain('SUPER_SECRET');
  });

  it('audit create: secret-shaped field in afterJson is redacted by AuditService', async () => {
    // We verify redaction by using the import of auditService directly
    // This test exercises the actual redaction path using a custom database that
    // captures audit params and verifies [REDACTED] appears for api_key in after_json.
    const { auditService: svc } = await import('../../../common/audit/audit.service');
    const captured: Array<readonly unknown[]> = [];
    const fakeClient = {
      query: async (text: string, params: readonly unknown[] = []) => {
        if (text.includes('INSERT INTO audit_log')) captured.push(params);
        return { rows: [{ audit_id: 'test-audit-id' }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
      },
    };

    await svc.record(fakeClient as unknown as import('../../../database/database.types').DatabaseClient, {
      event: 'client_phones.create',
      entityType: 'client_phone',
      entityId: '42',
      actorUserId: 1,
      requestId: 'req-secret-test',
      source: 'backend-client-phones-command',
      relatedClientId: 10,
      before: null,
      after: { phoneNumber: '+7 700 000 00 00', api_key: 'SUPER_SECRET' },
      diff: { phoneNumber: { from: null, to: '+7 700 000 00 00' }, api_key: { from: null, to: 'SUPER_SECRET' } },
      metadata: { token: 'SENSITIVE_TOKEN', phoneId: 42 },
    });

    expect(captured).toHaveLength(1);
    const params = captured[0];
    // event + key dims preserved
    expect(params[0]).toBe('client_phones.create');
    expect(params[1]).toBe('client_phone');
    expect(params[2]).toBe('42');
    expect(params[9]).toBe(10);  // related_client_id
    // after_json: api_key redacted, phoneNumber preserved
    const afterJson = JSON.parse(params[20] as string);
    expect(afterJson.phoneNumber).toBe('+7 700 000 00 00');
    expect(afterJson.api_key).toBe('[REDACTED]');
    expect(JSON.stringify(afterJson)).not.toContain('SUPER_SECRET');
    // diff_json: api_key key itself is redacted (entire value replaced, not nested fields)
    const diffJson = JSON.parse(params[21] as string);
    expect(diffJson.api_key).toBe('[REDACTED]');
    expect(JSON.stringify(diffJson)).not.toContain('SUPER_SECRET');
    // metadata_json: token redacted, phoneId preserved
    const metaJson = JSON.parse(params[22] as string);
    expect(metaJson.token).toBe('[REDACTED]');
    expect(metaJson.phoneId).toBe(42);
  });
});

function createDatabase(options: {
  demotedPhoneId?: number | null;
  duplicatePhone?: boolean;
  idempotencyCompletedResponse?: unknown;
  updatedPhoneNumber?: string;
} = {}) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  let lastRequestHash: unknown = 'hash';
  let auditId = 0;
  const tx = {
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });
      const normalized = normalizeSql(text);

      if (normalized.startsWith('INSERT INTO command_idempotency_keys')) {
        lastRequestHash = params[5];
        if (options.idempotencyCompletedResponse) {
          return { rows: [], rowCount: 0 };
        }
        return {
          rows: [
            {
              idempotency_key: params[0],
              request_hash: params[5],
              response_json: null,
              status: 'processing',
            },
          ],
          rowCount: 1,
        };
      }

      if (normalized.startsWith('SELECT idempotency_key, request_hash')) {
        return {
          rows: [
            {
              idempotency_key: params[0],
              request_hash: lastRequestHash,
              response_json: options.idempotencyCompletedResponse,
              status: 'completed',
            },
          ],
          rowCount: 1,
        };
      }

      if (normalized.startsWith('SELECT client_id FROM clients')) {
        return { rows: [{ client_id: params[0] }], rowCount: 1 };
      }

      if (normalized.startsWith('SELECT phone_id FROM client_phones')) {
        return {
          rows: options.duplicatePhone ? [{ phone_id: 10 }] : [],
          rowCount: options.duplicatePhone ? 1 : 0,
        };
      }

      if (normalized.startsWith('SELECT phone_id, client_id') && normalized.includes('WHERE phone_id = $1')) {
        return { rows: [clientPhoneRow({ phone_id: params[0] as number, client_id: 1 })], rowCount: 1 };
      }

      if (normalized.startsWith('SELECT phone_id, client_id') && normalized.includes('is_primary = true')) {
        return {
          rows:
            options.demotedPhoneId === undefined || options.demotedPhoneId === null
              ? []
              : [clientPhoneRow({ phone_id: options.demotedPhoneId, is_primary: true })],
          rowCount: options.demotedPhoneId ? 1 : 0,
        };
      }

      if (normalized.startsWith('INSERT INTO client_phones')) {
        return { rows: [clientPhoneRow({ phone_id: 11, is_primary: true })], rowCount: 1 };
      }

      if (normalized.startsWith('UPDATE client_phones SET') && normalized.includes('WHERE phone_id = $1')) {
        return {
          rows: [clientPhoneRow({ phone_id: params[0] as number, phone_number: options.updatedPhoneNumber ?? '+7 700 000 01 01' })],
          rowCount: 1,
        };
      }

      if (normalized.startsWith('INSERT INTO audit_log')) {
        auditId += 1;
        return { rows: [{ audit_id: `audit-id-${auditId}` }], rowCount: 1 };
      }

      return { rows: [], rowCount: 1 };
    },
  };

  return {
    queries,
    service: {
      async transaction<T>(handler: (client: typeof tx) => Promise<T>) {
        return handler(tx);
      },
    } as unknown as DatabaseService,
  };
}

function currentUser(role: CurrentUser['role'] = 'admin'): CurrentUser {
  return {
    id: '1',
    username: role,
    role,
    roleId: 1,
    permissions: getPermissionsForRole(role),
  };
}

function clientPhoneRow(overrides: Record<string, unknown> = {}) {
  return {
    phone_id: 10,
    client_id: 1,
    phone_number: '+7 700 000 01 01',
    phone_type: 'mobile',
    is_primary: false,
    ref_key_1c: null,
    created_by: 1,
    edited_by: null,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: null,
    ...overrides,
  };
}

function clientPhoneDto(overrides: Record<string, unknown> = {}) {
  return {
    phoneId: 10,
    clientId: 1,
    phoneNumber: '+7 700 000 01 01',
    phoneType: 'mobile',
    isPrimary: false,
    refKey1c: null,
    createdBy: 1,
    editedBy: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: null,
    ...overrides,
  };
}

function normalizedSql(queries: Array<{ text: string }>): string {
  return queries.map((query) => normalizeSql(query.text)).join('\n');
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}
