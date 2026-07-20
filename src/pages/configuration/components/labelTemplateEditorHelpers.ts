import type { LabelFieldCatalogItem, LabelTemplateElement } from '../../../api/types/labelsApi.types';

export type CustomFieldType = LabelFieldCatalogItem['type'];
export type CustomFieldValueMode = 'constant' | 'source';

export interface CustomFieldSchemaRow {
  fieldId: string;
  label: string;
  type: CustomFieldType;
  valueMode: CustomFieldValueMode;
  sourceField: string | null;
  defaultValue: unknown;
  extra: Record<string, unknown>;
}

export interface AlignmentGuide {
  axis: 'vertical' | 'horizontal';
  positionMm: number;
  targetElementKey: string;
}

export function customFieldRowsFromSchema(schema: Record<string, unknown>): CustomFieldSchemaRow[] {
  return Object.entries(schema).map(([fieldId, rawEntry]) => {
    const entry = isRecord(rawEntry) ? rawEntry : {};
    const type = isCustomFieldType(entry.type) ? entry.type : 'string';
    const sourceField = typeof entry.sourceField === 'string' && entry.sourceField.trim()
      ? entry.sourceField.trim()
      : null;
    const hasDefaultValue = Object.prototype.hasOwnProperty.call(entry, 'defaultValue');
    const extra = Object.fromEntries(
      Object.entries(entry).filter(([key]) => !['label', 'type', 'sourceField', 'defaultValue'].includes(key)),
    );
    return {
      fieldId,
      label: typeof entry.label === 'string' ? entry.label : '',
      type,
      valueMode: sourceField ? 'source' : 'constant',
      sourceField,
      defaultValue: hasDefaultValue ? entry.defaultValue : '',
      extra,
    };
  });
}

export function customFieldRowsToSchema(rows: CustomFieldSchemaRow[]): Record<string, unknown> {
  return Object.fromEntries(rows.map((row) => {
    const entry: Record<string, unknown> = {
      ...row.extra,
      type: row.type,
      label: row.label.trim(),
    };
    if (row.valueMode === 'source' && row.sourceField) {
      entry.sourceField = row.sourceField;
    }
    if (row.valueMode === 'constant') {
      entry.defaultValue = normalizeConstantValue(row.defaultValue, row.type);
    }
    return [row.fieldId, entry];
  }));
}

export function resolveLatestStateUpdate<T>(
  current: T,
  update: T | ((currentValue: T) => T),
): T {
  return typeof update === 'function'
    ? (update as (currentValue: T) => T)(current)
    : update;
}

export function snapElementCenters({
  elements,
  movingElementKey,
  xMm,
  yMm,
  toleranceMm,
}: {
  elements: LabelTemplateElement[];
  movingElementKey: string;
  xMm: number;
  yMm: number;
  toleranceMm: number;
}): { xMm: number; yMm: number; guides: AlignmentGuide[] } {
  const moving = elements.find((element) => element.elementKey === movingElementKey);
  if (!moving || toleranceMm <= 0) return { xMm, yMm, guides: [] };

  const movingWidth = Math.max(0, Number(moving.widthMm ?? 0));
  const movingHeight = Math.max(0, Number(moving.heightMm ?? 0));
  const movingCenter = elementCenterAt(moving, xMm, yMm);

  let vertical: { distance: number; positionMm: number; targetElementKey: string } | null = null;
  let horizontal: { distance: number; positionMm: number; targetElementKey: string } | null = null;

  for (const target of elements) {
    if (target.elementKey === movingElementKey) continue;
    const targetCenter = elementCenterAt(
      target,
      Number(target.xMm ?? 0),
      Number(target.yMm ?? 0),
    );
    const xDistance = Math.abs(targetCenter.xMm - movingCenter.xMm);
    const yDistance = Math.abs(targetCenter.yMm - movingCenter.yMm);
    if (xDistance <= toleranceMm && (!vertical || xDistance < vertical.distance)) {
      vertical = { distance: xDistance, positionMm: targetCenter.xMm, targetElementKey: target.elementKey };
    }
    if (yDistance <= toleranceMm && (!horizontal || yDistance < horizontal.distance)) {
      horizontal = { distance: yDistance, positionMm: targetCenter.yMm, targetElementKey: target.elementKey };
    }
  }

  const guides: AlignmentGuide[] = [];
  let nextX = xMm;
  let nextY = yMm;
  if (vertical) {
    nextX += vertical.positionMm - movingCenter.xMm;
    guides.push({
      axis: 'vertical',
      positionMm: vertical.positionMm,
      targetElementKey: vertical.targetElementKey,
    });
  }
  if (horizontal) {
    nextY += horizontal.positionMm - movingCenter.yMm;
    guides.push({
      axis: 'horizontal',
      positionMm: horizontal.positionMm,
      targetElementKey: horizontal.targetElementKey,
    });
  }
  return { xMm: nextX, yMm: nextY, guides };
}

function elementCenterAt(
  element: LabelTemplateElement,
  xMm: number,
  yMm: number,
): { xMm: number; yMm: number } {
  const halfWidth = Math.max(0, Number(element.widthMm ?? 0)) / 2;
  const halfHeight = Math.max(0, Number(element.heightMm ?? 0)) / 2;
  const radians = Number(element.rotationDeg ?? 0) * Math.PI / 180;
  return {
    xMm: xMm + Math.cos(radians) * halfWidth - Math.sin(radians) * halfHeight,
    yMm: yMm + Math.sin(radians) * halfWidth + Math.cos(radians) * halfHeight,
  };
}

function normalizeConstantValue(value: unknown, type: CustomFieldType): unknown {
  if (type === 'number') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }
  if (type === 'boolean') return Boolean(value);
  return String(value ?? '');
}

function isCustomFieldType(value: unknown): value is CustomFieldType {
  return value === 'string' || value === 'number' || value === 'boolean' || value === 'date';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
