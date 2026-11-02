import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { roleReadsVisibilitySettings } from '../../utils/resourcePermissions';

const page = readFileSync(new URL('./index.tsx', import.meta.url), 'utf8');
const users = readFileSync(new URL('./components/UserScreenVisibility.tsx', import.meta.url), 'utf8');

describe('visibility rules for a role that never reads the setting (release review 2026-11-02)', () => {
  it('the 1C integration operator does not read app_settings; the ordinary roles do', () => {
    expect(roleReadsVisibilitySettings('onec_operator')).toBe(false);
    expect(roleReadsVisibilitySettings(undefined)).toBe(false);
    for (const role of ['superadmin', 'admin', 'top_manager', 'manager', 'operator', 'worker', 'packer', 'viewer']) {
      expect(roleReadsVisibilitySettings(role)).toBe(true);
    }
  });

  it('the editor marks such a role and its users as not applicable instead of storing rules that do nothing', () => {
    expect(page).toContain('disabled={visibilityLocked || !applies}');
    expect(page).toContain('· не применяется');
    expect(users).toContain('disabled={saving || !userSettingsApply}');
    expect(users).toContain('message={VISIBILITY_NOT_APPLICABLE}');
  });
});
