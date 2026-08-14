import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../..');

describe('extra resources UI wiring', () => {
  it('renders an extra resource selector inside milling type edit/show forms', () => {
    const edit = readFileSync(resolve(root, 'src/pages/milling_types/edit.tsx'), 'utf8');
    const show = readFileSync(resolve(root, 'src/pages/milling_types/show.tsx'), 'utf8');

    expect(edit).toContain('title="Доп. ресурс"');
    expect(edit).toContain('MillingTypeExtraResourceSelector');
    expect(show).toContain('title="Доп. ресурс"');
    expect(show).toContain('MillingTypeExtraResourceSelector');
  });

  it('registers an independent extra resources menu route', () => {
    const app = readFileSync(resolve(root, 'src/App.tsx'), 'utf8');
    const labels = readFileSync(resolve(root, 'src/utils/tabLabels.ts'), 'utf8');
    const permissions = readFileSync(resolve(root, 'src/utils/navigationPermissions.ts'), 'utf8');

    expect(app).toContain('name: "extra_resources"');
    expect(app).toContain('list: "/extra-resources"');
    expect(labels).toContain("extra_resources: 'Доп. ресурсы'");
    expect(permissions).toContain("extra_resources: ['settings.view', 'settings.manage']");
  });
});
