import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('212 films note migration', () => {
  const sql = readFileSync(new URL('./212_films_note.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

  it('adds a nullable bounded note column idempotently and touches no data', () => {
    expect(sql).toContain('ALTER TABLE public.films ADD COLUMN IF NOT EXISTS note TEXT NULL');
    expect(sql).toContain('CHECK (note IS NULL OR length(note) <= 2000)');
    expect(sql).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint[\s\S]*chk_films_note_length/);
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|INSERT)\s+/im);
    expect(sql).not.toMatch(/\bDROP\b/i);
  });

  it('probes the column and the check before recording the ledger', () => {
    expect(runner).toContain('212_films_note*) probe_all');
    expect(runner).toContain('q_col films note');
    expect(runner).toContain('q_con_on films chk_films_note_length');
    const verify = runner.slice(runner.indexOf('verify_applied_effect() {'));
    expect(verify).toMatch(/212_films_note\*\)\s+probe_file "\$f" \|\| die/);
  });
});
