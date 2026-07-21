import type {
  LabelConditionBranch,
  LabelEditorMetadataV1,
  LabelFieldCatalogItem,
  LabelIfElseCondition,
  LabelTemplateElement,
  LabelTypographyV1,
} from '../../../api/types/labelsApi.types';

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

export interface LabelFieldSourceDescription {
  entity: string;
  databasePath: string;
}

export interface HeightMatchSuggestion {
  targetElementKey: string;
  heightMm: number;
}

export interface LabelTransformSnapshot {
  elementKey: string;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  rotationDeg: number;
}

export interface LabelGestureCommitToken {
  id: number;
  committed: boolean;
}

export interface LabelDragGestureState extends LabelGestureCommitToken {
  ownerStart: { x: number; y: number };
  starts: ReadonlyMap<string, { x: number; y: number }>;
}

interface LabelTransformNode {
  x(): number;
  y(): number;
  rotation(): number;
  scaleX(): number;
  scaleX(value: number): unknown;
  scaleY(): number;
  scaleY(value: number): unknown;
  width(): number;
  width(value: number): unknown;
  height(): number;
  height(value: number): unknown;
}

const DEFAULT_TYPOGRAPHY: LabelTypographyV1 = {
  version: 1,
  fontSizePt: 10,
  fontWeight: 'normal',
  italic: false,
};

const DEFAULT_EDITOR_META: LabelEditorMetadataV1 = {
  version: 1,
  boundsMode: 'auto',
};

export function readLabelTypography(element: LabelTemplateElement): LabelTypographyV1 {
  const style = isRecord(element.style) ? element.style : {};
  const typography = isRecord(style.typography) ? style.typography : {};
  const legacySize = Number(style.fontSize ?? DEFAULT_TYPOGRAPHY.fontSizePt);
  return {
    version: 1,
    fontSizePt: Number.isFinite(Number(typography.fontSizePt))
      ? Math.min(96, Math.max(4, Number(typography.fontSizePt)))
      : Math.min(96, Math.max(4, legacySize)),
    fontWeight: typography.fontWeight === 'bold' || style.fontWeight === 'bold' ? 'bold' : 'normal',
    italic: typography.italic === true || style.fontItalic === true,
  };
}

export function withLabelTypography(
  element: LabelTemplateElement,
  patch: Partial<Omit<LabelTypographyV1, 'version'>>,
): LabelTemplateElement {
  const style = isRecord(element.style) ? element.style : {};
  const typography = { ...readLabelTypography(element), ...patch, version: 1 as const };
  return { ...element, style: { ...style, typography } };
}

export function readLabelEditorMeta(element: LabelTemplateElement): LabelEditorMetadataV1 & { groupId: string | null } {
  const style = isRecord(element.style) ? element.style : {};
  const editor = isRecord(style.editor) ? style.editor : {};
  return {
    version: 1,
    boundsMode: editor.boundsMode === 'manual' ? 'manual' : 'auto',
    groupId: typeof editor.groupId === 'string' && editor.groupId.trim() ? editor.groupId.trim() : null,
  };
}

export function withLabelEditorMeta(
  element: LabelTemplateElement,
  patch: { boundsMode?: 'auto' | 'manual'; groupId?: string | null },
): LabelTemplateElement {
  const style = isRecord(element.style) ? element.style : {};
  const current = readLabelEditorMeta(element);
  const groupId = patch.groupId === undefined ? current.groupId : patch.groupId?.trim() || null;
  const editor: Record<string, unknown> = {
    version: 1,
    boundsMode: patch.boundsMode ?? current.boundsMode ?? DEFAULT_EDITOR_META.boundsMode,
  };
  if (groupId) editor.groupId = groupId;
  return { ...element, style: { ...style, editor } };
}

export function readLabelIfElseCondition(condition: Record<string, unknown> | undefined): LabelIfElseCondition | null {
  if (!isRecord(condition)
    || !hasExactKeys(condition, ['type', 'version', 'when', 'then', 'else'])
    || condition.type !== 'if_else'
    || condition.version !== 1) return null;
  const when = condition.when;
  const thenBranch = parseLabelConditionBranch(condition.then);
  const elseBranch = parseLabelConditionBranch(condition.else);
  if (!isRecord(when) || !thenBranch || !elseBranch) return null;
  const op = when.op;
  if (typeof when.field !== 'string' || !when.field.trim() || when.field.length > 200) return null;
  if (op === 'exists' || op === 'not_empty') {
    if (!hasExactKeys(when, ['field', 'op'])) return null;
  } else if (op === 'equals' || op === 'not_equals') {
    if (!hasExactKeys(when, ['field', 'op', 'value']) || !isLabelConditionScalar(when.value)) return null;
    if (typeof when.value === 'string' && when.value.length > 1000) return null;
  } else {
    return null;
  }
  return {
    type: 'if_else',
    version: 1,
    when: {
      field: when.field.trim(),
      op: op as LabelIfElseCondition['when']['op'],
      ...(Object.prototype.hasOwnProperty.call(when, 'value') ? { value: when.value as string | number | boolean | null } : {}),
    },
    then: thenBranch,
    else: elseBranch,
  };
}

export function labelConditionFieldIds(condition: Record<string, unknown> | undefined): string[] {
  const advanced = readLabelIfElseCondition(condition);
  if (advanced) {
    const ids = [advanced.when.field];
    if (advanced.then.type === 'field') ids.push(advanced.then.field);
    if (advanced.else.type === 'field') ids.push(advanced.else.field);
    return [...new Set(ids)];
  }
  return typeof condition?.field === 'string' && condition.field.trim()
    ? [condition.field.trim()]
    : [];
}

export function resolveLabelElementPreviewText(
  element: LabelTemplateElement,
  fieldValues: Map<string, string>,
  fieldLabels: Map<string, string>,
): string {
  const current = element.sourceField
    ? fieldValues.get(element.sourceField) ?? fieldLabels.get(element.sourceField) ?? element.sourceField
    : element.staticText ?? '';
  const condition = readLabelIfElseCondition(element.condition);
  if (!condition) return current;
  const branch = labelConditionPasses(condition, fieldValues) ? condition.then : condition.else;
  return resolvePreviewBranch(branch, current, fieldValues, fieldLabels);
}

export function findSameRowHeightSuggestion({
  elements,
  movingElementKey,
  proposedHeightMm,
  rowToleranceMm,
  heightToleranceMm,
}: {
  elements: LabelTemplateElement[];
  movingElementKey: string;
  proposedHeightMm: number;
  rowToleranceMm: number;
  heightToleranceMm: number;
}): HeightMatchSuggestion | null {
  const moving = elements.find((element) => element.elementKey === movingElementKey);
  if (!moving || moving.kind !== 'text') return null;
  const proposedCenterY = Number(moving.yMm ?? 0) + proposedHeightMm / 2;
  let best: (HeightMatchSuggestion & { distance: number }) | null = null;
  for (const target of elements) {
    if (target.elementKey === movingElementKey || target.kind !== 'text') continue;
    const heightMm = Number(target.heightMm ?? 0);
    const targetCenterY = Number(target.yMm ?? 0) + heightMm / 2;
    const rowDistance = Math.abs(targetCenterY - proposedCenterY);
    const heightDistance = Math.abs(heightMm - proposedHeightMm);
    if (rowDistance > rowToleranceMm || heightDistance > heightToleranceMm) continue;
    const distance = rowDistance + heightDistance;
    if (!best || distance < best.distance) best = { targetElementKey: target.elementKey, heightMm, distance };
  }
  return best ? { targetElementKey: best.targetElementKey, heightMm: best.heightMm } : null;
}

export function selectLabelElements(
  elements: LabelTemplateElement[],
  currentKeys: string[],
  elementKey: string,
  additive: boolean,
): string[] {
  const unit = selectionUnit(elements, elementKey);
  if (!additive) return unit;
  const selected = new Set(currentKeys);
  const remove = unit.every((key) => selected.has(key));
  for (const key of unit) {
    if (remove) selected.delete(key);
    else selected.add(key);
  }
  return elements.map((element) => element.elementKey).filter((key) => selected.has(key));
}

export function groupLabelElements(
  elements: LabelTemplateElement[],
  selectedKeys: string[],
  groupId: string,
): LabelTemplateElement[] {
  const expanded = expandSelectionKeys(elements, selectedKeys);
  return elements.map((element) => expanded.has(element.elementKey)
    ? withLabelEditorMeta(element, { groupId })
    : element);
}

export function ungroupLabelElements(
  elements: LabelTemplateElement[],
  selectedKeys: string[],
): LabelTemplateElement[] {
  const expanded = expandSelectionKeys(elements, selectedKeys);
  return elements.map((element) => expanded.has(element.elementKey)
    ? withLabelEditorMeta(element, { groupId: null })
    : element);
}

export function centerLabelSelection(
  elements: LabelTemplateElement[],
  selectedKeys: string[],
  canvasWidthMm: number,
  canvasHeightMm: number,
  axis: 'horizontal' | 'vertical',
): LabelTemplateElement[] {
  const selected = elements.filter((element) => selectedKeys.includes(element.elementKey));
  if (selected.length === 0) return elements;
  const bounds = unionBounds(selected.map(elementAabb));
  const delta = axis === 'horizontal'
    ? { x: canvasWidthMm / 2 - (bounds.minX + bounds.maxX) / 2, y: 0 }
    : { x: 0, y: canvasHeightMm / 2 - (bounds.minY + bounds.maxY) / 2 };
  const selectedSet = new Set(selectedKeys);
  return elements.map((element) => selectedSet.has(element.elementKey)
    ? { ...element, xMm: roundGeometry(Number(element.xMm ?? 0) + delta.x), yMm: roundGeometry(Number(element.yMm ?? 0) + delta.y) }
    : element);
}

export function readLabelTransformedNodes(
  elements: LabelTemplateElement[],
  nodes: ReadonlyMap<string, LabelTransformNode>,
): LabelTransformSnapshot[] {
  return elements.flatMap((element) => {
    const node = nodes.get(element.elementKey);
    if (!node) return [];
    const scaleX = Math.abs(node.scaleX());
    const scaleY = Math.abs(node.scaleY());
    const widthMm = element.kind === 'line'
      ? Number(element.widthMm ?? 0) * scaleX
      : node.width() * scaleX;
    const heightMm = element.kind === 'line'
      ? Number(element.heightMm ?? 0) * scaleY
      : node.height() * scaleY;
    return [{
      elementKey: element.elementKey,
      xMm: node.x(),
      yMm: node.y(),
      widthMm: Math.max(0.1, widthMm),
      heightMm: Math.max(element.kind === 'line' ? 0 : 0.1, heightMm),
      rotationDeg: node.rotation(),
    }];
  });
}

export function readAndNormalizeLabelTransformedNodes(
  elements: LabelTemplateElement[],
  nodes: ReadonlyMap<string, LabelTransformNode>,
): LabelTransformSnapshot[] {
  // Read every selected node first. Resetting one Transformer child can update
  // the shared Transformer box, so no node may be normalized before all raw
  // geometries have been captured.
  const snapshots = readLabelTransformedNodes(elements, nodes);
  const elementsByKey = new Map(elements.map((element) => [element.elementKey, element]));
  for (const snapshot of snapshots) {
    const element = elementsByKey.get(snapshot.elementKey);
    const node = nodes.get(snapshot.elementKey);
    if (!element || !node) continue;
    node.scaleX(1);
    node.scaleY(1);
    if (element.kind !== 'line') {
      node.width(snapshot.widthMm);
      node.height(snapshot.heightMm);
    }
  }
  return snapshots;
}

export function claimLabelGestureCommit(token: LabelGestureCommitToken | null): boolean {
  if (!token || token.committed) return false;
  token.committed = true;
  return true;
}

export function moveLabelDragGesture(
  gesture: LabelDragGestureState,
  ownerPosition: { x: number; y: number },
  selectionBounds: { minX: number; minY: number; maxX: number; maxY: number },
  canvas: { width: number; height: number },
): Array<{ elementKey: string; x: number; y: number }> {
  if (gesture.committed) return [];
  const deltaX = clampNumber(
    ownerPosition.x - gesture.ownerStart.x,
    -selectionBounds.minX,
    canvas.width - selectionBounds.maxX,
  );
  const deltaY = clampNumber(
    ownerPosition.y - gesture.ownerStart.y,
    -selectionBounds.minY,
    canvas.height - selectionBounds.maxY,
  );
  return Array.from(gesture.starts, ([elementKey, start]) => ({
    elementKey,
    x: start.x + deltaX,
    y: start.y + deltaY,
  }));
}

export function normalizeLabelMultiSelectionTransform(input: {
  elements: LabelTemplateElement[];
  snapshots: LabelTransformSnapshot[];
  canvasWidthMm: number;
  canvasHeightMm: number;
  snapToGrid: boolean;
  rotationStep: number;
}): LabelTransformSnapshot[] {
  if (input.snapshots.length < 2) return input.snapshots;
  const originals = new Map(input.elements.map((element) => [element.elementKey, element]));
  const raw = input.snapshots.flatMap((snapshot) => {
    const original = originals.get(snapshot.elementKey);
    if (!original) return [];
    const size = original.kind === 'qr' ? Math.max(snapshot.widthMm, snapshot.heightMm) : null;
    return [{
      ...snapshot,
      widthMm: size ?? snapshot.widthMm,
      heightMm: size ?? snapshot.heightMm,
    }];
  });
  if (raw.length < 2) return raw;

  const firstOriginal = originals.get(raw[0].elementKey);
  if (!firstOriginal) return raw;
  const rawRotationDelta = raw[0].rotationDeg - Number(firstOriginal.rotationDeg ?? 0);
  const snappedRotationDelta = Math.round(rawRotationDelta / input.rotationStep) * input.rotationStep;
  const correctionRadians = (snappedRotationDelta - rawRotationDelta) * Math.PI / 180;
  const rawElements = raw.map((snapshot) => ({ ...originals.get(snapshot.elementKey)!, ...snapshot }));
  const rawBounds = unionBounds(rawElements.map(elementAabb));
  const pivot = {
    x: (rawBounds.minX + rawBounds.maxX) / 2,
    y: (rawBounds.minY + rawBounds.maxY) / 2,
  };
  const cos = Math.cos(correctionRadians);
  const sin = Math.sin(correctionRadians);
  const corrected = raw.map((snapshot) => {
    const original = originals.get(snapshot.elementKey)!;
    const dx = snapshot.xMm - pivot.x;
    const dy = snapshot.yMm - pivot.y;
    return {
      ...snapshot,
      xMm: pivot.x + dx * cos - dy * sin,
      yMm: pivot.y + dx * sin + dy * cos,
      rotationDeg: Number(original.rotationDeg ?? 0) + snappedRotationDelta,
    };
  });
  const correctedElements = corrected.map((snapshot) => ({ ...originals.get(snapshot.elementKey)!, ...snapshot }));
  const bounds = unionBounds(correctedElements.map(elementAabb));
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const snappedMinX = input.snapToGrid ? Math.round(bounds.minX) : bounds.minX;
  const snappedMinY = input.snapToGrid ? Math.round(bounds.minY) : bounds.minY;
  const finalMinX = width <= input.canvasWidthMm
    ? clampNumber(snappedMinX, 0, input.canvasWidthMm - width)
    : 0;
  const finalMinY = height <= input.canvasHeightMm
    ? clampNumber(snappedMinY, 0, input.canvasHeightMm - height)
    : 0;
  const translationX = finalMinX - bounds.minX;
  const translationY = finalMinY - bounds.minY;
  return corrected.map((snapshot) => ({
    ...snapshot,
    xMm: snapshot.xMm + translationX,
    yMm: snapshot.yMm + translationY,
  }));
}

export function describeLabelFieldSource(
  field: LabelFieldCatalogItem,
): LabelFieldSourceDescription {
  if (field.category === 'Кастомные' || field.id.startsWith('custom.')) {
    return {
      entity: 'Пользовательское поле шаблона',
      databasePath: 'label_templates.custom_field_schema (источник/константа) · order_label_detail_data.custom_fields (переопределение)',
    };
  }
  if (field.source === 'detail') {
    return {
      entity: 'Деталь заказа',
      databasePath: field.sourceColumn
        ? `order_details_view.${field.sourceColumn}`
        : 'order_details_view',
    };
  }
  if (field.source === 'order') {
    return {
      entity: 'Заказ',
      databasePath: field.sourceColumn
        ? `orders_view.${field.sourceColumn}`
        : 'orders_view',
    };
  }
  if (field.source === 'bazis') {
    return {
      entity: 'Данные Базис детали',
      databasePath: field.sourceColumn
        ? `order_details_view.basis_data / order_label_detail_data.bazis_fields · ${field.sourceColumn}`
        : 'order_details_view.basis_data / order_label_detail_data.bazis_fields',
    };
  }
  return {
    entity: 'Вычисляемое поле',
    databasePath: 'В БД не хранится',
  };
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

function parseLabelConditionBranch(value: unknown): LabelConditionBranch | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (value.type === 'current' || value.type === 'hidden') {
    return hasExactKeys(value, ['type']) ? { type: value.type } : null;
  }
  if (value.type === 'field') {
    return hasExactKeys(value, ['type', 'field'])
      && typeof value.field === 'string'
      && Boolean(value.field.trim())
      && value.field.length <= 200
      ? { type: 'field', field: value.field.trim() }
      : null;
  }
  return value.type === 'text'
    && hasExactKeys(value, ['type', 'value'])
    && typeof value.value === 'string'
    && value.value.length <= 1000
    ? { type: 'text', value: value.value }
    : null;
}

function hasExactKeys(value: Record<string, unknown>, required: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === required.length
    && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isLabelConditionScalar(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

function labelConditionPasses(
  condition: LabelIfElseCondition,
  values: Map<string, string>,
): boolean {
  const value = values.get(condition.when.field);
  if (condition.when.op === 'exists') return value !== undefined && value !== null;
  if (condition.when.op === 'not_empty') return value !== undefined && value !== null && value !== '';
  if (condition.when.op === 'equals') return String(value ?? '') === String(condition.when.value ?? '');
  return String(value ?? '') !== String(condition.when.value ?? '');
}

function resolvePreviewBranch(
  branch: LabelConditionBranch,
  current: string,
  values: Map<string, string>,
  labels: Map<string, string>,
): string {
  if (branch.type === 'current') return current;
  if (branch.type === 'hidden') return '';
  if (branch.type === 'text') return branch.value;
  return values.get(branch.field) ?? labels.get(branch.field) ?? branch.field;
}

function selectionUnit(elements: LabelTemplateElement[], elementKey: string): string[] {
  const target = elements.find((element) => element.elementKey === elementKey);
  if (!target) return [];
  const groupId = readLabelEditorMeta(target).groupId;
  if (!groupId) return [elementKey];
  return elements
    .filter((element) => readLabelEditorMeta(element).groupId === groupId)
    .map((element) => element.elementKey);
}

function expandSelectionKeys(elements: LabelTemplateElement[], selectedKeys: string[]): Set<string> {
  const expanded = new Set<string>();
  for (const key of selectedKeys) {
    for (const unitKey of selectionUnit(elements, key)) expanded.add(unitKey);
  }
  return expanded;
}

function elementAabb(element: LabelTemplateElement): { minX: number; minY: number; maxX: number; maxY: number } {
  const x = Number(element.xMm ?? 0);
  const y = Number(element.yMm ?? 0);
  const width = Math.max(0, Number(element.widthMm ?? 0));
  const height = Math.max(0, Number(element.heightMm ?? 0));
  const radians = Number(element.rotationDeg ?? 0) * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const corners = [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ].map(([dx, dy]) => ({ x: x + dx * cos - dy * sin, y: y + dx * sin + dy * cos }));
  return {
    minX: Math.min(...corners.map((corner) => corner.x)),
    minY: Math.min(...corners.map((corner) => corner.y)),
    maxX: Math.max(...corners.map((corner) => corner.x)),
    maxY: Math.max(...corners.map((corner) => corner.y)),
  };
}

function unionBounds(bounds: Array<{ minX: number; minY: number; maxX: number; maxY: number }>) {
  return {
    minX: Math.min(...bounds.map((bound) => bound.minX)),
    minY: Math.min(...bounds.map((bound) => bound.minY)),
    maxX: Math.max(...bounds.map((bound) => bound.maxX)),
    maxY: Math.max(...bounds.map((bound) => bound.maxY)),
  };
}

function roundGeometry(value: number): number {
  return Math.round(value * 10) / 10;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
