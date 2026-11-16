import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HASURA_PERMISSION_REACH, hasuraReachGaps, hasuraRoleForErpRole } from './hasuraPermissionReach';

type Rule = { any?: string[]; all?: string[] };
type Table = { table: { name: string } } & Partial<Record<`${'select' | 'insert' | 'update' | 'delete'}_permissions`, Array<{ role: string }>>>;

const root = process.cwd();
const rules = JSON.parse(readFileSync(resolve(root, 'ops/hasura/access-predicates.json'), 'utf8')) as { tables: Record<string, Record<string, Rule>> };
const metadata = JSON.parse(readFileSync(resolve(root, 'ops/hasura/metadata.json'), 'utf8')) as { sources: Array<{ tables: Table[] }> };

describe('HASURA_PERMISSION_REACH (access groups: limits of the base Hasura role)', () => {
  it('equals the map built from the predicate rules and the metadata snapshot (regenerate after a metadata change)', () => {
    const have = new Map<string, Set<string>>();
    for (const table of metadata.sources[0].tables) {
      for (const op of ['select', 'insert', 'update', 'delete'] as const) {
        for (const { role } of table[`${op}_permissions`] ?? []) {
          const key = `${table.table.name}.${op}`;
          if (!have.has(key)) have.set(key, new Set());
          have.get(key)!.add(role);
        }
      }
    }
    const expected: Record<string, Record<string, string[]>> = {};
    for (const [table, ops] of Object.entries(rules.tables)) {
      for (const [op, rule] of Object.entries(ops)) {
        for (const permission of [...(rule.any ?? []), ...(rule.all ?? [])]) {
          (expected[permission] ??= {})[`${table}.${op}`] = [...(have.get(`${table}.${op}`) ?? [])].sort();
        }
      }
    }
    expect(HASURA_PERMISSION_REACH).toEqual(expected);
  });

  it('names the gaps of a base role and none for backend-only permissions', () => {
    expect(hasuraRoleForErpRole('admin')).toBe('erp_admin');
    expect(hasuraReachGaps(['orders.manager.change'], 'viewer')).toEqual([]);
    expect(hasuraReachGaps(['clients.create'], 'viewer')).toEqual([{ permission: 'clients.create', targets: ['clients.insert'] }]);
    expect(hasuraReachGaps(['clients.create'], 'manager')).toEqual([]);
    // A role without any Hasura profile (service roles) cannot use any Hasura-backed permission.
    expect(hasuraReachGaps(['clients.view'], 'onec_operator')[0]?.targets.length).toBeGreaterThan(0);
    // A partial reach is not a gap: the viewer reads orders_view though not the orders table.
    expect(hasuraReachGaps(['orders.view'], 'viewer')).toEqual([]);
    // What the user already holds (from the role) is never reported.
    expect(hasuraReachGaps(['clients.create'], 'viewer', new Set(['clients.create']))).toEqual([]);
  });
});
