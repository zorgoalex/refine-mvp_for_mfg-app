export interface RawKeyValue {
  key: string;
  value: string;
}

export interface RawEdgeEntry {
  side: 1 | 2 | 3 | 4;
  fields: RawKeyValue[];
}

export interface RawFaceEntry {
  side: 1 | 2;
  fields: RawKeyValue[];
}

export interface HoleGeometry {
  x: number;
  y: number;
  z: number | null;
  diameter: number;
  depth: number | null;
  type: string | null;
  dirX: number;
  dirY: number;
  dirZ: number;
}

export interface NodeRawSections {
  edges: RawEdgeEntry[];
  faces: RawFaceEntry[];
  holes: RawKeyValue[][];
  /** Геометрия отверстий для схемы панели (только записи с валидными числами) */
  holesGeometry: HoleGeometry[];
  grooves: RawKeyValue[][];
  properties: RawKeyValue[];
  operations: RawKeyValue[][];
  scalars: RawKeyValue[];
}

const EDGE_KEYS = ['СписокКромок1', 'СписокКромок2', 'СписокКромок3', 'СписокКромок4'] as const;
const FACE_KEYS = ['ОблицовкаПласти1', 'ОблицовкаПласти2'] as const;
const SECTION_KEYS = new Set<string>([...EDGE_KEYS, ...FACE_KEYS, 'Отверстие', 'Отверстия', 'Свойство', 'СдельнаяОперация', 'СписокОпераций', 'СписокПазов', 'Паз']);

function toKeyValues(entry: unknown): RawKeyValue[] {
  if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
    return [];
  }

  return Object.entries(entry as Record<string, unknown>)
    .filter(([, value]) => value == null || ['string', 'number', 'boolean'].includes(typeof value))
    .map(([key, value]) => ({ key, value: value == null ? '' : String(value) }));
}

function toNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function entryList(container: unknown, itemKey: string): unknown[] {
  if (container == null || typeof container !== 'object' || Array.isArray(container)) {
    return [];
  }

  const items = (container as Record<string, unknown>)[itemKey];
  return Array.isArray(items) ? items : [];
}

export function parseNodeRaw(rawJson: Record<string, unknown>): NodeRawSections {
  const edges: RawEdgeEntry[] = [];
  EDGE_KEYS.forEach((key, index) => {
    for (const edge of entryList(rawJson[key], 'Кромка')) {
      edges.push({ side: (index + 1) as RawEdgeEntry['side'], fields: toKeyValues(edge) });
    }
  });

  const faces: RawFaceEntry[] = [];
  FACE_KEYS.forEach((key, index) => {
    for (const face of entryList(rawJson[key], 'Пласть')) {
      faces.push({ side: (index + 1) as RawFaceEntry['side'], fields: toKeyValues(face) });
    }
  });

  // Реальный Bazis-XML кладёт их в контейнеры <Отверстия> и <СписокОпераций>;
  // прямые массивы поддерживаем как fallback
  const holesSource = Array.isArray(rawJson['Отверстие'])
    ? (rawJson['Отверстие'] as unknown[])
    : entryList(rawJson['Отверстия'], 'Отверстие');
  const operationsSource = Array.isArray(rawJson['СдельнаяОперация'])
    ? (rawJson['СдельнаяОперация'] as unknown[])
    : entryList(rawJson['СписокОпераций'], 'СдельнаяОперация');
  const holes = holesSource.map(toKeyValues);
  const operations = operationsSource.map(toKeyValues);

  const groovesSource = Array.isArray(rawJson['Паз'])
    ? (rawJson['Паз'] as unknown[])
    : entryList(rawJson['СписокПазов'], 'Паз');
  const grooves = groovesSource.map(toKeyValues);

  const holesGeometry: HoleGeometry[] = [];
  for (const hole of holesSource) {
    if (hole == null || typeof hole !== 'object' || Array.isArray(hole)) continue;
    const record = hole as Record<string, unknown>;
    const x = toNumber(record['ПозицияX']);
    const y = toNumber(record['ПозицияY']);
    const diameter = toNumber(record['Диаметр']);
    if (x == null || y == null || diameter == null || diameter <= 0) continue;
    holesGeometry.push({
      x,
      y,
      z: toNumber(record['ПозицияZ']),
      diameter,
      depth: toNumber(record['Глубина']),
      type: typeof record['Тип'] === 'string' ? (record['Тип'] as string) : null,
      dirX: toNumber(record['НаправлениеX']) ?? 0,
      dirY: toNumber(record['НаправлениеY']) ?? 0,
      dirZ: toNumber(record['НаправлениеZ']) ?? 0,
    });
  }

  const properties: RawKeyValue[] = (Array.isArray(rawJson['Свойство']) ? rawJson['Свойство'] : [])
    .map((property) => {
      const fields = toKeyValues(property);
      const name = fields.find((field) => field.key === 'Наименование')?.value ?? '';
      const value = fields.find((field) => field.key === 'Значение')?.value ?? '';
      return { key: name, value };
    })
    .filter((property) => property.key !== '');

  const scalars = Object.entries(rawJson)
    .filter(([key, value]) => !SECTION_KEYS.has(key)
      && (value == null || ['string', 'number', 'boolean'].includes(typeof value)))
    .map(([key, value]) => ({ key, value: value == null ? '' : String(value) }));

  return { edges, faces, holes, holesGeometry, grooves, properties, operations, scalars };
}
