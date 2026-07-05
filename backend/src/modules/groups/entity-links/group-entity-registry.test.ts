import { describe, expect, it } from 'vitest';
import {
  GROUP_ENTITY_REGISTRY,
  GROUP_ENTITY_TYPE_CODES,
  buildGroupEntityExistenceQuery,
  isGroupEntityTypeCode,
  type GroupEntityTypeCode,
} from './group-entity-registry';

const expectedRegistry = {
  order: {
    permission: 'orders.view',
    from: 'FROM public.orders',
    where: 'WHERE order_id = $1::bigint',
  },
  user: {
    permission: 'users.view',
    from: 'FROM public.users',
    where: 'WHERE user_id = $1::bigint',
  },
  employee: {
    permission: 'employees.view',
    from: 'FROM public.employees',
    where: 'WHERE employee_id = $1::bigint',
  },
  client: {
    permission: 'clients.view',
    from: 'FROM public.clients',
    where: 'WHERE client_id = $1::bigint',
  },
  workshop: {
    permission: 'workshops.view',
    from: 'FROM public.workshops',
    where: 'WHERE workshop_id = $1::bigint',
  },
  deadline_instance: {
    permission: 'deadlines.view',
    from: 'FROM public.deadline_instances',
    where: 'WHERE deadline_id = $1::uuid',
  },
} as const satisfies Record<GroupEntityTypeCode, { permission: string; from: string; where: string }>;

describe('group entity registry', () => {
  it('contains exactly the accepted allowlist', () => {
    expect(Object.keys(GROUP_ENTITY_REGISTRY).sort()).toEqual([
      'client',
      'deadline_instance',
      'employee',
      'order',
      'user',
      'workshop',
    ]);
    expect([...GROUP_ENTITY_TYPE_CODES].sort()).toEqual(Object.keys(GROUP_ENTITY_REGISTRY).sort());
  });

  it('defines permission metadata for every allowlisted entity type', () => {
    for (const [entityType, expected] of Object.entries(expectedRegistry)) {
      expect(GROUP_ENTITY_REGISTRY[entityType as GroupEntityTypeCode].requiredPermission).toBe(expected.permission);
    }
  });

  it('builds fixed existence queries with value placeholders', () => {
    for (const [entityType, expected] of Object.entries(expectedRegistry)) {
      const query = buildGroupEntityExistenceQuery(entityType as GroupEntityTypeCode, 1);

      expect(normalizeSql(query.text)).toContain(expected.from);
      expect(normalizeSql(query.text)).toContain(expected.where);
      expect(normalizeSql(query.text)).toContain('FOR KEY SHARE');
      expect(query.values).toEqual(['1']);
    }
  });

  it('keeps request values out of SQL identifiers and text', () => {
    const maliciousId = '1; SELECT * FROM payments';
    const query = buildGroupEntityExistenceQuery('client', maliciousId);

    expect(normalizeSql(query.text)).toContain('FROM public.clients');
    expect(query.text).not.toContain(maliciousId);
    expect(query.text).not.toContain('payments');
    expect(query.values).toEqual([maliciousId]);
  });

  it('narrows only accepted entity type codes', () => {
    expect(isGroupEntityTypeCode('client')).toBe(true);
    expect(isGroupEntityTypeCode('payment')).toBe(false);
    expect(isGroupEntityTypeCode('clients; DROP TABLE users')).toBe(false);
  });
});

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}
