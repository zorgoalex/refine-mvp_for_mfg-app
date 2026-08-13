export interface SvgCutUploadFileNameHints {
  machineName: string | null;
  orderNames: string[];
  materialName: string | null;
}

const SVG_EXTENSION_RE = /\.svg$/i;
const ORDER_NUMBER_RE = /\d{3,8}/g;
const MATERIAL_THICKNESS_RE = /(\d{1,2})\s*(?:m{2}|мм)/i;

export function parseSvgCutUploadFileNameHints(fileName: string): SvgCutUploadFileNameHints {
  const baseName = fileName.split(/[\\/]/).pop()?.replace(SVG_EXTENSION_RE, '').trim() ?? '';
  if (!baseName) {
    return { machineName: null, orderNames: [], materialName: null };
  }

  const underscoreIndex = baseName.indexOf('_');
  const machineName = underscoreIndex > 0 ? baseName.slice(0, underscoreIndex).trim() || null : null;
  const rawOrderSegment = underscoreIndex >= 0 ? baseName.slice(underscoreIndex + 1) : baseName;
  const { orderSegment, materialName } = splitOrderSegmentAndMaterial(rawOrderSegment);
  const orderNames = uniquePreservingOrder(
    orderSegment
      .split('+')
      .flatMap((part) => part.match(ORDER_NUMBER_RE) ?? []),
  );

  return { machineName, orderNames, materialName };
}

function splitOrderSegmentAndMaterial(rawOrderSegment: string): { orderSegment: string; materialName: string | null } {
  const hyphenIndex = rawOrderSegment.lastIndexOf('-');
  if (hyphenIndex < 0) {
    return { orderSegment: rawOrderSegment, materialName: null };
  }
  const suffix = rawOrderSegment.slice(hyphenIndex + 1).trim();
  const materialName = normalizeMaterialSuffix(suffix);
  if (!materialName) {
    return { orderSegment: rawOrderSegment, materialName: null };
  }
  return { orderSegment: rawOrderSegment.slice(0, hyphenIndex), materialName };
}

function normalizeMaterialSuffix(value: string): string | null {
  const normalized = value.trim().toUpperCase().replace(/\s+/g, '');
  if (!normalized) return null;
  const thickness = MATERIAL_THICKNESS_RE.exec(normalized)?.[1] ?? null;
  const thicknessSuffix = thickness ? ` ${Number(thickness)}мм` : '';
  if (/(HDF|ХДФ)/i.test(normalized)) return `ХДФ${thicknessSuffix}`;
  if (/(MDF|МДФ)/i.test(normalized)) return `МДФ${thicknessSuffix || ' 16мм'}`;
  if (/(LDSP|ЛДСП)/i.test(normalized)) return `ЛДСП${thicknessSuffix}`;
  if (/(DSP|ДСП)/i.test(normalized)) return `ДСП${thicknessSuffix}`;
  if (/(DVP|ДВП)/i.test(normalized)) return `ДВП${thicknessSuffix}`;
  if (/(OSB|ОСП)/i.test(normalized)) return `OSB${thicknessSuffix}`;
  if (/(FANERA|ФАНЕРА|PLYWOOD)/i.test(normalized)) return `Фанера${thicknessSuffix}`;
  if (/(ACRYLIC|АКРИЛ)/i.test(normalized)) return `Акрил${thicknessSuffix}`;
  if (/(PLASTIC|ПЛАСТИК)/i.test(normalized)) return `Пластик${thicknessSuffix}`;
  if (thickness) return `МДФ ${Number(thickness)}мм`;
  return null;
}

function uniquePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
