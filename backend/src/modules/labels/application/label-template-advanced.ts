import { ApiError } from '../../../common/errors/api-error';
import type { LabelTemplateElementInput } from './labels.types';
import { assertRenderableCustomFieldSchema } from './label-custom-field-expression';

export const LABEL_RENDERER_CAPABILITIES = ['if_else_v1', 'typography_v1', 'cut_map_v1', 'custom_expression_v1'] as const;
export type LabelRendererCapability = (typeof LABEL_RENDERER_CAPABILITIES)[number];

type ConditionOperator = 'exists' | 'not_empty' | 'equals' | 'not_equals';
type ConditionBranch =
  | { type: 'current' }
  | { type: 'field'; field: string }
  | { type: 'text'; value: string }
  | { type: 'hidden' };

export interface IfElseConditionV1 {
  type: 'if_else';
  version: 1;
  when: { field: string; op: ConditionOperator; value?: string | number | boolean | null };
  then: ConditionBranch;
  else: ConditionBranch;
}

export interface TypographyV1 {
  version: 1;
  fontSizePt: number;
  fontWeight: 'normal' | 'bold';
  italic: boolean;
}

export interface CutMapStyleV1 {
  version: 1;
  fit: 'contain';
  highlightFill: string;
  highlightStroke: string;
}

export function assertAdvancedElementShape(element: LabelTemplateElementInput, elementIndex: number): void {
  const condition = element.condition ?? {};
  if (condition.type === 'if_else') {
    const parsed = parseIfElseCondition(condition);
    if (!parsed) throw invalidShape('Invalid if_else condition', elementIndex);
    if (element.kind !== 'text') throw invalidShape('if_else is supported only for text elements', elementIndex);
  } else if (Object.prototype.hasOwnProperty.call(condition, 'version')) {
    throw invalidShape('Unknown versioned label condition', elementIndex);
  } else if (Object.keys(condition).length > 0 && !isStrictLegacyCondition(condition)) {
    throw invalidShape('Invalid legacy label condition', elementIndex);
  }

  const style = element.style ?? {};
  if (Object.prototype.hasOwnProperty.call(style, 'typography') && !readTypographyV1(style)) {
    throw invalidShape('Invalid typography metadata', elementIndex);
  }
  if (Object.prototype.hasOwnProperty.call(style, 'editor') && !readEditorMetadataV1(style)) {
    throw invalidShape('Invalid editor metadata', elementIndex);
  }
  if (element.kind === 'cut_map' && !readCutMapStyleV1(style)) {
    throw invalidShape('cut_map requires cutMap v1 metadata', elementIndex);
  }
  assertNoUnknownVersionedStyleNamespace(style, elementIndex);
}

export function assertRenderableAdvancedElementShape(element: LabelTemplateElementInput, elementIndex: number): void {
  const condition = element.condition ?? {};
  if (condition.type === 'if_else') {
    const parsed = parseIfElseCondition(condition);
    if (!parsed) throw invalidShape('Invalid stored if_else condition', elementIndex);
    if (element.kind !== 'text') throw invalidShape('Stored if_else is supported only for text elements', elementIndex);
  } else if (Object.prototype.hasOwnProperty.call(condition, 'version')) {
    throw invalidShape('Unknown stored versioned label condition', elementIndex);
  }

  const style = element.style ?? {};
  if (Object.prototype.hasOwnProperty.call(style, 'typography') && !readTypographyV1(style)) {
    throw invalidShape('Invalid stored typography metadata', elementIndex);
  }
  if (Object.prototype.hasOwnProperty.call(style, 'editor') && !readEditorMetadataV1(style)) {
    throw invalidShape('Invalid stored editor metadata', elementIndex);
  }
  if (element.kind === 'cut_map' && !readCutMapStyleV1(style)) {
    throw invalidShape('Stored cut_map requires cutMap v1 metadata', elementIndex);
  }
  assertNoUnknownVersionedStyleNamespace(style, elementIndex);
}

export function assertRenderableTemplateShape(template: {
  elements: LabelTemplateElementInput[];
  customFieldSchema?: Record<string, unknown>;
}): void {
  template.elements.forEach(assertRenderableAdvancedElementShape);
  assertRenderableCustomFieldSchema(template.customFieldSchema ?? {});
}

function isStrictLegacyCondition(value: Record<string, unknown>): boolean {
  const field = value.field;
  if (typeof field !== 'string' || !field.trim() || field.length > 200) return false;
  if (value.op === 'exists' || value.op === 'not_empty') {
    return exactKeys(value, ['field', 'op']);
  }
  if (value.op !== 'equals' && value.op !== 'not_equals') return false;
  return exactKeys(value, ['field', 'op', 'value'])
    && isScalar(value.value)
    && (typeof value.value !== 'string' || value.value.length <= 1000);
}

function assertNoUnknownVersionedStyleNamespace(style: Record<string, unknown>, elementIndex: number): void {
  for (const [key, value] of Object.entries(style)) {
    if (key === 'typography' || key === 'editor' || key === 'cutMap' || !isRecord(value)) continue;
    if (Object.prototype.hasOwnProperty.call(value, 'version')) {
      throw invalidShape(`Unknown versioned style namespace: ${key}`, elementIndex);
    }
  }
}

export function conditionFieldIds(condition: Record<string, unknown> | undefined): string[] {
  if (!condition) return [];
  const advanced = parseIfElseCondition(condition);
  if (advanced) {
    const ids = [advanced.when.field];
    if (advanced.then.type === 'field') ids.push(advanced.then.field);
    if (advanced.else.type === 'field') ids.push(advanced.else.field);
    return [...new Set(ids)];
  }
  return typeof condition.field === 'string' && condition.field.trim() ? [condition.field.trim()] : [];
}

export function resolveLabelText(
  element: LabelTemplateElementInput,
  values: Record<string, string | number | boolean | null>,
): string {
  const current = element.sourceField ? values[element.sourceField] : element.staticText;
  const condition = parseIfElseCondition(element.condition ?? {});
  if (!condition) return current == null ? '' : String(current);
  const branch = conditionMatches(condition, values) ? condition.then : condition.else;
  if (branch.type === 'hidden') return '';
  if (branch.type === 'current') return current == null ? '' : String(current);
  if (branch.type === 'text') return branch.value;
  const value = values[branch.field];
  return value == null ? '' : String(value);
}

export function legacyConditionPasses(
  condition: Record<string, unknown>,
  values: Record<string, unknown>,
): boolean {
  if (condition.type === 'if_else') return true;
  const field = typeof condition.field === 'string' ? condition.field : '';
  const op = typeof condition.op === 'string' ? condition.op : '';
  if (!field || !op) return true;
  const value = values[field];
  if (op === 'exists') return value !== undefined && value !== null;
  if (op === 'not_empty') return value !== undefined && value !== null && String(value) !== '';
  if (op === 'equals') return String(value ?? '') === String(condition.value ?? '');
  if (op === 'not_equals') return String(value ?? '') !== String(condition.value ?? '');
  return true;
}

export function readTypographyV1(style: Record<string, unknown>): TypographyV1 | null {
  const value = style.typography;
  if (!isRecord(value) || !exactKeys(value, ['version', 'fontSizePt', 'fontWeight', 'italic'])) return null;
  if (typeof value.fontSizePt !== 'number' || !Number.isFinite(value.fontSizePt)) return null;
  const fontSizePt = value.fontSizePt;
  if (value.version !== 1 || fontSizePt < 4 || fontSizePt > 96) return null;
  if (value.fontWeight !== 'normal' && value.fontWeight !== 'bold') return null;
  if (typeof value.italic !== 'boolean') return null;
  return { version: 1, fontSizePt, fontWeight: value.fontWeight, italic: value.italic };
}

export function readEditorMetadataV1(style: Record<string, unknown>): {
  version: 1;
  boundsMode: 'auto' | 'manual';
  groupId?: string;
} | null {
  const value = style.editor;
  if (!isRecord(value) || !exactKeys(value, ['version', 'boundsMode'], ['groupId'])) return null;
  if (value.version !== 1 || (value.boundsMode !== 'auto' && value.boundsMode !== 'manual')) return null;
  if (value.groupId !== undefined && (typeof value.groupId !== 'string' || !/^[\p{L}\p{N}._:-]{1,100}$/u.test(value.groupId))) return null;
  return {
    version: 1,
    boundsMode: value.boundsMode,
    ...(typeof value.groupId === 'string' ? { groupId: value.groupId } : {}),
  };
}

export function readCutMapStyleV1(style: Record<string, unknown>): CutMapStyleV1 | null {
  const value = style.cutMap;
  if (!isRecord(value) || !exactKeys(value, ['version', 'fit', 'highlightFill', 'highlightStroke'])) return null;
  if (value.version !== 1 || value.fit !== 'contain') return null;
  if (!isHexColor(value.highlightFill) || !isHexColor(value.highlightStroke)) return null;
  return {
    version: 1,
    fit: 'contain',
    highlightFill: value.highlightFill,
    highlightStroke: value.highlightStroke,
  };
}

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

export function parseIfElseCondition(value: Record<string, unknown>): IfElseConditionV1 | null {
  if (!exactKeys(value, ['type', 'version', 'when', 'then', 'else'])) return null;
  if (value.type !== 'if_else' || value.version !== 1) return null;
  if (!isRecord(value.when) || !isRecord(value.then) || !isRecord(value.else)) return null;
  const when = parseWhen(value.when);
  const thenBranch = parseBranch(value.then);
  const elseBranch = parseBranch(value.else);
  if (!when || !thenBranch || !elseBranch) return null;
  return { type: 'if_else', version: 1, when, then: thenBranch, else: elseBranch };
}

function parseWhen(value: Record<string, unknown>): IfElseConditionV1['when'] | null {
  if (typeof value.field !== 'string' || !value.field.trim() || value.field.length > 200) return null;
  const op = value.op;
  if (op === 'exists' || op === 'not_empty') {
    if (!exactKeys(value, ['field', 'op'])) return null;
    return { field: value.field.trim(), op };
  }
  if (op !== 'equals' && op !== 'not_equals') return null;
  if (!exactKeys(value, ['field', 'op', 'value']) || !isScalar(value.value)) return null;
  if (typeof value.value === 'string' && value.value.length > 1000) return null;
  return { field: value.field.trim(), op, value: value.value };
}

function parseBranch(value: Record<string, unknown>): ConditionBranch | null {
  if (value.type === 'current' || value.type === 'hidden') {
    return exactKeys(value, ['type']) ? { type: value.type } : null;
  }
  if (value.type === 'field') {
    return exactKeys(value, ['type', 'field']) && typeof value.field === 'string' && Boolean(value.field.trim()) && value.field.length <= 200
      ? { type: 'field', field: value.field.trim() }
      : null;
  }
  if (value.type === 'text') {
    return exactKeys(value, ['type', 'value']) && typeof value.value === 'string' && value.value.length <= 1000
      ? { type: 'text', value: value.value }
      : null;
  }
  return null;
}

function conditionMatches(
  condition: IfElseConditionV1,
  values: Record<string, string | number | boolean | null>,
): boolean {
  const value = values[condition.when.field];
  if (condition.when.op === 'exists') return value !== undefined && value !== null;
  if (condition.when.op === 'not_empty') return value !== undefined && value !== null && String(value) !== '';
  if (condition.when.op === 'equals') return String(value ?? '') === String(condition.when.value ?? '');
  return String(value ?? '') !== String(condition.when.value ?? '');
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

function invalidShape(message: string, elementIndex: number): ApiError {
  return new ApiError(422, 'LABEL_ELEMENT_SCHEMA_INVALID', message, { elementIndex });
}
