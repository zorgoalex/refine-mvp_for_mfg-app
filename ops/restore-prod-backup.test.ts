import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('./restore-prod-backup.sh', import.meta.url),
  'utf8',
);

describe('restore-prod-backup safety contract', () => {
  it('uses a fail-fast three-phase restore in the required order', () => {
    const preData = source.indexOf('--section=pre-data');
    const deferCheck = source.indexOf('\ndefer_cut_result_check\n', preData);
    const data = source.indexOf('--section=data');
    const postData = source.indexOf('--section=post-data');
    const restoreCheck = source.indexOf('\nrestore_cut_result_check\n', postData);

    expect(preData).toBeGreaterThan(-1);
    expect(preData).toBeLessThan(deferCheck);
    expect(deferCheck).toBeLessThan(data);
    expect(data).toBeLessThan(postData);
    expect(postData).toBeLessThan(restoreCheck);
    expect(source.match(/--exit-on-error/g)).toHaveLength(3);
  });

  it('defers only the known order-sensitive CHECK and preserves its state', () => {
    expect(source).toContain('chk_cut_result_snapshot_shape');
    expect(source).toContain("to_regclass('public.cut_result')");
    expect(source).toContain('pg_get_constraintdef');
    expect(source).toContain('convalidated');
    expect(source).toContain('obj_description');
    expect(source).toContain('NOT VALID');
    expect(source).toContain('VALIDATE CONSTRAINT');
    expect(source).toContain('COMMENT ON CONSTRAINT');
    expect(source).not.toMatch(/DROP CONSTRAINT[\s\S]*contype\s*=\s*'c'/);
  });

  it('quotes database names through client arguments and psql variables', () => {
    expect(source).toContain('dropdb -U "$PG_USER" --force --if-exists "$PG_DB"');
    expect(source).toContain('createdb -U "$PG_USER" -O "$PG_USER" "$PG_DB"');
    expect(source).toContain('--set=db_name="$PG_DB"');
    expect(source).not.toContain('DROP DATABASE IF EXISTS');
    expect(source).not.toContain('CREATE DATABASE \\"${PG_DB}\\"');
  });

  it('quiesces writers and reports the pre-restore rollback artifact on failure', () => {
    expect(source).toContain('writer_services=(backend cnc-telegram-worker)');
    expect(source).toContain('--no-stop-writers');
    expect(source).toContain('--no-start-writers');
    expect(source).toContain('pre_dump');
    expect(source).toContain('Restore failed; database writers remain stopped');
  });

  it('keeps setup-vps compatible arguments', () => {
    for (const argument of [
      '--project-dir',
      '--env-file',
      '--compose-file',
      '--main-dump',
      '--globals-dump',
      '--restore-globals',
      '--confirm-db',
      '--skip-pre-backup',
      '--no-stop-hasura',
      '--no-start-hasura',
      '--no-reset-sequences',
    ]) {
      expect(source).toContain(argument);
    }
  });
});
