import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '260_crm_sync_payment_notifications.sql'), 'utf8');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 260: Bitrix24 payment notifications', () => {
  it('is one bounded additive transaction, re-runnable', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.crm_sync_payment_notification');
    expect(sql).not.toMatch(/\b(ALTER TABLE|DELETE|UPDATE)\b/);
    expect(sql.match(/\bDROP\b/g)).toEqual(['DROP']);
    expect(sql).toContain('DROP TRIGGER IF EXISTS trg_crm_sync_outbox_notification_capture ON public.crm_sync_outbox;');
  });

  it('keeps the step states and the terminal invariants in the schema', () => {
    expect(sql).toContain("comment_state IN ('none', 'attempting', 'created', 'unresolved', 'resolved', 'unknown', 'failed')");
    expect(sql).toContain("notify_state IN ('none', 'attempting', 'sent', 'unknown', 'no_scope', 'no_recipient', 'failed')");
    expect(sql).toContain("CHECK ((status = 'pending') = (completed_at IS NULL))");
    expect(sql).toContain("CHECK ((status = 'skipped') = (skip_reason IS NOT NULL))");
    expect(sql).toMatch(/idx_crm_sync_payment_notification_due[\s\S]*WHERE status = 'pending'/);
  });

  it('captures the enqueued sync event only while the command capture is on and its session table exists', () => {
    expect(sql).toContain("IF COALESCE(current_setting('app.payment_audit_capture', true), '') <> 'on'");
    expect(sql).toContain("OR to_regclass('pg_temp.payment_notification_sync_event') IS NULL THEN");
    expect(sql).toContain('AFTER INSERT ON public.crm_sync_outbox');
  });

  it('has an end-state probe in the migration runner', () => {
    expect(runner).toContain('260_crm_sync_payment_notifications*) probe_all');
    // In the verify list of the runner; later migrations may follow it there.
    expect(runner).toMatch(/\|260_crm_sync_payment_notifications\*[|)]/);
  });
});
