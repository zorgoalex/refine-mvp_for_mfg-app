import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readPage = (name: string) => readFileSync(new URL(`./${name}.tsx`, import.meta.url), 'utf8');
const dataProviderSource = readFileSync(new URL('../../utils/dataProvider.ts', import.meta.url), 'utf8');

describe('milling type minimum dimensions CRUD', () => {
  it.each(['create', 'edit'])('exposes optional width and height inputs on %s', (page) => {
    const source = readPage(page);
    expect(source).toContain('name="min_width_mm"');
    expect(source).toContain('name="min_height_mm"');
    expect(source).toContain('placeholder="Без ограничения"');
  });

  it.each(['list', 'show'])('displays combined minimum dimensions on %s', (page) => {
    expect(readPage(page)).toContain('Минимальные размеры детали');
  });

  it('includes both fields in direct Hasura reference reads', () => {
    const millingFields = dataProviderSource.slice(
      dataProviderSource.indexOf('milling_types: ['),
      dataProviderSource.indexOf('films: ['),
    );
    expect(millingFields).toContain('"min_width_mm"');
    expect(millingFields).toContain('"min_height_mm"');
  });
});
