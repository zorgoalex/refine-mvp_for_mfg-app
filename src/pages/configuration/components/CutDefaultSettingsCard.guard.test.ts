import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('./CutDefaultSettingsCard.tsx', import.meta.url), 'utf8');

describe('CutDefaultSettingsCard', () => {
  it('renders an inline form (Slider + Switch + Radio/Segmented), not a JSON dump', () => {
    expect(src).toMatch(/Slider/);
    expect(src).toMatch(/Switch/);
    expect(src).toMatch(/Segmented|Radio\.Group/);
    expect(src).not.toMatch(/JSON\.stringify/);
  });

  it('every control carries a small-font description (extra) and a tooltip', () => {
    const extras = src.match(/extra=/g) ?? [];
    const tooltips = src.match(/tooltip=/g) ?? [];
    expect(extras.length).toBeGreaterThanOrEqual(12);
    expect(tooltips.length).toBeGreaterThanOrEqual(12);
    // trim inputs must carry descriptions too (no tooltip-only controls)
    expect(src).toMatch(/Обрезка левого края/);
    expect(src).toMatch(/Обрезка верхнего края/);
  });

  it('exposes the new quality + group-shift controls with their copy', () => {
    expect(src).toMatch(/Качество/);
    expect(src).toMatch(/Сжимать группы/);
    expect(src).toMatch(/Скорость против плотности/);
    expect(src).toMatch(/Подтягивать крайние группы/);
  });

  it('writes the default profile through the backend config API (no Hasura)', () => {
    expect(src).toMatch(/cutConfigApi\.(update|create)ParamProfile/);
    expect(src).not.toMatch(/dataProvider|gql`|mutation\s/);
  });

  it('gates editing on cut.manage (view-only otherwise)', () => {
    expect(src).toMatch(/canManage/);
    expect(src).toMatch(/disabled/);
  });

  it('vacuum_table option exists in the layout_mode control', () => {
    expect(src).toMatch(/vacuum_table/);
    expect(src).toMatch(/Вакуумный стол/);
  });

  it('vacuum-direction control is gated on form.layout_mode === vacuum_table (structural guard)', () => {
    // Must contain a conditional that gates the vacuum-direction element on vacuum_table
    expect(src).toMatch(/form\.layout_mode\s*===\s*['"]vacuum_table['"]/);
    // And the vacuum direction selector must be inside that conditional block
    const vacuumGateIdx = src.search(/form\.layout_mode\s*===\s*['"]vacuum_table['"]/);
    const vacuumControlIdx = src.search(/vacuum.*direction|direction.*vacuum|Направление|авто|вдоль|поперёк/i);
    expect(vacuumGateIdx).toBeGreaterThanOrEqual(0);
    expect(vacuumControlIdx).toBeGreaterThanOrEqual(0);
    // The conditional must appear before the vacuum control element
    expect(vacuumGateIdx).toBeLessThan(vacuumControlIdx);
  });
});
