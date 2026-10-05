import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/configuration/index.tsx'), 'utf8');
const users = readFileSync(resolve(process.cwd(), 'src/pages/configuration/components/UserScreenVisibility.tsx'), 'utf8');

describe('screen visibility tab writes', () => {
  it('both modes write through one serialized writer built on the latest value', () => {
    expect(page).toContain('createVisibilityWriter(savedMatrix');
    expect(page).toContain('await writer.apply(update)');
    expect(page).toContain('const built = buildInitialResourceVisibility(menuResources, roles, current);');
    expect(page).toContain('apply={applyVisibility}');
    expect(users).toContain('(current) => setUserVisibilityOverride(current, resourceName, selectedUserId, override)');
    expect(users).toContain('(current) => clearUserVisibilityOverrides(current, selectedUserId)');
    expect(users).not.toContain('saveSetting');
  });

  it('locks the mode switch, role checkboxes and user controls while saving or loading', () => {
    expect(page).toContain('const visibilityLocked = visibilitySaving || isSettingsLoading;');
    expect(page.match(/disabled=\{visibilityLocked\}/g)).toHaveLength(2);
    expect(page).toContain('saving={visibilityLocked}');
    expect(users).toContain('disabled={saving}');
    // Unlocks after success and after failure, from the writer's own counter.
    expect(page).toMatch(/finally \{\s*setLocalMatrix\(writer\.current\);\s*setVisibilitySaving\(writer\.pending > 0\);/);
  });

  it('finds users by server-side search, not only the first page', () => {
    expect(users).toContain("field: 'username', operator: 'contains'");
    expect(users).toContain('filterOption={false}');
    expect(users).toContain('onSearch={setSearch}');
  });
});
