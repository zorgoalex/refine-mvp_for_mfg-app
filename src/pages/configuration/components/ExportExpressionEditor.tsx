import React from 'react';
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Input, InputNumber, Select, Space, Switch, Typography } from 'antd';
import type {
  ExportConditionOperator,
  ExportExpression,
  ExportScalar,
  ExportTemplateColumn,
  ExportTemplateCatalog,
} from '../../../api/exportTemplatesApi';

const { Text } = Typography;
const NODE_OPTIONS: Array<{ value: ExportExpression['type']; label: string }> = [
  { value: 'field', label: 'Поле источника' }, { value: 'column_ref', label: 'Поле строки' },
  { value: 'constant', label: 'Постоянное значение' },
  { value: 'concat', label: 'Склейка строк' }, { value: 'if_else', label: 'Условие IF / ELSE' },
  { value: 'string_fn', label: 'Строковая функция' }, { value: 'number_fn', label: 'Числовая функция' },
  { value: 'math', label: 'Арифметика' }, { value: 'empty', label: 'Пусто' },
];
const OP_LABELS: Record<ExportConditionOperator, string> = {
  exists: 'существует', not_empty: 'не пусто', equals: 'равно', not_equals: 'не равно',
  contains: 'содержит', gt: 'больше', gte: 'больше или равно', lt: 'меньше', lte: 'меньше или равно',
};

export const ExportExpressionEditor: React.FC<{
  value: ExportExpression;
  catalog: ExportTemplateCatalog;
  columns: readonly ExportTemplateColumn[];
  currentColumnKey: string;
  disabled?: boolean;
  depth?: number;
  onChange: (value: ExportExpression) => void;
}> = ({ value, catalog, columns, currentColumnKey, disabled = false, depth = 1, onChange }) => {
  const firstField = catalog.fields[0]?.key ?? 'row.number';
  const fieldOptions = catalog.fields.map((field) => ({ value: field.key, label: `${field.group} · ${field.label}` }));
  const rowColumnOptions = buildRowColumnOptions(columns, currentColumnKey);
  const firstRowColumn = rowColumnOptions.find((option) => !option.disabled)?.value;
  const depthOptions = depth >= 8
    ? NODE_OPTIONS.filter((option) => !['concat', 'if_else', 'string_fn', 'number_fn', 'math'].includes(option.value))
    : NODE_OPTIONS;
  const options = depthOptions.map((option) => option.value === 'column_ref'
    ? { ...option, disabled: !firstRowColumn } : option);
  return (
    <div className="export-expression-editor" data-export-expression={value.type} style={{ background: depth % 2 ? '#fff' : '#f8fafc' }}>
      <div className="export-expression-editor-row">
        <Select className="export-expression-editor-type" value={value.type} options={options} disabled={disabled}
          onChange={(type: ExportExpression['type']) => onChange(defaultExpression(type, firstField, firstRowColumn ?? currentColumnKey))} />
        {value.type === 'field' && <Select showSearch optionFilterProp="label" value={value.field} options={fieldOptions}
          disabled={disabled} className="export-expression-editor-value" onChange={(field) => onChange({ type: 'field', field })} />}
        {value.type === 'column_ref' && <Select showSearch optionFilterProp="label" value={value.columnKey} options={rowColumnOptions}
          disabled={disabled} className="export-expression-editor-value" onChange={(columnKey) => onChange({ type: 'column_ref', columnKey })} />}
        {value.type === 'constant' && <ConstantEditor value={value.value} disabled={disabled}
          onChange={(constant) => onChange({ type: 'constant', value: constant })} />}
        {value.type === 'empty' && <Text type="secondary">В ячейке будет пустое значение.</Text>}
        {(value.type === 'concat' || value.type === 'math') && <PartsEditor expression={value} catalog={catalog}
          columns={columns} currentColumnKey={currentColumnKey} disabled={disabled} depth={depth} onChange={onChange} />}
        {value.type === 'if_else' && <div className="export-expression-editor-compound">
          <Text strong className="export-expression-editor-label">Если</Text>
          <ExportExpressionEditor value={value.when.left} catalog={catalog} columns={columns} currentColumnKey={currentColumnKey} disabled={disabled} depth={depth + 1}
            onChange={(left) => onChange({ ...value, when: { ...value.when, left } })} />
          <Select className="export-expression-editor-operator" value={value.when.op} disabled={disabled}
            options={catalog.operators.map((op) => ({ value: op, label: OP_LABELS[op] }))}
            onChange={(op: ExportConditionOperator) => onChange({ ...value, when: needsRight(op)
              ? { ...value.when, op, right: value.when.right ?? { type: 'constant', value: '' } }
              : { left: value.when.left, op } })} />
          {needsRight(value.when.op) && <ExportExpressionEditor
            value={value.when.right ?? { type: 'constant', value: '' }} catalog={catalog} columns={columns} currentColumnKey={currentColumnKey} disabled={disabled} depth={depth + 1}
            onChange={(right) => onChange({ ...value, when: { ...value.when, right } })} />}
          <Text strong className="export-expression-editor-label">Тогда</Text>
          <ExportExpressionEditor value={value.then} catalog={catalog} columns={columns} currentColumnKey={currentColumnKey} disabled={disabled} depth={depth + 1}
            onChange={(thenValue) => onChange({ ...value, then: thenValue })} />
          <Text strong className="export-expression-editor-label">Иначе</Text>
          <ExportExpressionEditor value={value.else} catalog={catalog} columns={columns} currentColumnKey={currentColumnKey} disabled={disabled} depth={depth + 1}
            onChange={(elseValue) => onChange({ ...value, else: elseValue })} />
        </div>}
        {value.type === 'string_fn' && <>
          <Select className="export-expression-editor-function" value={value.fn} disabled={disabled}
            options={catalog.functions.string.map((fn) => ({ value: fn, label: ({ trim: 'Убрать пробелы по краям', upper: 'ВЕРХНИЙ РЕГИСТР', lower: 'нижний регистр' })[fn] }))}
            onChange={(fn) => onChange({ ...value, fn })} />
          <ExportExpressionEditor value={value.input} catalog={catalog} columns={columns} currentColumnKey={currentColumnKey} disabled={disabled} depth={depth + 1}
            onChange={(input) => onChange({ ...value, input })} />
        </>}
        {value.type === 'number_fn' && <>
          <Space.Compact className="export-expression-editor-number-function">
            <Select value={value.fn} disabled={disabled} style={{ width: '65%' }}
              options={catalog.functions.number.map((fn) => ({ value: fn, label: ({ round: 'Округлить', floor: 'Вниз', ceil: 'Вверх', abs: 'Модуль' })[fn] }))}
              onChange={(fn) => onChange({ ...value, fn })} />
            <InputNumber min={0} max={6} precision={0} value={value.digits ?? 0} disabled={disabled || value.fn !== 'round'}
              addonAfter="знаков" style={{ width: '35%' }} onChange={(digits) => onChange({ ...value, digits: digits ?? 0 })} />
          </Space.Compact>
          <ExportExpressionEditor value={value.input} catalog={catalog} columns={columns} currentColumnKey={currentColumnKey} disabled={disabled} depth={depth + 1}
            onChange={(input) => onChange({ ...value, input })} />
        </>}
      </div>
    </div>
  );
};

const PartsEditor: React.FC<{
  expression: Extract<ExportExpression, { type: 'concat' | 'math' }>;
  catalog: ExportTemplateCatalog;
  columns: readonly ExportTemplateColumn[];
  currentColumnKey: string;
  disabled: boolean;
  depth: number;
  onChange: (value: ExportExpression) => void;
}> = ({ expression, catalog, columns, currentColumnKey, disabled, depth, onChange }) => {
  const firstField = catalog.fields[0]?.key ?? 'row.number';
  return <div className="export-expression-parts">
    {expression.type === 'math' && <Select className="export-expression-editor-function" value={expression.fn} disabled={disabled}
      options={catalog.functions.math.map((fn) => ({ value: fn, label: ({ add: 'Сложить', subtract: 'Вычесть', multiply: 'Умножить', divide: 'Разделить' })[fn] }))}
      onChange={(fn) => onChange({ ...expression, fn })} />}
    {expression.type === 'concat' && <Text type="secondary" className="export-expression-editor-label">Слева направо:</Text>}
    {expression.parts.map((part, index) => <div key={index} className="export-expression-part">
      <ExportExpressionEditor value={part} catalog={catalog} columns={columns} currentColumnKey={currentColumnKey} disabled={disabled} depth={depth + 1}
        onChange={(next) => onChange({ ...expression, parts: expression.parts.map((item, itemIndex) => itemIndex === index ? next : item) })} />
      <Space className="export-expression-part-actions" size={2}>
        <Button size="small" aria-label="Поднять часть" icon={<ArrowUpOutlined />} disabled={disabled || index === 0}
          onClick={() => onChange({ ...expression, parts: move(expression.parts, index, index - 1) })} />
        <Button size="small" aria-label="Опустить часть" icon={<ArrowDownOutlined />} disabled={disabled || index === expression.parts.length - 1}
          onClick={() => onChange({ ...expression, parts: move(expression.parts, index, index + 1) })} />
        <Button size="small" aria-label="Удалить часть" danger icon={<DeleteOutlined />} disabled={disabled || expression.parts.length <= 2}
          onClick={() => onChange({ ...expression, parts: expression.parts.filter((_, itemIndex) => itemIndex !== index) })} />
      </Space>
    </div>)}
    <Button size="small" icon={<PlusOutlined />} disabled={disabled || expression.parts.length >= 20}
      onClick={() => onChange({ ...expression, parts: [...expression.parts, { type: 'field', field: firstField }] })}>Добавить часть</Button>
  </div>;
};

const ConstantEditor: React.FC<{ value: ExportScalar; disabled: boolean; onChange: (value: ExportScalar) => void }> = ({ value, disabled, onChange }) => {
  const kind = value === null ? 'blank' : typeof value;
  return <Space.Compact className="export-expression-constant">
    <Select value={kind} disabled={disabled} style={{ width: 150 }} options={[
      { value: 'string', label: 'Текст' }, { value: 'number', label: 'Число' },
      { value: 'boolean', label: 'Да / нет' }, { value: 'blank', label: 'Пусто' },
    ]} onChange={(next) => onChange(next === 'string' ? '' : next === 'number' ? 0 : next === 'boolean' ? false : null)} />
    {kind === 'string' && <Input value={String(value ?? '')} disabled={disabled} maxLength={10_000} onChange={(event) => onChange(event.target.value)} />}
    {kind === 'number' && <InputNumber value={Number(value)} disabled={disabled} style={{ width: '100%' }} onChange={(next) => onChange(next ?? 0)} />}
    {kind === 'boolean' && <div className="export-expression-boolean">
      <Switch checked={Boolean(value)} disabled={disabled} checkedChildren="Да" unCheckedChildren="Нет" onChange={onChange} />
    </div>}
  </Space.Compact>;
};

function defaultExpression(type: ExportExpression['type'], firstField: string, firstRowColumn: string): ExportExpression {
  if (type === 'field') return { type, field: firstField };
  if (type === 'column_ref') return { type, columnKey: firstRowColumn };
  if (type === 'constant') return { type, value: '' };
  if (type === 'empty') return { type };
  if (type === 'concat') return { type, parts: [{ type: 'field', field: firstField }, { type: 'constant', value: '' }] };
  if (type === 'math') return { type, fn: 'add', parts: [{ type: 'field', field: firstField }, { type: 'constant', value: 0 }] };
  if (type === 'string_fn') return { type, fn: 'trim', input: { type: 'field', field: firstField } };
  if (type === 'number_fn') return { type, fn: 'round', digits: 0, input: { type: 'field', field: firstField } };
  return { type, when: { left: { type: 'field', field: firstField }, op: 'not_empty' },
    then: { type: 'field', field: firstField }, else: { type: 'empty' } };
}

export function buildRowColumnOptions(columns: readonly ExportTemplateColumn[], currentColumnKey: string) {
  return columns.map((column, index) => {
    const isCurrent = column.columnKey === currentColumnKey;
    const createsCycle = !isCurrent && columnDependsOn(columns, column.columnKey, currentColumnKey);
    return {
      value: column.columnKey,
      label: `${index + 1}. ${column.header}${isCurrent ? ' (текущая)' : createsCycle ? ' (создаст цикл)' : ''}`,
      disabled: isCurrent || createsCycle,
    };
  });
}

export function expressionReferencesColumn(expression: ExportExpression, columnKey: string): boolean {
  switch (expression.type) {
    case 'column_ref': return expression.columnKey === columnKey;
    case 'concat':
    case 'math': return expression.parts.some((part) => expressionReferencesColumn(part, columnKey));
    case 'if_else': return expressionReferencesColumn(expression.when.left, columnKey)
      || Boolean(expression.when.right && expressionReferencesColumn(expression.when.right, columnKey))
      || expressionReferencesColumn(expression.then, columnKey)
      || expressionReferencesColumn(expression.else, columnKey);
    case 'string_fn':
    case 'number_fn': return expressionReferencesColumn(expression.input, columnKey);
    case 'field':
    case 'constant':
    case 'empty': return false;
  }
}

function columnDependsOn(
  columns: readonly ExportTemplateColumn[],
  columnKey: string,
  targetColumnKey: string,
  visited = new Set<string>(),
): boolean {
  if (visited.has(columnKey)) return false;
  visited.add(columnKey);
  const column = columns.find((candidate) => candidate.columnKey === columnKey);
  if (!column) return false;
  const references = expressionColumnReferences(column.expression);
  return references.has(targetColumnKey)
    || [...references].some((reference) => columnDependsOn(columns, reference, targetColumnKey, visited));
}

function expressionColumnReferences(expression: ExportExpression): Set<string> {
  switch (expression.type) {
    case 'column_ref': return new Set([expression.columnKey]);
    case 'concat':
    case 'math': return mergeColumnReferences(expression.parts.map(expressionColumnReferences));
    case 'if_else': return mergeColumnReferences([
      expressionColumnReferences(expression.when.left),
      ...(expression.when.right ? [expressionColumnReferences(expression.when.right)] : []),
      expressionColumnReferences(expression.then),
      expressionColumnReferences(expression.else),
    ]);
    case 'string_fn':
    case 'number_fn': return expressionColumnReferences(expression.input);
    case 'field':
    case 'constant':
    case 'empty': return new Set();
  }
}

function mergeColumnReferences(groups: Set<string>[]): Set<string> {
  return new Set(groups.flatMap((group) => [...group]));
}

function needsRight(op: ExportConditionOperator): boolean { return op !== 'exists' && op !== 'not_empty'; }
function move(items: ExportExpression[], from: number, to: number): ExportExpression[] {
  const next = [...items]; const [item] = next.splice(from, 1); next.splice(to, 0, item); return next;
}
