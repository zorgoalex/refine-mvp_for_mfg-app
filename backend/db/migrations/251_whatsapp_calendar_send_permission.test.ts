import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, type PermissionName, type UserRole } from '../../src/permissions/permissions';

const sql = readFileSync(resolve(__dirname, '251_whatsapp_calendar_send_permission.sql'), 'utf8');
const NEW_PERMISSIONS = ['whatsapp.calendar_send'] as const;

describe('migration 251: the calendar «Отправить в чат» behind its own permission', () => {
  it('is one bounded transaction that bumps the authorization version', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain('UPDATE public.permissions_state SET version = version + 1');
    expect(sql).toContain('ON CONFLICT (role_id, permission_name) DO NOTHING');
    // permissions_state is locked before any catalog or grant row (same order as the roles matrix).
    const lock = sql.indexOf('FROM public.permissions_state WHERE id = true FOR UPDATE');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(sql.indexOf('INSERT INTO public.permissions_catalog'));
  });

  it('grants the permission to exactly the roles of the static matrix', () => {
    const grants = [...sql.matchAll(/\('([a-z0-9_.]+)', '([a-z_]+)'\)/g)].map(([, permission, role]) => `${permission}:${role}`).sort();
    const expected = (Object.keys(ROLE_PERMISSIONS) as UserRole[])
      .flatMap((role) => NEW_PERMISSIONS.filter((p) => (ROLE_PERMISSIONS[role] as readonly PermissionName[]).includes(p)).map((p) => `${p}:${role}`))
      .sort();
    expect(grants).toEqual(expected);
  });

  it('top manager and above may send from the calendar; manager and the other roles may not', () => {
    const has = (role: UserRole, permission: PermissionName) => (ROLE_PERMISSIONS[role] as readonly PermissionName[]).includes(permission);
    expect((Object.keys(ROLE_PERMISSIONS) as UserRole[]).filter((role) => has(role, 'whatsapp.calendar_send')).sort())
      .toEqual(['admin', 'superadmin', 'top_manager']);
    // The settings of the calendar send and the broadcasts stay with whatsapp.manage.
    expect(has('top_manager', 'whatsapp.manage')).toBe(false);
  });

  it('keeps the button for every role that had it and moves the system broadcast to the calendar bundle', () => {
    expect(sql).toMatch(/SELECT rp\.role_id, 'whatsapp\.calendar_send', true\s+FROM public\.role_permissions rp\s+WHERE rp\.permission_name = 'whatsapp\.manage' AND rp\.is_enabled/);
    expect(sql).toMatch(/UPDATE public\.whatsapp_broadcasts\s+SET required_permissions = ARRAY\['whatsapp\.calendar_send', 'calendar\.view', 'orders\.view', 'orders\.view_financials'\]\s+WHERE purpose = 'calendar'/);
    // The settings version is the compare-and-swap token of the form: the migration must not move it.
    expect(sql).not.toMatch(/whatsapp_broadcasts[^;]*\bversion\s*=/);
  });
});
