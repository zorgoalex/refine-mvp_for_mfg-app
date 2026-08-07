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
    // anchored to the combine-films tooltip so a localized copy regression is caught
    expect(src).toMatch(/плёнками кроятся вместе; применится после команды «Рассчитать»/);
  });
});

describe('CutPage rotation and texture controls wiring', () => {
  it('renders rotation checkbox bound to setJobRotationAllowed', () => {
    expect(src).toMatch(/Поворот разрешён/);
    expect(src).toMatch(/checked=\{job\.rotationAllowed\}/);
    expect(src).toMatch(/setJobRotationAllowed/);
    expect(src).toMatch(/cutApi\.setRotationAllowed/);
  });

  it('renders informational texture direction select bound to setJobTextureDirection', () => {
    expect(src).toMatch(/Направление текстуры/);
    expect(src).toMatch(/value=\{job\.textureDirection \?\? 'none'\}/);
    expect(src).toMatch(/CUT_TEXTURE_DIRECTION_OPTIONS/);
    expect(src).toMatch(/setJobTextureDirection/);
    expect(src).toMatch(/cutApi\.setTextureDirection/);
  });
});
