import { describe, expect, it } from 'vitest';
import { PgGroupEntityLinksRepository } from './group-entity-links.repository';

describe('PgGroupEntityLinksRepository', () => {
  it('lists from group_entity_links without using group_order_groups', async () => {
    const database = fakeDatabase();
    const repo = new PgGroupEntityLinksRepository(database);

    await expect(repo.list({
      currentUser: user(),
      groupId: groupId(),
      visibleEntityTypes: ['client'],
    })).resolves.toMatchObject({ groupId: groupId(), links: [] });

    const sql = database.queries.map((query) => query.text).join('\n');
    expect(sql).toContain('FROM public.group_entity_links');
    expect(sql).not.toContain('group_order_groups');
  });

  it('replace validates fixed registry query and writes idempotency command', async () => {
    const database = fakeDatabase();
    const repo = new PgGroupEntityLinksRepository(database);

    await repo.replace({
      currentUser: user(),
      groupId: groupId(),
      dto: {
        idempotencyKey: 'links-key',
        links: [{ entityType: 'client', entityId: '42', relationType: 'related', metadata: {} }],
      },
    });

    const sql = database.queries.map((query) => query.text).join('\n');
    const params = database.queries.flatMap((query) => [...query.params]);
    expect(params).toContain('groups.entity_links.replace');
    expect(sql).toContain('FROM public.clients');
    expect(sql).toContain('WHERE client_id = $1::bigint');
    expect(sql).toContain('FOR KEY SHARE');
    expect(sql).toContain('INSERT INTO public.group_entity_links');
    expect(params).toContain('GROUP_ENTITY_LINKS_CHANGED');
  });

  it('empty replace does not clear unrelated entity types', async () => {
    const database = fakeDatabase();
    const repo = new PgGroupEntityLinksRepository(database);

    await repo.replace({
      currentUser: user(),
      groupId: groupId(),
      dto: { idempotencyKey: 'empty-key', links: [] },
    });

    const linkLoad = database.queries.find((query) => query.text.includes('FROM public.group_entity_links'));
    expect(linkLoad).toBeUndefined();
    expect(database.queries.map((query) => query.text).join('\n')).not.toContain('UPDATE public.group_entity_links');
  });

  it('append only loads submitted entity types for duplicate checks and response', async () => {
    const database = fakeDatabase();
    const repo = new PgGroupEntityLinksRepository(database);

    await repo.append({
      currentUser: user(),
      groupId: groupId(),
      dto: {
        idempotencyKey: 'append-key',
        links: [{ entityType: 'client', entityId: '42', relationType: 'related', metadata: {} }],
      },
    });

    const linkLoad = database.queries.find((query) => query.text.includes('FROM public.group_entity_links'));
    expect(linkLoad?.params).toContainEqual(['client']);
  });

  it('audit entity_links_changed: secret-shaped fields in before/after/metadata are redacted by AuditService', async () => {
    const { auditService: svc } = await import('../../../common/audit/audit.service');
    const captured: Array<readonly unknown[]> = [];
    const fakeClient = {
      query: async (text: string, params: readonly unknown[] = []) => {
        if (text.includes('INSERT INTO audit_log')) captured.push(params);
        return { rows: [{ audit_id: 'link-audit-1' }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
      },
    };

    await svc.record(fakeClient as unknown as import('../../../database/database.types').DatabaseClient, {
      event: 'groups.entity_links_changed',
      entityType: 'group',
      entityId: groupId(),
      actorUserId: 1,
      actorUsername: 'tester',
      actorRole: 'admin',
      requestId: 'req-link-secret',
      source: 'groups-entity-links',
      before: { links: [{ entityType: 'client', entityId: '42', api_key: 'SUPER_SECRET' }] },
      after: { links: [{ entityType: 'order', entityId: '10', token: 'SECRET_TOKEN' }] },
      diff: { added: [{ entityType: 'order', entityId: '10' }], removed: [{ entityType: 'client', entityId: '42' }], existing: [], skipped: [] },
      metadata: { idempotencyKey: 'link-key', secret: 'VERY_SECRET', createdCount: 1 },
    });

    expect(captured).toHaveLength(1);
    const params = captured[0];
    // Dimensions
    expect(params[0]).toBe('groups.entity_links_changed');
    expect(params[1]).toBe('group');
    expect(params[2]).toBe(groupId());
    expect(params[6]).toBe('req-link-secret');
    expect(params[7]).toBe('groups-entity-links');
    // before_json: api_key redacted
    const beforeJson = JSON.parse(params[19] as string);
    expect(beforeJson.links[0].api_key).toBe('[REDACTED]');
    expect(JSON.stringify(beforeJson)).not.toContain('SUPER_SECRET');
    // after_json: token redacted
    const afterJson = JSON.parse(params[20] as string);
    expect(afterJson.links[0].token).toBe('[REDACTED]');
    expect(JSON.stringify(afterJson)).not.toContain('SECRET_TOKEN');
    // metadata_json: secret redacted, createdCount and idempotencyKey preserved
    const metaJson = JSON.parse(params[22] as string);
    expect(metaJson.idempotencyKey).toBe('link-key');
    expect(metaJson.createdCount).toBe(1);
    expect(metaJson.secret).toBe('[REDACTED]');
    expect(JSON.stringify(metaJson)).not.toContain('VERY_SECRET');
  });
});

function fakeDatabase() {
  const database = {
    queries: [] as Array<{ text: string; params: readonly unknown[] }>,
    async query(text: string, params: readonly unknown[] = []) {
      this.queries.push({ text, params });
      if (text.includes('INSERT INTO command_idempotency_keys')) return { rows: [{ status: 'processing', request_hash: 'hash', response_json: null }] };
      if (text.includes('SELECT id::text, code FROM public.group_groups')) return { rows: [{ id: groupId(), code: 'P1' }] };
      if (text.includes('SELECT id FROM public.group_groups')) return { rows: [{ id: groupId() }] };
      if (text.includes('FROM public.group_entity_types')) return { rows: [{ code: 'client' }] };
      if (text.includes('FROM public.clients')) return { rows: [{ entity_id: '42', display_label: 'Client 42' }] };
      if (text.includes('FROM public.group_entity_links')) return { rows: [] };
      if (text.includes('INSERT INTO public.group_entity_links')) {
        return { rows: [{
          id: '22222222-2222-4222-8222-222222222222',
          entity_type_code: 'client',
          entity_id_text: '42',
          display_label: 'Client 42',
          relation_type: 'related',
          valid_from: '2026-06-04T00:00:00.000Z',
          valid_to: null,
          metadata: {},
        }] };
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

function user() {
  return { id: '1', username: 'tester', role: 'admin', roleId: 1, permissions: [] };
}

function groupId(): string {
  return '11111111-1111-4111-8111-111111111111';
}
