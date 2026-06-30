import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('./CutPage.tsx', import.meta.url), 'utf8');

describe('CutPage combine-films toggle wiring', () => {
  it('renders the combine-films Checkbox bound to setJobCombineFilms', () => {
    expect(src).toMatch(/Объединить разные плёнки/);
    expect(src).toMatch(/checked=\{job\.combineFilms\}/);
    expect(src).toMatch(/setJobCombineFilms/);
    expect(src).toMatch(/cutApi\.setCombineFilms/);
  });
  it('disables the toggle for read-only / busy / calculating / archived jobs', () => {
    // mirror the sheet/profile control gating
    expect(src).toMatch(/!canManage \|\| busy \|\| job\.status === 'calculating' \|\| isArchivedJob/);
  });
  it('notes that the change applies after «Рассчитать»', () => {
    expect(src).toMatch(/применится после команды «Рассчитать»/);
  });
});
