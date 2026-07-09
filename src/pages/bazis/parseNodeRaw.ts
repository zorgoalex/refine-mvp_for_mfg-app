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

export interface NodeRawSections {
  edges: RawEdgeEntry[];
  faces: RawFaceEntry[];
  holes: RawKeyValue[][];
  properties: RawKeyValue[];
  operations: RawKeyValue[][];
  scalars: RawKeyValue[];
}

const EDGE_KEYS = ['СписокКромок1', 'СписокКромок2', 'СписокКромок3', 'СписокКромок4'] as const;
const FACE_KEYS = ['ОблицовкаПласти1', 'ОблицовкаПласти2'] as const;
const SECTION_KEYS = new Set<string>([...EDGE_KEYS, ...FACE_KEYS, 'Отверстие', 'Отверстия', 'Свойство', 'СдельнаяОперация', 'СписокОпераций']);

function toKeyValues(entry: unknown): RawKeyValue[] {
  if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
    return [];
  }

  return Object.entries(entry as Record<string, unknown>)
    .filter(([, value]) => value == null || ['string', 'number', 'boolean'].includes(typeof value))
    .map(([key, value]) => ({ key, value: value == null ? '' : String(value) }));
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

  return { edges, faces, holes, properties, operations, scalars };
}
