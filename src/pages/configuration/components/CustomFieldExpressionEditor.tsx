import React from 'react';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { Button, Input, Select, Space, Tooltip, Typography } from 'antd';
import type {
  LabelConditionOperator,
  LabelCustomExpressionNode,
  LabelFieldCatalogItem,
} from '../../../api/types/labelsApi.types';

const { Text } = Typography;

const NODE_OPTIONS: Array<{ value: LabelCustomExpressionNode['type']; label: string }> = [
  { value: 'field', label: 'Поле' },
  { value: 'text', label: 'Фиксированный текст' },
  { value: 'concat', label: 'Склейка значений' },
  { value: 'if_else', label: 'IF / ELSE' },
  { value: 'empty', label: 'Пропустить' },
];

const OPERATOR_OPTIONS: Array<{ value: LabelConditionOperator; label: string }> = [
  { value: 'exists', label: 'существует' },
  { value: 'not_empty', label: 'не пусто' },
  { value: 'equals', label: 'равно' },
  { value: 'not_equals', label: 'не равно' },
];

export interface CustomFieldExpressionEditorProps {
  value: LabelCustomExpressionNode;
  fields: LabelFieldCatalogItem[];
  disabled?: boolean;
  onChange: (value: LabelCustomExpressionNode) => void;
}

export const CustomFieldExpressionEditor: React.FC<CustomFieldExpressionEditorProps> = ({
  value,
  fields,
  disabled = false,
  onChange,
}) => (
  <ExpressionNodeEditor
    value={value}
    fields={fields}
    disabled={disabled}
    depth={1}
    onChange={onChange}
  />
);

interface ExpressionNodeEditorProps extends CustomFieldExpressionEditorProps {
  depth: number;
}

const ExpressionNodeEditor: React.FC<ExpressionNodeEditorProps> = ({
  value,
  fields,
  disabled,
  depth,
  onChange,
}) => {
  const firstField = fields[0]?.id ?? '';
  const fieldOptions = fields.map((field) => ({
    value: field.id,
    label: `${field.category}: ${field.label}`,
  }));
  const nodeOptions = depth >= 8
    ? NODE_OPTIONS.filter((option) => option.value !== 'concat' && option.value !== 'if_else')
    : NODE_OPTIONS;

  return (
    <div
      data-custom-expression-node={value.type}
      style={{
        padding: 12,
        borderRadius: 8,
        background: depth % 2 === 0 ? '#f5f7fa' : '#fafafa',
        borderLeft: depth > 1 ? '2px solid #d9d9d9' : undefined,
      }}
    >
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Select
          value={value.type}
          disabled={disabled}
          options={nodeOptions}
          style={{ width: 210 }}
          onChange={(type: LabelCustomExpressionNode['type']) => onChange(defaultNode(type, firstField))}
        />

        {value.type === 'field' && (
          <Select
            showSearch
            optionFilterProp="label"
            value={value.field || undefined}
            placeholder="Выберите поле"
            disabled={disabled}
            options={fieldOptions}
            style={{ width: '100%' }}
            onChange={(field) => onChange({ type: 'field', field })}
          />
        )}

        {value.type === 'text' && (
          <Input.TextArea
            value={value.value}
            disabled={disabled}
            maxLength={1000}
            showCount
            autoSize={{ minRows: 2, maxRows: 5 }}
            placeholder="Введите фиксированный текст, включая нужные пробелы и разделители"
            onChange={(event) => onChange({ type: 'text', value: event.target.value })}
          />
        )}

        {value.type === 'concat' && (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Text type="secondary">Части склеиваются слева направо без автоматических пробелов.</Text>
            {value.parts.map((part, index) => (
              <div key={index} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8 }}>
                <ExpressionNodeEditor
                  value={part}
                  fields={fields}
                  disabled={disabled}
                  depth={depth + 1}
                  onChange={(nextPart) => onChange({
                    type: 'concat',
                    parts: value.parts.map((current, partIndex) => (partIndex === index ? nextPart : current)),
                  })}
                />
                <Space direction="vertical" size={2}>
                  <Tooltip title="Поднять">
                    <Button
                      type="text"
                      size="small"
                      aria-label="Поднять часть"
                      icon={<ArrowUpOutlined />}
                      disabled={disabled || index === 0}
                      onClick={() => onChange({ type: 'concat', parts: movePart(value.parts, index, index - 1) })}
                    />
                  </Tooltip>
                  <Tooltip title="Опустить">
                    <Button
                      type="text"
                      size="small"
                      aria-label="Опустить часть"
                      icon={<ArrowDownOutlined />}
                      disabled={disabled || index === value.parts.length - 1}
                      onClick={() => onChange({ type: 'concat', parts: movePart(value.parts, index, index + 1) })}
                    />
                  </Tooltip>
                  <Tooltip title="Удалить часть">
                    <Button
                      type="text"
                      size="small"
                      danger
                      aria-label="Удалить часть"
                      icon={<DeleteOutlined />}
                      disabled={disabled || value.parts.length === 1}
                      onClick={() => onChange({
                        type: 'concat',
                        parts: value.parts.filter((_, partIndex) => partIndex !== index),
                      })}
                    />
                  </Tooltip>
                </Space>
              </div>
            ))}
            <Button
              icon={<PlusOutlined />}
              disabled={disabled || value.parts.length >= 20}
              onClick={() => onChange({
                type: 'concat',
                parts: [...value.parts, defaultNode('field', firstField)],
              })}
            >
              Добавить часть
            </Button>
          </Space>
        )}

        {value.type === 'if_else' && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <div>
              <Text strong>Если</Text>
              <Space.Compact block style={{ marginTop: 6 }}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  value={value.when.field || undefined}
                  placeholder="Поле условия"
                  disabled={disabled}
                  options={fieldOptions}
                  style={{ width: '60%' }}
                  onChange={(field) => onChange({ ...value, when: { ...value.when, field } })}
                />
                <Select
                  value={value.when.op}
                  disabled={disabled}
                  options={OPERATOR_OPTIONS}
                  style={{ width: '40%' }}
                  onChange={(op: LabelConditionOperator) => onChange({
                    ...value,
                    when: op === 'equals' || op === 'not_equals'
                      ? { field: value.when.field, op, value: value.when.value ?? '' }
                      : { field: value.when.field, op },
                  })}
                />
              </Space.Compact>
              {(value.when.op === 'equals' || value.when.op === 'not_equals') && (
                <Input
                  value={String(value.when.value ?? '')}
                  disabled={disabled}
                  maxLength={1000}
                  placeholder="Значение для сравнения"
                  style={{ marginTop: 8 }}
                  onChange={(event) => onChange({
                    ...value,
                    when: { ...value.when, value: event.target.value },
                  })}
                />
              )}
            </div>
            <BranchEditor
              title="Тогда"
              value={value.then}
              fields={fields}
              disabled={disabled}
              depth={depth + 1}
              onChange={(thenNode) => onChange({ ...value, then: thenNode })}
            />
            <BranchEditor
              title="Иначе"
              value={value.else}
              fields={fields}
              disabled={disabled}
              depth={depth + 1}
              onChange={(elseNode) => onChange({ ...value, else: elseNode })}
            />
          </Space>
        )}

        {value.type === 'empty' && <Text type="secondary">Поле вернёт пустую строку.</Text>}
      </Space>
    </div>
  );
};

const BranchEditor: React.FC<ExpressionNodeEditorProps & { title: string }> = ({ title, ...props }) => (
  <div>
    <Text strong>{title}</Text>
    <div style={{ marginTop: 6 }}>
      <ExpressionNodeEditor {...props} />
    </div>
  </div>
);

function defaultNode(type: LabelCustomExpressionNode['type'], firstField: string): LabelCustomExpressionNode {
  if (type === 'field') return { type: 'field', field: firstField };
  if (type === 'text') return { type: 'text', value: '' };
  if (type === 'empty') return { type: 'empty' };
  if (type === 'concat') {
    return {
      type: 'concat',
      parts: [
        { type: 'field', field: firstField },
        { type: 'text', value: '' },
      ],
    };
  }
  return {
    type: 'if_else',
    when: { field: firstField, op: 'not_empty' },
    then: { type: 'field', field: firstField },
    else: { type: 'empty' },
  };
}

function movePart(
  parts: LabelCustomExpressionNode[],
  from: number,
  to: number,
): LabelCustomExpressionNode[] {
  const next = [...parts];
  const [part] = next.splice(from, 1);
  next.splice(to, 0, part);
  return next;
}
