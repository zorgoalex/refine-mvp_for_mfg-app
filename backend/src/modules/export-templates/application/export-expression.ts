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

export function validateExportColumns(columns: readonly ExportTemplateColumn[]): number[] {
  const counts: number[] = [];
  if (columns.length < 1 || columns.length > EXPORT_LIMITS.maxColumns) {
    throw validationError('columns', `Columns must contain 1..${EXPORT_LIMITS.maxColumns} items`);
  }
  const keys = new Set<string>();
  columns.forEach((column, index) => {
    if (keys.has(column.columnKey)) throw validationError(`columns.${index}.columnKey`, 'Column key must be unique');
    keys.add(column.columnKey);
    counts.push(validateExpression(column.expression, `columns.${index}.expression`));
  });
  return counts;
}

export function validateExpression(expression: ExportExpression, path = 'expression'): number {
  let nodes = 0;
  const visit = (node: ExportExpression, depth: number, nodePath: string): void => {
    nodes += 1;
    if (depth > EXPORT_LIMITS.maxDepth) throw validationError(nodePath, `Expression depth exceeds ${EXPORT_LIMITS.maxDepth}`);
    if (nodes > EXPORT_LIMITS.maxNodes) throw validationError(nodePath, `Expression nodes exceed ${EXPORT_LIMITS.maxNodes}`);
    switch (node.type) {
      case 'field':
        if (!EXPORT_FIELD_KEYS.has(node.field)) throw validationError(`${nodePath}.field`, `Unknown field: ${node.field}`);
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

export function evaluateExpression(
  expression: ExportExpression,
  detail: BazisExportDetail,
  context: ExportEvaluationContext,
  path = 'expression',
): ExportScalar {
  switch (expression.type) {
    case 'field': return resolveExportField(expression.field, detail, context);
    case 'constant': return expression.value;
    case 'empty': return null;
    case 'concat': return checkedString(expression.parts.map((part, index) =>
      toText(evaluateExpression(part, detail, context, `${path}.parts.${index}`))).join(''), path);
    case 'if_else': return evaluateCondition(expression.when, detail, context, `${path}.when`)
      ? evaluateExpression(expression.then, detail, context, `${path}.then`)
      : evaluateExpression(expression.else, detail, context, `${path}.else`);
    case 'string_fn': {
      const value = toText(evaluateExpression(expression.input, detail, context, `${path}.input`));
      const result = expression.fn === 'trim' ? value.trim() : expression.fn === 'upper' ? value.toUpperCase() : value.toLowerCase();
      return checkedString(result, path);
    }
    case 'number_fn': {
      const raw = evaluateExpression(expression.input, detail, context, `${path}.input`);
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
        const value = evaluateExpression(part, detail, context, `${path}.parts.${index}`);
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
): boolean {
  const left = evaluateExpression(condition.left, detail, context, `${path}.left`);
  if (condition.op === 'exists') return left !== null && left !== undefined;
  if (condition.op === 'not_empty') return !isBlank(left);
  const right = evaluateExpression(condition.right!, detail, context, `${path}.right`);
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
