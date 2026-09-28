import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const create = readFileSync(new URL('./create.tsx', import.meta.url), 'utf8');
const edit = readFileSync(new URL('./edit.tsx', import.meta.url), 'utf8');
const show = readFileSync(new URL('./show.tsx', import.meta.url), 'utf8');
const list = readFileSync(new URL('./list.tsx', import.meta.url), 'utf8');
const quickCreate = readFileSync(new URL('../orders/components/modals/FilmQuickCreate.tsx', import.meta.url), 'utf8');

describe('film catalog screens guard', () => {
  it('keeps Ref Key 1C out of editable form controls and validates nomenclature lengths/vendor', () => {
    expect(create).not.toMatch(/Form\.Item[^]*name="ref_key_1c"/);
    expect(edit).not.toMatch(/Form\.Item[^]*name="ref_key_1c"/);
    expect(edit).toContain('current?.ref_key_1c');
    expect(show).toContain('record?.ref_key_1c');
    expect(create).toContain('Максимум 50 символов');
    expect(create).toContain('Максимум 150 символов');
    expect(create).toContain('Поставщик «нд» недопустим');
  });

  it('warns before film creation in both forms and exposes catalog list fields/merge links', () => {
    expect(create).toContain('confirmSimilarFilmCreation');
    expect(quickCreate).toContain('confirmSimilarFilmCreation');
    expect(list).toContain('Тип номенклатуры');
    expect(list).toContain('Категория номенклатуры');
    expect(list).toContain('Объединена:');
    expect(list).toContain('features?.filmCatalogImport === true');
  });
});
