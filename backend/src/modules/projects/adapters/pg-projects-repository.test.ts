import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { PgProjectsRepository } from './pg-projects-repository';

describe('PgProjectsRepository.update', () => {
  it('locks the project row FOR UPDATE, writes exactly one audit row, and returns the updated dto', async () => {
    const database = createDatabase({
      beforeRow: {
        project_id: 5,
        code: 'ФК25',
        name: 'Старая кухня',
        client_id: 9,
        notes: 'old',
        version: 2,
        delete_flag: false,
      },
      updatedRow: {
        project_id: 5,
        code: 'ФК26',
        name: 'Новая кухня',
        client_id: 9,
        notes: null,
        version: 3,
      },
    });

    const result = await new PgProjectsRepository(database.service).update({
      currentUser: currentUser(),
      projectId: 5,
      dto: { code: 'ФК26', name: 'Новая кухня', notes: null },
      expectedVersion: 2,
      requestId: 'req-1',
    });

    expect(result).toMatchObject({
      projectId: 5,
      code: 'ФК26',
      name: 'Новая кухня',
      clientId: 9,
      notes: null,
      version: 3,
    });

    const sql = normalizedSql(database.queries);
    expect(sql).toContain('SELECT set_session_user($1)');
    expect(sql).toContain('FROM projects WHERE project_id = $1 FOR UPDATE');
    expect(sql).toContain('UPDATE projects SET');
    expect(database.queries.filter((query) => normalizeSql(query.text).startsWith('INSERT INTO audit_log (')).length).toBe(1);

    const audit = database.queries.find((query) => normalizeSql(query.text).startsWith('INSERT INTO audit_log'));
    expect(audit).toBeDefined();
    expect(audit?.params[0]).toBe('project.updated');
    expect(audit?.params[1]).toBe('project');
    expect(audit?.params[2]).toBe('5');
    expect(audit?.params[9]).toBe(9);
    expect(audit?.params[22]).toContain('"projectId":5');
    expect(audit?.params[22]).toContain('"action":"project_update"');
  });

  it('maps stale version to 409 VERSION_CONFLICT before update', async () => {
    const database = createDatabase({
      beforeRow: {
        project_id: 5,
        code: 'ФК25',
        name: 'Старая кухня',
        client_id: 9,
        notes: 'old',
        version: 3,
        delete_flag: false,
      },
    });

    await expect(
      new PgProjectsRepository(database.service).update({
        currentUser: currentUser(),
        projectId: 5,
        dto: { code: 'ФК26' },
        expectedVersion: 2,
        requestId: 'req-1',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'VERSION_CONFLICT' });

    const sql = normalizedSql(database.queries);
    expect(sql).not.toContain('UPDATE projects SET');
    expect(sql).not.toContain('INSERT INTO audit_log');
  });

  it('maps unique violation 23505 to 409 PROJECT_CODE_TAKEN', async () => {
    const database = createDatabase({
      beforeRow: {
        project_id: 5,
        code: 'ФК25',
        name: 'Старая кухня',
        client_id: 9,
        notes: 'old',
        version: 2,
        delete_flag: false,
      },
      throwOnUpdate: { code: '23505' },
    });

    await expect(
      new PgProjectsRepository(database.service).update({
        currentUser: currentUser(),
        projectId: 5,
        dto: { code: 'ФК26' },
        expectedVersion: 2,
        requestId: 'req-1',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PROJECT_CODE_TAKEN' });

    expect(normalizedSql(database.queries)).not.toContain('INSERT INTO audit_log');
  });
});

function createDatabase(
  options: {
    beforeRow?: Record<string, unknown>;
    updatedRow?: Record<string, unknown>;
    throwOnUpdate?: { code: string };
  } = {},
) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  let auditId = 0;
  const tx = {
    raw: {} as never,
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });
      const normalized = normalizeSql(text);

      if (normalized.startsWith('SELECT project_id, code, name, client_id, notes, version, delete_flag FROM projects')) {
        return { rows: options.beforeRow ? [options.beforeRow] : [], rowCount: options.beforeRow ? 1 : 0 };
      }

      if (normalized.startsWith('UPDATE projects SET')) {
        if (options.throwOnUpdate) {
          throw options.throwOnUpdate;
        }
        return { rows: options.updatedRow ? [options.updatedRow] : [], rowCount: options.updatedRow ? 1 : 0 };
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

function currentUser(role: CurrentUser['role'] = 'manager'): CurrentUser {
  return {
    id: '7',
    username: role,
    role,
    roleId: 10,
    permissions: getPermissionsForRole(role),
  };
}

function normalizedSql(queries: Array<{ text: string }>): string {
  return queries.map((query) => normalizeSql(query.text)).join('\n');
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}
