import { describe, expect, it } from 'vitest';
import { buildMaterialChipColors, MATERIAL_CHIP_PALETTE } from './workbenchMaterialColors';

const STAGE_MATERIALS = [
  'МДФ 10мм', 'не определён', 'Краска', 'Фанера', 'черновой МДФ 16мм', 'черновой МДФ 18мм', 'нд', 'МДФ 16мм',
  'МДФ 18мм', 'test 8', 'МДФ 8мм', 'ЛДСП 16мм - 2750*1830', 'Ванна 2800x1050', 'Ванна 2800x1100',
  'ХДФ 2800*2070 3мм черновой', 'МДФ 16мм', 'МДФ 19мм', 'ХДФ 2800*2070 4мм черновой',
];

describe('workbench material chip colours', () => {
  it('gives every material its own colour', () => {
    const colors = buildMaterialChipColors(STAGE_MATERIALS);
    const unique = new Set(STAGE_MATERIALS);
    expect(colors.size).toBe(unique.size);
    expect(new Set(colors.values()).size).toBe(unique.size);
  });

  it('ЛДСП with «1830» in its size no longer looks like МДФ 18мм', () => {
    const colors = buildMaterialChipColors(STAGE_MATERIALS);
    expect(colors.get('ЛДСП 16мм - 2750*1830')).toBe('#ce93d8');
    expect(colors.get('МДФ 18мм')).toBe('#ffe08a');
    expect(colors.get('МДФ 10мм')).toBe('#90caf9');
    expect(colors.get('черновой МДФ 18мм')).not.toBe(colors.get('МДФ 18мм'));
  });

  it('does not depend on the order of the names and stays distinct up to the palette size', () => {
    const forward = buildMaterialChipColors(STAGE_MATERIALS);
    const backward = buildMaterialChipColors([...STAGE_MATERIALS].reverse());
    expect([...backward.entries()].sort()).toEqual([...forward.entries()].sort());

    const many = Array.from({ length: MATERIAL_CHIP_PALETTE.length }, (_, index) => `Материал ${index}`);
    expect(new Set(buildMaterialChipColors(many).values()).size).toBe(MATERIAL_CHIP_PALETTE.length);
  });
});
