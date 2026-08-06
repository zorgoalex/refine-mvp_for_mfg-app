import { ApiError } from '../../../common/errors/api-error';
import { EXPORT_FIELD_KEYS, resolveExportField } from './export-template-fields';
import type {
  BazisExportDetail,
  ExportCondition,
  ExportEvaluationContext,
  ExportExpression,
  ExportScalar,
  ExportTemplateColumn,
} from './export-template.types';

export const EXPORT_LIMITS = {
  maxDepth: 8,
  maxNodes: 100,
  maxColumns: 100,
  maxParts: 20,
  maxCells: 2_500_000,
  maxEvaluatedNodes: 10_000_000,
  maxStringCell: 10_000,
  maxStringChars: 20_000_000,
  maxElapsedMs: 15_000,
  maxBytes: 64 * 1024 * 1024,
} as const;

type ExportColumnResolver = (columnKey: string, path: string) => ExportScalar;
type ColumnDependency = { columnKey: string; path: string };

export function validateExportColumns(columns: readonly ExportTemplateColumn[]): number[] {
  if (columns.length < 1 || columns.length > EXPORT_LIMITS.maxColumns) {
    throw validationError('columns', `Columns must contain 1..${EXPORT_LIMITS.maxColumns} items`);
  }
  const keys = new Set<string>();
  columns.forEach((column, index) => {
    if (keys.has(column.columnKey)) throw validationError(`columns.${index}.columnKey`, 'Column key must be unique');
    keys.add(column.columnKey);
  });

  const dependencies = new Map<string, ColumnDependency[]>();
  const counts = columns.map((column, index) => {
    const refs: ColumnDependency[] = [];
    dependencies.set(column.columnKey, refs);
    return validateExpressionInternal(column.expression, `columns.${index}.expression`, keys,
      (columnKey, path) => refs.push({ columnKey, path }));
  });
  validateColumnDependencyGraph(columns, dependencies);
  return counts;
}

export function validateExpression(expression: ExportExpression, path = 'expression'): number {
  return validateExpressionInternal(expression, path);
}

function validateExpressionInternal(
  expression: ExportExpression,
  path: string,
  columnKeys?: ReadonlySet<string>,
  onColumnRef?: (columnKey: string, path: string) => void,
): number {
  let nodes = 0;
  const visit = (node: ExportExpression, depth: number, nodePath: string): void => {
    nodes += 1;
    if (depth > EXPORT_LIMITS.maxDepth) throw validationError(nodePath, `Expression depth exceeds ${EXPORT_LIMITS.maxDepth}`);
    if (nodes > EXPORT_LIMITS.maxNodes) throw validationError(nodePath, `Expression nodes exceed ${EXPORT_LIMITS.maxNodes}`);
    switch (node.type) {
      case 'field':
        if (!EXPORT_FIELD_KEYS.has(node.field)) throw validationError(`${nodePath}.field`, `Unknown field: ${node.field}`);
        return;
      case 'column_ref':
        if (!columnKeys?.has(node.columnKey)) {
          throw validationError(`${nodePath}.columnKey`, `Unknown column: ${node.columnKey}`);
        }
        onColumnRef?.(node.columnKey, `${nodePath}.columnKey`);
        return;
      case 'constant':
      case 'empty': return;
      case 'concat':
      case 'math':
        node.parts.forEach((part, index) => visit(part, depth + 1, `${nodePath}.parts.${index}`));
        return;
      case 'if_else':
        visit(node.when.left, depth + 1, `${nodePath}.when.left`);
        if (requiresRight(node.when.op) && node.when.right === undefined) {
          throw validationError(`${nodePath}.when.right`, `Operator ${node.when.op} requires right operand`);
        }
        if (!requiresRight(node.when.op) && node.when.right !== undefined) {
          throw validationError(`${nodePath}.when.right`, `Operator ${node.when.op} does not accept right operand`);
        }
        if (node.when.right) visit(node.when.right, depth + 1, `${nodePath}.when.right`);
        visit(node.then, depth + 1, `${nodePath}.then`);
        visit(node.else, depth + 1, `${nodePath}.else`);
        return;
      case 'string_fn':
      case 'number_fn':
        visit(node.input, depth + 1, `${nodePath}.input`);
        return;
    }
  };
  visit(expression, 1, path);
  return nodes;
}

function validateColumnDependencyGraph(
  columns: readonly ExportTemplateColumn[],
  dependencies: ReadonlyMap<string, readonly ColumnDependency[]>,
): void {
  const state = new Map<string, 'visiting' | 'visited'>();
  const stack: string[] = [];
  const visit = (columnKey: string): void => {
    state.set(columnKey, 'visiting');
    stack.push(columnKey);
    for (const dependency of dependencies.get(columnKey) ?? []) {
      if (state.get(dependency.columnKey) === 'visiting') {
        const cycleStart = stack.indexOf(dependency.columnKey);
        const cycle = [...stack.slice(cycleStart), dependency.columnKey].join(' -> ');
        throw validationError(dependency.path, `Cyclic column reference: ${cycle}`);
      }
      if (state.get(dependency.columnKey) !== 'visited') visit(dependency.columnKey);
    }
    stack.pop();
    state.set(columnKey, 'visited');
  };
  columns.forEach((column) => {
    if (!state.has(column.columnKey)) visit(column.columnKey);
  });
}

export function evaluateExportRow(
  columns: readonly ExportTemplateColumn[],
  detail: BazisExportDetail,
  context: ExportEvaluationContext,
): ExportScalar[] {
  const columnIndexes = new Map(columns.map((column, index) => [column.columnKey, index]));
  const values = new Map<string, ExportScalar>();
  const evaluating = new Set<string>();

  const evaluateColumn = (index: number): ExportScalar => {
    const column = columns[index];
    if (values.has(column.columnKey)) return values.get(column.columnKey)!;
    if (evaluating.has(column.columnKey)) {
      throw evaluationError(`columns.${index}.expression`, `Cyclic column reference at runtime: ${column.columnKey}`);
    }
    evaluating.add(column.columnKey);
    try {
      const value = evaluateExpression(column.expression, detail, context, `columns.${index}.expression`,
        (columnKey, path) => {
          const referencedIndex = columnIndexes.get(columnKey);
          if (referencedIndex === undefined) throw evaluationError(path, `Unknown column: ${columnKey}`);
          return evaluateColumn(referencedIndex);
        });
      values.set(column.columnKey, value);
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.details?.columnKey === undefined) {
        throw new ApiError(error.statusCode, error.code, error.message, {
          ...(error.details ?? {}), columnKey: column.columnKey, columnHeader: column.header,
        });
      }
      throw error;
    } finally {
      evaluating.delete(column.columnKey);
    }
  };

  return columns.map((_, index) => evaluateColumn(index));
}

export function evaluateExpression(
  expression: ExportExpression,
  detail: BazisExportDetail,
  context: ExportEvaluationContext,
  path = 'expression',
  resolveColumn?: ExportColumnResolver,
): ExportScalar {
  const evaluate = (child: ExportExpression, childPath: string) =>
    evaluateExpression(child, detail, context, childPath, resolveColumn);
  switch (expression.type) {
    case 'field': return resolveExportField(expression.field, detail, context);
    case 'column_ref':
      if (!resolveColumn) throw evaluationError(path, 'Column reference requires row evaluation context');
      return resolveColumn(expression.columnKey, `${path}.columnKey`);
    case 'constant': return expression.value;
    case 'empty': return null;
    case 'concat': return checkedString(expression.parts.map((part, index) =>
      toText(evaluate(part, `${path}.parts.${index}`))).join(''), path);
    case 'if_else': return evaluateCondition(expression.when, detail, context, `${path}.when`, resolveColumn)
      ? evaluate(expression.then, `${path}.then`)
      : evaluate(expression.else, `${path}.else`);
    case 'string_fn': {
      const value = toText(evaluate(expression.input, `${path}.input`));
      const result = expression.fn === 'trim' ? value.trim() : expression.fn === 'upper' ? value.toUpperCase() : value.toLowerCase();
      return checkedString(result, path);
    }
    case 'number_fn': {
      const raw = evaluate(expression.input, `${path}.input`);
      if (isBlank(raw)) return null;
      const value = toNumber(raw, path);
      let result: number;
      if (expression.fn === 'round') {
        const factor = 10 ** (expression.digits ?? 0);
        result = Math.round(value * factor) / factor;
      } else if (expression.fn === 'floor') result = Math.floor(value);
      else if (expression.fn === 'ceil') result = Math.ceil(value);
      else result = Math.abs(value);
      return checkedNumber(result, path);
    }
    case 'math': {
      const values = expression.parts.map((part, index) => {
        const value = evaluate(part, `${path}.parts.${index}`);
        return isBlank(value) ? null : toNumber(value, `${path}.parts.${index}`);
      });
      if (values.some((value) => value === null)) return null;
      const numbers = values as number[];
      let result = numbers[0];
      for (const value of numbers.slice(1)) {
        if (expression.fn === 'add') result += value;
        else if (expression.fn === 'subtract') result -= value;
        else if (expression.fn === 'multiply') result *= value;
        else {
          if (value === 0) throw evaluationError(path, 'Division by zero');
          result /= value;
        }
      }
      return checkedNumber(result, path);
    }
  }
}

function evaluateCondition(
  condition: ExportCondition,
  detail: BazisExportDetail,
  context: ExportEvaluationContext,
  path: string,
  resolveColumn?: ExportColumnResolver,
): boolean {
  const left = evaluateExpression(condition.left, detail, context, `${path}.left`, resolveColumn);
  if (condition.op === 'exists') return left !== null && left !== undefined;
  if (condition.op === 'not_empty') return !isBlank(left);
  const right = evaluateExpression(condition.right!, detail, context, `${path}.right`, resolveColumn);
  if (condition.op === 'equals' || condition.op === 'not_equals') {
    const equal = left === null || right === null
      ? left === right
      : typeof left === 'number' && typeof right === 'number'
        ? left === right
        : typeof left === 'boolean' && typeof right === 'boolean'
          ? left === right
          : toText(left) === toText(right);
    return condition.op === 'equals' ? equal : !equal;
  }
  if (condition.op === 'contains') {
    if (isBlank(left) || isBlank(right)) return false;
    return toText(left).includes(toText(right));
  }
  const a = toNumber(left, `${path}.left`);
  const b = toNumber(right, `${path}.right`);
  if (condition.op === 'gt') return a > b;
  if (condition.op === 'gte') return a >= b;
  if (condition.op === 'lt') return a < b;
  return a <= b;
}

function requiresRight(op: ExportCondition['op']): boolean {
  return op !== 'exists' && op !== 'not_empty';
}

function isBlank(value: ExportScalar | undefined): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function toText(value: ExportScalar): string {
  return value === null ? '' : String(value);
}

const INVARIANT_NUMBER = /^-?(?:\d+|\d*\.\d+)$/;

function toNumber(value: ExportScalar, path: string): number {
  if (typeof value === 'number') return checkedNumber(value, path);
  if (typeof value === 'string' && INVARIANT_NUMBER.test(value.trim())) return checkedNumber(Number(value.trim()), path);
  throw evaluationError(path, 'Expected an invariant finite number');
}

function checkedNumber(value: number, path: string): number {
  if (!Number.isFinite(value)) throw evaluationError(path, 'Numeric result is not finite');
  return value;
}

function checkedString(value: string, path: string): string {
  if (value.length > EXPORT_LIMITS.maxStringCell) throw evaluationError(path, 'String cell exceeds limit');
  return value;
}

function validationError(field: string, message: string): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', 'Export template validation failed', { errors: [{ field, message }] });
}

function evaluationError(path: string, message: string): ApiError {
  return new ApiError(422, 'EXPORT_TEMPLATE_EVALUATION_ERROR', message, { expressionPath: path });
}
