import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tabSrc = readFileSync(new URL('./CutConfigTab.tsx', import.meta.url), 'utf8');
const indexSrc = readFileSync(new URL('../index.tsx', import.meta.url), 'utf8');
const apiSrc = readFileSync(new URL('../../../api/cutConfigApi.ts', import.meta.url), 'utf8');

describe('CutConfigTab wiring (backend-owned, flag-guarded)', () => {
  it('reads + writes only through the backend cut-config API (no Hasura)', () => {
    expect(tabSrc).toMatch(/cutConfigApi\.get/);
    expect(tabSrc).not.toMatch(/import[\s\S]*dataProvider/);
    expect(tabSrc).not.toMatch(/gql`|mutation\s/);
  });

  it('no sheet-material card in cut config', () => {
    expect(tabSrc).not.toMatch(/sheet_material_types/i);
    expect(tabSrc).not.toMatch(/SheetModal/);
  });

  it('keeps eligibility + profiles + presets', () => {
    expect(tabSrc).toMatch(/Профили параметров/);
    expect(tabSrc).toMatch(/Пресеты рендера/);
  });

  it('eligibility statuses use a multiselect from the production-statuses reference (no free text)', () => {
    expect(tabSrc).toMatch(/resource: 'production_statuses'/);
    expect(tabSrc).toMatch(/mode="multiple"/);
    // free-text CSV entry for eligibility codes is gone
    expect(tabSrc).not.toMatch(/parseCodesCsv/);
  });

  it('exposes CRUD for param-profiles and render-presets (not sheet specs)', () => {
    for (const m of [
      'createParamProfile', 'updateParamProfile', 'deleteParamProfile',
      'createRenderPreset', 'updateRenderPreset', 'deleteRenderPreset',
    ]) {
      expect(apiSrc, `cutConfigApi.${m} missing`).toMatch(new RegExp(`${m}\\(`));
    }
    // Sheet CRUD should no longer be in cutConfigApi
    expect(apiSrc).not.toMatch(/createSheetMaterialType/);
    expect(apiSrc).not.toMatch(/updateSheetMaterialType/);
    expect(apiSrc).not.toMatch(/deleteSheetMaterialType/);
    expect(tabSrc).toMatch(/cutConfigApi\.(create|update|delete)ParamProfile/);
    expect(tabSrc).toMatch(/cutConfigApi\.(create|update|delete)RenderPreset/);
  });

  it('passes the optimistic version on every edit/delete (stale-safe writes)', () => {
    expect(apiSrc).toMatch(/deleteWithVersion\(/);
  });

  it('enforces cut.manage for writes in the UI and cut.view to view', () => {
    expect(tabSrc).toMatch(/can\('cut\.view'\)/);
    expect(tabSrc).toMatch(/can\('cut\.manage'\)/);
  });

  it('is registered in /configuration only behind the useBackendCut flag', () => {
    expect(indexSrc).toMatch(/featureFlags\.useBackendCut[\s\S]*CutConfigTab/);
  });

  it('mounts the inline default-settings card and drops the JSON params dump', () => {
    expect(tabSrc).toMatch(/CutDefaultSettingsCard/);
    expect(tabSrc).toMatch(/summarizeParams\(/);
    expect(tabSrc).not.toMatch(/JSON\.stringify\(r\.params\)/);
  });

  it('ProfileModal exposes the same quality + group-shift controls as the default-settings card (parity)', () => {
    // «Качество» Segmented bound to params.quality
    expect(tabSrc).toMatch(/label="Качество"/);
    expect(tabSrc).toMatch(/setField\('quality',/);
    // «Сжимать группы деталей» Switch bound to params.groupShift
    expect(tabSrc).toMatch(/Сжимать группы деталей/);
    expect(tabSrc).toMatch(/setField\('groupShift',/);
    // these were previously absent from the created-profile form (locked to balanced + no group_shift)
    expect(tabSrc).toMatch(/<Segmented/);
  });

  it('vacuum_table option exists in the ProfileModal layout_mode control', () => {
    expect(tabSrc).toMatch(/vacuum_table/);
    expect(tabSrc).toMatch(/Вакуумный стол/);
  });

  it('vacuum-direction control is gated on params.layout_mode === vacuum_table in ProfileModal (structural guard)', () => {
    // The gate and the distinctive control token must appear together in one conditional block.
    // setField('vacuum', { direction: exists ONLY on the actual Radio.Group control, not on VACUUM_DIRECTION_META constants.
    // The regex matches: the gate `params.layout_mode === 'vacuum_table' && (` then zero or more characters
    // that do NOT contain `)}` (which would close the && expression), then the control's unique token.
    // If the gate were removed, the first part of the regex would not match, so the whole regex would fail.
    expect(tabSrc).toMatch(
      /params\.layout_mode\s*===\s*['"]vacuum_table['"]\s*&&\s*\((?:(?!\)\}).)*setField\('vacuum',\s*\{/s,
    );
  });
});
