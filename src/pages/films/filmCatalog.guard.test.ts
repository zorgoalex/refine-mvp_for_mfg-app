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

  it('keeps the list head and pagination on screen and fits the table without horizontal scrolling', () => {
    const css = readFileSync(new URL('./films.css', import.meta.url), 'utf8');
    expect(list).toContain('className="films-list__head" style={{ top: tabsHeight }}');
    expect(list).toContain('sticky={{ offsetHeader: tabsHeight + headHeight }}');
    expect(list).toContain('tableLayout="fixed"');
    expect(css).toMatch(/\.films-list__head \{\s*position: sticky;/);
    expect(css).toMatch(/\.ant-table-pagination\.ant-pagination \{\s*position: sticky;\s*bottom: var\(--films-list-bottom, 0px\);/);
    // Один размер шрифта во всех ячейках: название не уменьшается и не обрезается, примечание — две строки.
    expect(css).not.toContain('font-size: 0.75em');
    expect(css).toMatch(/\.films-list__note \{[^}]*-webkit-line-clamp: 2;[^}]*overflow: hidden;/);
    expect(css).toMatch(/\.films-list__name \{ overflow-wrap: anywhere;/);
    expect(list).toContain('<Tooltip title={text}><span className="films-list__note">{text}</span></Tooltip>');
    expect(list).toContain('<Tooltip title={value}><span className="films-list__key">{value}</span></Tooltip>');
    expect(css).toMatch(/\.films-list__key \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
    expect(list).toContain('note: 110');
    // width: auto отключает fixed-раскладку (колонки по содержимому) — таблице нужна ширина 100%.
    expect(list).toContain("scroll={{ x: '100%' }}");
    expect(list).toContain("useStickyBottom('.workspace-tabs')");
  });
});
