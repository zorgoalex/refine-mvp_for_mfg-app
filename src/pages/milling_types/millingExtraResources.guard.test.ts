import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../..');

describe('milling extra resources UI wiring', () => {
  it('renders extra resources inside milling type edit/show forms', () => {
    const edit = readFileSync(resolve(root, 'src/pages/milling_types/edit.tsx'), 'utf8');
    const show = readFileSync(resolve(root, 'src/pages/milling_types/show.tsx'), 'utf8');

    expect(edit).toContain('title="Доп. ресурсы"');
    expect(edit).toContain('MillingExtraResourcesEditor');
    expect(show).toContain('title="Доп. ресурсы"');
    expect(show).toContain('MillingExtraResourcesEditor');
  });

  it('registers a dedicated milling extra resources menu route', () => {
    const app = readFileSync(resolve(root, 'src/App.tsx'), 'utf8');
    const labels = readFileSync(resolve(root, 'src/utils/tabLabels.ts'), 'utf8');
    const permissions = readFileSync(resolve(root, 'src/utils/navigationPermissions.ts'), 'utf8');

    expect(app).toContain('name: "milling_type_extra_resources"');
    expect(app).toContain('list: "/milling-extra-resources"');
    expect(labels).toContain("milling_type_extra_resources: 'Доп. ресурсы фрезеровок'");
    expect(permissions).toContain("milling_type_extra_resources: ['settings.view', 'settings.manage']");
  });
});
