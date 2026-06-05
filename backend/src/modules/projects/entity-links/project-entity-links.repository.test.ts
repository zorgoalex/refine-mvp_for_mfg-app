import { describe, expect, it } from 'vitest';
import { PgProjectEntityLinksRepository } from './project-entity-links.repository';

describe('PgProjectEntityLinksRepository', () => {
  it('lists from project_entity_links without using project_order_projects', async () => {
    const database = fakeDatabase();
    const repo = new PgProjectEntityLinksRepository(database);

    await expect(repo.list({
      currentUser: user(),
      projectId: projectId(),
      visibleEntityTypes: ['client'],
    })).resolves.toMatchObject({ projectId: projectId(), links: [] });

    const sql = database.queries.map((query) => query.text).join('\n');
    expect(sql).toContain('FROM public.project_entity_links');
    expect(sql).not.toContain('project_order_projects');
  });

  it('replace validates fixed registry query and writes idempotency command', async () => {
    const database = fakeDatabase();
    const repo = new PgProjectEntityLinksRepository(database);

    await repo.replace({
      currentUser: user(),
      projectId: projectId(),
      dto: {
        idempotencyKey: 'links-key',
        links: [{ entityType: 'client', entityId: '42', relationType: 'related', metadata: {} }],
      },
    });

    const sql = database.queries.map((query) => query.text).join('\n');
    const params = database.queries.flatMap((query) => [...query.params]);
    expect(params).toContain('projects.entity_links.replace');
    expect(sql).toContain('FROM public.clients');
    expect(sql).toContain('WHERE client_id = $1::bigint');
    expect(sql).toContain('FOR KEY SHARE');
    expect(sql).toContain('INSERT INTO public.project_entity_links');
    expect(params).toContain('PROJECT_ENTITY_LINKS_CHANGED');
  });

  it('empty replace does not clear unrelated entity types', async () => {
    const database = fakeDatabase();
    const repo = new PgProjectEntityLinksRepository(database);

    await repo.replace({
      currentUser: user(),
      projectId: projectId(),
      dto: { idempotencyKey: 'empty-key', links: [] },
    });

    const linkLoad = database.queries.find((query) => query.text.includes('FROM public.project_entity_links'));
    expect(linkLoad).toBeUndefined();
    expect(database.queries.map((query) => query.text).join('\n')).not.toContain('UPDATE public.project_entity_links');
  });

  it('append only loads submitted entity types for duplicate checks and response', async () => {
    const database = fakeDatabase();
    const repo = new PgProjectEntityLinksRepository(database);

    await repo.append({
      currentUser: user(),
      projectId: projectId(),
      dto: {
        idempotencyKey: 'append-key',
        links: [{ entityType: 'client', entityId: '42', relationType: 'related', metadata: {} }],
      },
    });

    const linkLoad = database.queries.find((query) => query.text.includes('FROM public.project_entity_links'));
    expect(linkLoad?.params).toContainEqual(['client']);
  });
});

function fakeDatabase() {
  const database = {
    queries: [] as Array<{ text: string; params: readonly unknown[] }>,
    async query(text: string, params: readonly unknown[] = []) {
      this.queries.push({ text, params });
      if (text.includes('INSERT INTO command_idempotency_keys')) return { rows: [{ status: 'processing', request_hash: 'hash', response_json: null }] };
      if (text.includes('SELECT id::text, code FROM public.project_projects')) return { rows: [{ id: projectId(), code: 'P1' }] };
      if (text.includes('SELECT id FROM public.project_projects')) return { rows: [{ id: projectId() }] };
      if (text.includes('FROM public.project_entity_types')) return { rows: [{ code: 'client' }] };
      if (text.includes('FROM public.clients')) return { rows: [{ entity_id: '42', display_label: 'Client 42' }] };
      if (text.includes('FROM public.project_entity_links')) return { rows: [] };
      if (text.includes('INSERT INTO public.project_entity_links')) {
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

function projectId(): string {
  return '11111111-1111-4111-8111-111111111111';
}
