import { Table } from '../../ui/tooltipDelay';
import React, { useMemo } from 'react';
import { useList } from '@refinedev/core';
import { Alert, Select, Space, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { createBackendSelectProps, useOrderFormData, type ReferenceOption, type SheetMaterialTypeOption } from '../../hooks/useOrderFormData';

const { Text } = Typography;

export interface MaterialMappingValue {
  targetKind: 'sheet' | 'film' | 'edge' | 'ignore' | null;
  targetId: number | null;
}

export interface UnmappedMaterialRow {
  name: string;
  kindGuess: string;
  usageCount: number;
}

/**
 * Ключ строки/state — пара (контекст, имя), как ключ маппинга в БД
 * (source_kind, lower(bazis_name)): одинаковое имя в разных контекстах
 * маппится независимо (Critic 2026-07-08 finding 1).
 */
const KIND_GUESS_LABELS_RU: Record<string, string> = {
  sheet: 'Лист',
  film: 'Плёнка',
  edge: 'Кромка',
  hardware: 'Фурнитура',
};

export function materialMappingKey(row: Pick<UnmappedMaterialRow, 'name' | 'kindGuess'>): string {
  return `${row.kindGuess}:${row.name.toLowerCase()}`;
}

interface MaterialMappingStepProps {
  items: UnmappedMaterialRow[];
  /** Keyed by materialMappingKey(row) — НЕ по одному имени. */
  values: Record<string, MaterialMappingValue>;
  onChange: (mappingKey: string, nextValue: MaterialMappingValue) => void;
}

interface SheetMaterialRecord {
  sheet_material_type_id: number;
  name: string;
  is_cuttable: boolean | null;
}

interface FilmRecord {
  film_id: number;
  film_name: string;
}

interface EdgeTypeRecord {
  edge_type_id: number;
  edge_type_name: string;
}

export const MaterialMappingStep: React.FC<MaterialMappingStepProps> = ({
  items,
  values,
  onChange,
}) => {
  const orderFormData = useOrderFormData();
  const useBackendReferences = orderFormData.enabled;

  const { data: sheetMaterialTypesData } = useList<SheetMaterialRecord>({
    resource: 'sheet_material_types',
    pagination: { pageSize: 10000 },
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    meta: { fields: ['sheet_material_type_id', 'name', 'is_cuttable'] },
    queryOptions: { enabled: !useBackendReferences },
  });

  const { data: filmsData } = useList<FilmRecord>({
    resource: 'films',
    pagination: { pageSize: 10000 },
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    queryOptions: { enabled: !useBackendReferences },
  });

  const { data: edgeTypesData } = useList<EdgeTypeRecord>({
    resource: 'edge_types',
    pagination: { pageSize: 10000 },
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    queryOptions: { enabled: !useBackendReferences },
  });

  const sheetOptions = useMemo(() => {
    if (useBackendReferences) {
      return orderFormData.references.sheetMaterialTypes
        .filter((item) => item.isCuttable)
        .map(toOption);
    }

    return (sheetMaterialTypesData?.data ?? [])
      .filter((item) => item.is_cuttable !== false)
      .map((item) => ({ value: item.sheet_material_type_id, label: item.name }));
  }, [
    orderFormData.references.sheetMaterialTypes,
    sheetMaterialTypesData?.data,
    useBackendReferences,
  ]);

  const filmOptions = useMemo(() => {
    if (useBackendReferences) {
      return orderFormData.references.films;
    }

    return (filmsData?.data ?? []).map((item) => ({ value: item.film_id, label: item.film_name }));
  }, [filmsData?.data, orderFormData.references.films, useBackendReferences]);

  const edgeOptions = useMemo(() => {
    if (useBackendReferences) {
      return orderFormData.references.edgeTypes;
    }

    return (edgeTypesData?.data ?? []).map((item) => ({ value: item.edge_type_id, label: item.edge_type_name }));
  }, [edgeTypesData?.data, orderFormData.references.edgeTypes, useBackendReferences]);

  const columns = useMemo<ColumnsType<UnmappedMaterialRow>>(
    () => [
      {
        title: 'Материал Базиса',
        dataIndex: 'name',
        key: 'name',
      },
      {
        title: 'Тип',
        dataIndex: 'kindGuess',
        key: 'kindGuess',
        width: 110,
        render: (value: string) => KIND_GUESS_LABELS_RU[value] ?? value,
      },
      {
        title: 'Использований',
        dataIndex: 'usageCount',
        key: 'usageCount',
        width: 120,
      },
      {
        title: 'Цель',
        key: 'target',
        render: (_, record) => {
          const sourceKind = normalizeKind(record.kindGuess);
          const options = sourceKind === 'sheet'
            ? sheetOptions
            : sourceKind === 'film'
              ? filmOptions
              : sourceKind === 'edge'
                ? edgeOptions
                : [];
          const currentValue = values[materialMappingKey(record)];

          if (sourceKind == null) {
            return <Text type="warning">Неизвестный kindGuess: {record.kindGuess}</Text>;
          }

          return (
            <Select
              style={{ width: '100%' }}
              showSearch
              optionFilterProp="label"
              placeholder="Выберите соответствие"
              value={currentValue?.targetKind === 'ignore' ? 'ignore' : currentValue?.targetId ?? undefined}
              options={[
                { value: 'ignore', label: 'Пропустить' },
                ...options,
              ]}
              onChange={(value) => {
                if (value === 'ignore') {
                  onChange(materialMappingKey(record), { targetKind: 'ignore', targetId: null });
                  return;
                }

                const numericValue = Number(value);
                onChange(materialMappingKey(record), {
                  targetKind: sourceKind,
                  targetId: Number.isInteger(numericValue) ? numericValue : null,
                });
              }}
            />
          );
        },
      },
    ],
    [edgeOptions, filmOptions, onChange, sheetOptions, values],
  );

  if (useBackendReferences && orderFormData.error) {
    return <Alert type="warning" showIcon message={orderFormData.error.message} />;
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="Сопоставьте материалы Базиса со справочниками ERP или явно пропустите ненужные позиции."
      />
      <Table
        rowKey={(record) => materialMappingKey(record)}
        pagination={false}
        columns={columns}
        dataSource={items}
      />
    </Space>
  );
};

function toOption(item: ReferenceOption | SheetMaterialTypeOption): ReferenceOption {
  return {
    label: item.label,
    value: item.value,
  };
}

function normalizeKind(value: string): 'sheet' | 'film' | 'edge' | null {
  if (value === 'sheet' || value === 'film' || value === 'edge') {
    return value;
  }

  return null;
}
