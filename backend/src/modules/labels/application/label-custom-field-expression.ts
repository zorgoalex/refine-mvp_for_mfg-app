import { ApiError } from '../../../common/errors/api-error';

export type LabelCustomExpressionScalar = string | number | boolean | null;
export type LabelCustomExpressionOperator = 'exists' | 'not_empty' | 'equals' | 'not_equals';

export type LabelCustomExpressionNode =
  | { type: 'field'; field: string }
  | { type: 'text'; value: string }
  | { type: 'concat'; parts: LabelCustomExpressionNode[] }
  | {
      type: 'if_else';
      when: { field: string; op: LabelCustomExpressionOperator; value?: LabelCustomExpressionScalar };
      then: LabelCustomExpressionNode;
      else: LabelCustomExpressionNode;
    }
  | { type: 'empty' };

export interface LabelCustomFieldExpressionV1 {
  type: 'custom_expression';
  version: 1;
  root: LabelCustomExpressionNode;
}

const MAX_EXPRESSION_DEPTH = 8;
const MAX_EXPRESSION_NODES = 100;
const MAX_CONCAT_PARTS = 20;
const MAX_FIELD_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 1000;
const MAX_CUSTOM_FIELDS = 100;
const MAX_TOTAL_EXPRESSION_NODES = 1000;
const MAX_TOTAL_EXPRESSION_TEXT = 100_000;
const MAX_CUSTOM_DEPENDENCY_DEPTH = 50;
const MAX_EXPRESSION_RESULT_LENGTH = 10_000;

export function hasCustomFieldExpression(schema: unknown): boolean {
  return isRecord(schema) && Object.prototype.hasOwnProperty.call(schema, 'expression');
}

export function readCustomFieldExpressionV1(schema: unknown): LabelCustomFieldExpressionV1 | null {
  if (!isRecord(schema)) return null;
  const expression = schema.expression;
  if (!isRecord(expression)
    || !exactKeys(expression, ['type', 'version', 'root'])
    || expression.type !== 'custom_expression'
    || expression.version !== 1) return null;
  const budget = { nodes: 0 };
  const root = parseNode(expression.root, 1, budget);
  return root ? { type: 'custom_expression', version: 1, root } : null;
}

export function customExpressionFieldIds(expression: LabelCustomFieldExpressionV1): string[] {
  const result = new Set<string>();
  visitNode(expression.root, (fieldId) => result.add(fieldId));
  return [...result];
}

export function findCustomFieldExpressionCycle(
  customFieldSchema: Record<string, unknown>,
): string[] | null {
  const customIds = new Set(Object.keys(customFieldSchema));
  const graph = new Map<string, string[]>();
  for (const [fieldId, schema] of Object.entries(customFieldSchema)) {
    const expression = readCustomFieldExpressionV1(schema);
    graph.set(
      fieldId,
      expression
        ? customExpressionFieldIds(expression).filter((dependency) => customIds.has(dependency))
        : [],
    );
  }

  const visited = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];
  const walk = (fieldId: string): string[] | null => {
    if (active.has(fieldId)) {
      const cycleStart = path.indexOf(fieldId);
      return [...path.slice(cycleStart), fieldId];
    }
    if (visited.has(fieldId)) return null;
    visited.add(fieldId);
    active.add(fieldId);
    path.push(fieldId);
    for (const dependency of graph.get(fieldId) ?? []) {
      const cycle = walk(dependency);
      if (cycle) return cycle;
    }
    path.pop();
    active.delete(fieldId);
    return null;
  };

  for (const fieldId of graph.keys()) {
    const cycle = walk(fieldId);
    if (cycle) return cycle;
  }
  return null;
}

export function assertRenderableCustomFieldSchema(customFieldSchema: Record<string, unknown>): void {
  const hasExpressions = Object.values(customFieldSchema).some(hasCustomFieldExpression);
  if (hasExpressions && Object.keys(customFieldSchema).length > MAX_CUSTOM_FIELDS) {
    throw invalidExpression('Too many custom fields', '', { maxCustomFields: MAX_CUSTOM_FIELDS });
  }
  let totalNodes = 0;
  let totalText = 0;
  for (const [fieldId, schema] of Object.entries(customFieldSchema)) {
    if (hasCustomFieldExpression(schema)) {
      if (!isRecord(schema)) {
        throw invalidExpression('Invalid stored custom field expression', fieldId);
      }
      const expression = readCustomFieldExpressionV1(schema);
      if (!expression) {
        throw invalidExpression('Invalid stored custom field expression', fieldId);
      }
      if (Object.prototype.hasOwnProperty.call(schema, 'sourceField')
        || Object.prototype.hasOwnProperty.call(schema, 'defaultValue')) {
        throw invalidExpression('Stored custom field expression has conflicting value mappings', fieldId);
      }
      if (schema.type !== 'string') {
        throw invalidExpression('Custom field expression requires string field type', fieldId);
      }
      const stats = expressionStats(expression.root);
      totalNodes += stats.nodes;
      totalText += stats.textLength;
    }
  }
  if (totalNodes > MAX_TOTAL_EXPRESSION_NODES || totalText > MAX_TOTAL_EXPRESSION_TEXT) {
    throw invalidExpression('Custom field expressions exceed aggregate limits', '', {
      totalNodes,
      totalText,
      maxTotalNodes: MAX_TOTAL_EXPRESSION_NODES,
      maxTotalText: MAX_TOTAL_EXPRESSION_TEXT,
    });
  }
  const cycle = findCustomFieldExpressionCycle(customFieldSchema);
  if (cycle) {
    throw invalidExpression('Stored custom field expressions contain a dependency cycle', cycle[0], { cycle });
  }
  const deepDependency = findDependencyDepthViolation(customFieldSchema, MAX_CUSTOM_DEPENDENCY_DEPTH);
  if (deepDependency) {
    throw invalidExpression('Custom field expression dependency chain is too deep', deepDependency[0], {
      dependencyPath: deepDependency,
      maxDependencyDepth: MAX_CUSTOM_DEPENDENCY_DEPTH,
    });
  }
}

export function evaluateCustomFieldExpression(
  expression: LabelCustomFieldExpressionV1,
  getValue: (fieldId: string) => LabelCustomExpressionScalar | undefined,
): string {
  return evaluateNode(expression.root, getValue);
}

function parseNode(value: unknown, depth: number, budget: { nodes: number }): LabelCustomExpressionNode | null {
  if (!isRecord(value) || depth > MAX_EXPRESSION_DEPTH) return null;
  budget.nodes += 1;
  if (budget.nodes > MAX_EXPRESSION_NODES) return null;

  if (value.type === 'empty') {
    return exactKeys(value, ['type']) ? { type: 'empty' } : null;
  }
  if (value.type === 'field') {
    return exactKeys(value, ['type', 'field']) && isFieldId(value.field)
      ? { type: 'field', field: value.field.trim() }
      : null;
  }
  if (value.type === 'text') {
    return exactKeys(value, ['type', 'value']) && typeof value.value === 'string' && value.value.length <= MAX_TEXT_LENGTH
      ? { type: 'text', value: value.value }
      : null;
  }
  if (value.type === 'concat') {
    if (!exactKeys(value, ['type', 'parts']) || !Array.isArray(value.parts)
      || value.parts.length === 0 || value.parts.length > MAX_CONCAT_PARTS) return null;
    const parts: LabelCustomExpressionNode[] = [];
    for (const part of value.parts) {
      const parsed = parseNode(part, depth + 1, budget);
      if (!parsed) return null;
      parts.push(parsed);
    }
    return { type: 'concat', parts };
  }
  if (value.type === 'if_else') {
    if (!exactKeys(value, ['type', 'when', 'then', 'else']) || !isRecord(value.when)) return null;
    const when = parseWhen(value.when);
    const thenNode = parseNode(value.then, depth + 1, budget);
    const elseNode = parseNode(value.else, depth + 1, budget);
    return when && thenNode && elseNode
      ? { type: 'if_else', when, then: thenNode, else: elseNode }
      : null;
  }
  return null;
}

function parseWhen(value: Record<string, unknown>): Extract<LabelCustomExpressionNode, { type: 'if_else' }>['when'] | null {
  if (!isFieldId(value.field)) return null;
  if (value.op === 'exists' || value.op === 'not_empty') {
    return exactKeys(value, ['field', 'op'])
      ? { field: value.field.trim(), op: value.op }
      : null;
  }
  if (value.op !== 'equals' && value.op !== 'not_equals') return null;
  if (!exactKeys(value, ['field', 'op', 'value']) || !isScalar(value.value)) return null;
  if (typeof value.value === 'string' && value.value.length > MAX_TEXT_LENGTH) return null;
  return { field: value.field.trim(), op: value.op, value: value.value };
}

function evaluateNode(
  node: LabelCustomExpressionNode,
  getValue: (fieldId: string) => LabelCustomExpressionScalar | undefined,
): string {
  if (node.type === 'empty') return '';
  if (node.type === 'text') return ensureResultLength(node.value);
  if (node.type === 'field') return ensureResultLength(stringify(getValue(node.field)));
  if (node.type === 'concat') {
    let result = '';
    for (const part of node.parts) {
      result = ensureResultLength(result + evaluateNode(part, getValue));
    }
    return result;
  }
  return conditionMatches(node.when, getValue(node.when.field))
    ? evaluateNode(node.then, getValue)
    : evaluateNode(node.else, getValue);
}

function expressionStats(node: LabelCustomExpressionNode): { nodes: number; textLength: number } {
  if (node.type === 'text') return { nodes: 1, textLength: node.value.length };
  if (node.type === 'field' || node.type === 'empty') return { nodes: 1, textLength: 0 };
  const children = node.type === 'concat' ? node.parts : [node.then, node.else];
  return children.reduce(
    (total, child) => {
      const childStats = expressionStats(child);
      return { nodes: total.nodes + childStats.nodes, textLength: total.textLength + childStats.textLength };
    },
    { nodes: 1, textLength: 0 },
  );
}

function findDependencyDepthViolation(
  customFieldSchema: Record<string, unknown>,
  maxDepth: number,
): string[] | null {
  const customIds = new Set(Object.keys(customFieldSchema));
  const graph = new Map<string, string[]>();
  for (const [fieldId, schema] of Object.entries(customFieldSchema)) {
    const expression = readCustomFieldExpressionV1(schema);
    graph.set(fieldId, expression
      ? customExpressionFieldIds(expression).filter((dependency) => customIds.has(dependency))
      : []);
  }
  const longestPathByField = new Map<string, string[]>();
  const longestPathFrom = (fieldId: string): string[] => {
    const cached = longestPathByField.get(fieldId);
    if (cached) return cached;
    let longest = [fieldId];
    for (const dependency of graph.get(fieldId) ?? []) {
      const candidate = [fieldId, ...longestPathFrom(dependency)];
      if (candidate.length > longest.length) longest = candidate;
    }
    longestPathByField.set(fieldId, longest);
    return longest;
  };
  for (const fieldId of graph.keys()) {
    const path = longestPathFrom(fieldId);
    if (path.length > maxDepth) return path;
  }
  return null;
}

function conditionMatches(
  when: Extract<LabelCustomExpressionNode, { type: 'if_else' }>['when'],
  value: LabelCustomExpressionScalar | undefined,
): boolean {
  if (when.op === 'exists') return value !== undefined && value !== null;
  if (when.op === 'not_empty') return value !== undefined && value !== null && String(value) !== '';
  if (when.op === 'equals') return String(value ?? '') === String(when.value ?? '');
  return String(value ?? '') !== String(when.value ?? '');
}

function visitNode(node: LabelCustomExpressionNode, visit: (fieldId: string) => void): void {
  if (node.type === 'field') {
    visit(node.field);
    return;
  }
  if (node.type === 'concat') {
    node.parts.forEach((part) => visitNode(part, visit));
    return;
  }
  if (node.type === 'if_else') {
    visit(node.when.field);
    visitNode(node.then, visit);
    visitNode(node.else, visit);
  }
}

function stringify(value: LabelCustomExpressionScalar | undefined): string {
  return value == null ? '' : String(value);
}

function ensureResultLength(value: string): string {
  if (value.length <= MAX_EXPRESSION_RESULT_LENGTH) return value;
  throw new ApiError(
    422,
    'LABEL_CUSTOM_EXPRESSION_RESULT_TOO_LONG',
    'Custom field expression result is too long',
    { maxLength: MAX_EXPRESSION_RESULT_LENGTH },
  );
}

function isFieldId(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= MAX_FIELD_ID_LENGTH;
}

function isScalar(value: unknown): value is LabelCustomExpressionScalar {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

function exactKeys(value: Record<string, unknown>, required: string[]): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => required.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidExpression(
  message: string,
  fieldId: string,
  details: Record<string, unknown> = {},
): ApiError {
  return new ApiError(422, 'LABEL_CUSTOM_EXPRESSION_INVALID', message, { fieldId, ...details });
}
