// «NewLine» calendar: every material chip has its own colour.
// The shared `getMaterialColor` looks for digits anywhere in the name, so «ЛДСП 16мм - 2750*1830»
// (it contains «18») got the colour of «МДФ 18мм». Here the colour is chosen per material name and
// two different materials never share one (while there are no more materials than colours).
import { createContext, useContext } from 'react';

/** Distinct, readable chip backgrounds (dark text on top). */
export const MATERIAL_CHIP_PALETTE = [
  '#ffe08a', // жёлтый
  '#90caf9', // голубой
  '#ce93d8', // фиолетовый
  '#a5d6a7', // зелёный
  '#ffab91', // коралловый
  '#bcaaa4', // коричневый
  '#80cbc4', // бирюзовый
  '#f48fb1', // розовый
  '#ffcc80', // оранжевый
  '#b0bec5', // серо-синий
  '#c5e1a5', // салатовый
  '#9fa8da', // индиго
  '#fff59d', // лимонный
  '#ef9a9a', // красный
  '#80deea', // циан
  '#e6ee9c', // лайм
  '#b39ddb', // сиреневый
  '#ffe0b2', // персиковый
  '#cfd8dc', // светло-серый
  '#d7ccc8', // бежевый
] as const;

const thicknessOf = (name: string): number | null => {
  const match = name.match(/(\d+(?:[.,]\d+)?)\s*мм/i);
  return match ? Number(match[1].replace(',', '.')) : null;
};

/** The colour a material would like to have (familiar ones keep their usual colour). */
function preferredColor(name: string): string | null {
  const lower = name.toLocaleLowerCase('ru-RU');
  const thickness = thicknessOf(name);
  if (lower.includes('лдсп')) return '#ce93d8';
  if (lower.includes('фанера')) return '#bcaaa4';
  if (lower.includes('хдф')) return thickness === 4 ? '#80deea' : '#80cbc4';
  if (lower.includes('чернов') && lower.includes('мдф')) return thickness === 18 ? '#ffcc80' : '#ffab91';
  if (lower.includes('мдф')) {
    if (thickness === 18) return '#ffe08a';
    if (thickness === 10) return '#90caf9';
    if (thickness === 8) return '#a5d6a7';
    if (thickness === 19) return '#f48fb1';
    if (thickness === 16) return '#fff59d';
  }
  return null;
}

const hashOf = (value: string): number => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  return hash;
};

/**
 * One colour per material name. Deterministic for a given set of names: names are taken in
 * alphabetical order, each gets its preferred colour or, when that one is taken, the next free one.
 */
export function buildMaterialChipColors(names: Iterable<string>): Map<string, string> {
  const unique = [...new Set([...names].map((name) => name.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'ru'));
  const colors = new Map<string, string>();
  const taken = new Set<string>();
  const palette: readonly string[] = MATERIAL_CHIP_PALETTE;
  // materials with a familiar colour choose first, so an unknown name never takes it from them
  const ordered = [...unique.filter((name) => preferredColor(name)), ...unique.filter((name) => !preferredColor(name))];
  for (const name of ordered) {
    const preferred = preferredColor(name);
    let color = preferred && !taken.has(preferred) ? preferred : null;
    if (!color) {
      const start = hashOf(name) % palette.length;
      for (let step = 0; step < palette.length && !color; step += 1) {
        const candidate = palette[(start + step) % palette.length];
        if (!taken.has(candidate)) color = candidate;
      }
    }
    // more materials than colours: the palette is reused from the hashed position
    color ??= palette[hashOf(name) % palette.length];
    taken.add(color);
    colors.set(name, color);
  }
  return colors;
}

export const WorkbenchMaterialColorsContext = createContext<ReadonlyMap<string, string>>(new Map());

/** Chip colour of a material in the «NewLine» calendar. */
export function useWorkbenchMaterialColor(): (name: string) => string {
  const colors = useContext(WorkbenchMaterialColorsContext);
  return (name: string) => colors.get(name.trim()) ?? buildMaterialChipColors([name]).get(name.trim()) ?? '#cfd8dc';
}
