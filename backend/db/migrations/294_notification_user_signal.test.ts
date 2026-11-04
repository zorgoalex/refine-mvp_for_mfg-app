import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '294_notification_user_signal.sql'), 'utf8');
const code = sql.replace(/--.*$/gm, '');

describe('migration 294: pg_notify on visible changes of notifications', () => {
  it('runs in one transaction with a lock timeout', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(code).toContain("SET LOCAL lock_timeout = '5s';");
  });

  it('signals the user id on insert/delete and on a real change of is_read / balloon_shown_at only', () => {
    expect(code).toContain("pg_notify('erp_user_notifications', NEW.user_id::text)");
    expect(code).toContain("pg_notify('erp_user_notifications', OLD.user_id::text)");
    expect(code).toContain('AFTER INSERT OR DELETE ON public.notifications');
    expect(code).toContain('AFTER UPDATE OF is_read, balloon_shown_at ON public.notifications');
    expect(code).toContain('WHEN (OLD.is_read IS DISTINCT FROM NEW.is_read OR OLD.balloon_shown_at IS DISTINCT FROM NEW.balloon_shown_at)');
    expect(code).not.toContain('balloon_leased_at');
  });
});
