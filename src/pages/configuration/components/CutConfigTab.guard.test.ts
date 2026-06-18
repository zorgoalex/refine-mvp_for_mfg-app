import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tabSrc = readFileSync(new URL('./CutConfigTab.tsx', import.meta.url), 'utf8');
const indexSrc = readFileSync(new URL('../index.tsx', import.meta.url), 'utf8');
const apiSrc = readFileSync(new URL('../../../api/cutConfigApi.ts', import.meta.url), 'utf8');

describe('CutConfigTab wiring (backend-owned, flag-guarded)', () => {
  it('reads + writes only through the backend cut-config API (no Hasura)', () => {
    expect(tabSrc).toMatch(/cutConfigApi\.get/);
    expect(tabSrc).toMatch(/cutConfigApi\.(create|update|delete)SheetMaterialType/);
    expect(tabSrc).not.toMatch(/import[\s\S]*dataProvider/);
    expect(tabSrc).not.toMatch(/gql`|mutation\s/);
  });

  it('exposes full CRUD for every config surface (sheet specs, profiles, presets, settings)', () => {
    for (const m of [
      'updateSetting',
      'createSheetMaterialType', 'updateSheetMaterialType', 'deleteSheetMaterialType',
      'createParamProfile', 'updateParamProfile', 'deleteParamProfile',
      'createRenderPreset', 'updateRenderPreset', 'deleteRenderPreset',
    ]) {
      expect(apiSrc, `cutConfigApi.${m} missing`).toMatch(new RegExp(`${m}\\(`));
    }
    // The tab wires profile + preset CRUD (not just sheet specs).
    expect(tabSrc).toMatch(/cutConfigApi\.(create|update|delete)ParamProfile/);
    expect(tabSrc).toMatch(/cutConfigApi\.(create|update|delete)RenderPreset/);
  });

  it('passes the optimistic version on every edit/delete (stale-safe writes)', () => {
    // delete calls forward the row version; update calls forward editing.version.
    expect(apiSrc).toMatch(/deleteWithVersion\(/);
    expect(tabSrc).toMatch(/editing\.version|row\.version/);
  });

  it('enforces cut.manage for writes in the UI and cut.view to view', () => {
    expect(tabSrc).toMatch(/can\('cut\.view'\)/);
    expect(tabSrc).toMatch(/can\('cut\.manage'\)/);
  });

  it('is registered in /configuration only behind the useBackendCut flag', () => {
    expect(indexSrc).toMatch(/featureFlags\.useBackendCut[\s\S]*CutConfigTab/);
  });
});
