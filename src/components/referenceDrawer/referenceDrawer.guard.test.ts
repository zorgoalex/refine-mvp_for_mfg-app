import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const registry = readFileSync('src/components/referenceDrawer/referenceDrawerForms.ts', 'utf8');
const resources = [...registry.matchAll(/^  ([a-z_]+): \{ edit: page\(\(\) => import\('\.\.\/\.\.\/pages\/([a-z_-]+)\/edit'\)/gm)]
  .map(([, resource, dir]) => ({ resource, dir }));

describe('NewLine reference side panel', () => {
  it('knows the forms of the reference books (and not backend-owned, sub-form or special screens)', () => {
    expect(resources.length).toBe(17);
    const names = resources.map((item) => item.resource);
    for (const excluded of ['users', 'sheet_material_types', 'clients', 'orders_view', 'payments', 'order_workshops', 'employees', 'films', 'suppliers', 'vendors']) {
      expect(names).not.toContain(excluded);
    }
  });

  it.each(resources)('$resource: the row edit opens the panel, the form takes the record from it', ({ dir }) => {
    const list = readFileSync(`src/pages/${dir}/list.tsx`, 'utf8');
    expect(list).toContain('<LocalizedList');
    expect(list).toContain('<ReferenceEditButton');
    expect(list).not.toMatch(/<EditButton\b/);
    for (const [file, shell] of [['edit', 'ReferenceEdit'], ['create', 'ReferenceCreate']] as const) {
      const path = `src/pages/${dir}/${file}.tsx`;
      expect(existsSync(path)).toBe(true);
      const form = readFileSync(path, 'utf8');
      expect(form).toContain(`<${shell}`);
      expect(form).not.toMatch(/<(Edit|Create)[\s>]/);
      expect(form).toMatch(/useReferenceForm|useFormWithHighlight/);
      expect(form).not.toMatch(/(?<![.\w])useForm\s*[<(]/); // refine useForm напрямую не видит панель
    }
  });

  it('keeps refine access control on both buttons and only opens the panel in NewLine reference lists', () => {
    const button = readFileSync('src/components/referenceDrawer/ReferenceEditButton.tsx', 'utf8');
    expect(button).toContain("if (!opener || !opener.canOpen('edit') || props.recordItemId == null) return <EditButton {...props} />;");
    expect(button).toMatch(/<EditButton\s+\{\.\.\.props\}\s+onClick=/);
    const list = readFileSync('src/components/LocalizedList.tsx', 'utf8');
    expect(list).toContain('<ReferenceDrawerHost resource={resource?.name} title={props.title ?? resource?.meta?.label} enabled={!!group}>');
    expect(list).toContain('const onClick = drawer?.canOpen("create")');
    const host = readFileSync('src/components/referenceDrawer/ReferenceDrawerHost.tsx', 'utf8');
    expect(host).toContain('const forms = enabled && resource ? REFERENCE_DRAWER_FORMS[resource] : undefined;');
    expect(host).toContain('onSaved: close');
  });

  it('the form hooks use the panel record and close it instead of navigating', () => {
    const hook = readFileSync('src/hooks/useFormWithHighlight.ts', 'utf8');
    expect(hook).toContain('const drawer = useReferenceDrawerForm();');
    expect(hook).toMatch(/if \(drawer\) \{\s*drawer\.onSaved\(\);\s*return;\s*\}/);
    const own = readFileSync('src/components/referenceDrawer/useReferenceForm.ts', 'utf8');
    expect(own).toContain("id: drawer.action === 'edit' ? drawer.id : undefined,");
    expect(own).toContain('redirect: false,');
    expect(own).toContain('drawer.onSaved();');
  });
});
