import React from 'react';
import { Alert, Card, Select, Space, Table, Tag, Typography } from 'antd';
import type { SheetMaterialReferenceItem } from '../types/importTypes';
import type { PdfGenericTable, PdfUnresolvedLineAction } from '../utils/pdfGenericTable';
import type { PdfLayoutMapping, PdfLayoutTarget } from '../utils/pdfLayoutPattern';
import {
  collectPdfSectionMaterials,
  pdfSectionMaterialKey,
  resolvePdfSectionMaterialId,
  type PdfSectionMaterialOverrides,
} from '../utils/pdfSectionMaterialMapping';
import type { PdfPatternMatch } from '../api/pdfTablePatternsApi';

const { Text } = Typography;
const TARGETS: Array<{ value: PdfLayoutTarget; label: string }> = [
  { value: 'position', label: '№ позиции' },
  { value: 'designation', label: 'Обозначение' },
  { value: 'basis_project', label: 'Базис проект / № заказа' },
  { value: 'basis_product', label: 'Изделие' },
  { value: 'name', label: 'Наименование' },
  { value: 'quantity', label: 'Количество' },
  { value: 'compound_size', label: 'Размер (Д × Ш)' },
  { value: 'length', label: 'Длина / высота' },
  { value: 'width', label: 'Ширина' },
  { value: 'material', label: 'Материал' },
  { value: 'milling', label: 'Фрезеровка' },
  { value: 'film', label: 'Плёнка' },
  { value: 'note', label: 'Примечание' },
  { value: 'ignore', label: 'Игнорировать' },
];

interface Props {
  tables: PdfGenericTable[];
  mappings: Record<string, PdfLayoutMapping>;
  matches: PdfPatternMatch[];
  issues: string[];
  sheetMaterialTypes: SheetMaterialReferenceItem[];
  sheetMaterialTypesLoading: boolean;
  sectionMaterialOverrides: PdfSectionMaterialOverrides;
  onTargetChange: (tableId: string, columnIndex: number, target: PdfLayoutTarget) => void;
  onSectionMaterialMappingChange: (sourceName: string, materialId: number) => void;
  onGeometryCandidateRoleChange: (tableId: string, role: 'header' | 'data') => void;
  onUnresolvedLineAction: (
    tableId: string,
    lineIndex: number,
    action: PdfUnresolvedLineAction,
  ) => void;
}

export const PdfLayoutMappingStep: React.FC<Props> = ({
  tables, mappings, matches, issues, onTargetChange, onGeometryCandidateRoleChange,
  onUnresolvedLineAction, sheetMaterialTypes, sheetMaterialTypesLoading,
  sectionMaterialOverrides, onSectionMaterialMappingChange,
}) => {
  const uniqueTables = tables.filter((table, index, all) =>
    all.findIndex(candidate => JSON.stringify(candidate.signature) === JSON.stringify(table.signature)) === index);
  const cuttableMaterialOptions = sheetMaterialTypes
    .filter(item => item.isCuttable !== false)
    .map(item => ({ value: item.id, label: item.name }));
  return (
  <Space direction="vertical" size="middle" style={{ width: '100%', overflow: 'auto', maxHeight: '100%' }}>
    <Alert
      type="info"
      showIcon
      message="Неизвестная структура PDF"
      description="Сопоставьте колонки один раз. Сохранится только структурный паттерн: заголовки и относительная геометрия. PDF и значения строк не сохраняются."
    />
    {issues.length > 0 && (
      <Alert type="error" showIcon message="Сопоставление не готово" description={issues.join('; ')} />
    )}
    {uniqueTables.map((table, uniqueIndex) => {
      const tableIndex = tables.indexOf(table);
      const mapping = mappings[table.id];
      const match = matches.find(item => item.index === tableIndex);
      const signature = JSON.stringify(table.signature);
      const occurrences = tables.filter(candidate =>
        JSON.stringify(candidate.signature) === signature);
      const sectionMaterials = collectPdfSectionMaterials(occurrences);
      return (
        <Card
          key={table.id}
          size="small"
          title={`Уникальный layout ${uniqueIndex + 1}, впервые на стр. ${table.pageNumber}`}
          extra={
            match?.pattern
              ? <Tag color={match.requiresConfirmation ? 'gold' : 'green'}>
                  {match.requiresConfirmation ? 'Ожидает подтверждения' : 'Паттерн известен'}
                </Tag>
              : <Tag>Новый паттерн</Tag>
          }
        >
          {sectionMaterials.length > 0 && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="Материалы секций"
              description={
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Text type="secondary" style={{ fontSize: 12, textWrap: 'pretty' }}>
                    Проверьте материал, найденный над таблицей. Выбор действует только
                    для текущего импорта и не сохраняется в layout-паттерне.
                  </Text>
                  {sectionMaterials.map(material => {
                    const materialKey = pdfSectionMaterialKey(material.sourceName);
                    const overrideId = sectionMaterialOverrides[materialKey];
                    const resolvedId = resolvePdfSectionMaterialId(
                      material.sourceName,
                      sectionMaterialOverrides,
                      sheetMaterialTypes,
                    );
                    const status = overrideId
                      ? { color: 'blue', label: 'Выбрано вручную' }
                      : resolvedId
                        ? { color: 'green', label: 'Автосопоставлено' }
                        : sheetMaterialTypesLoading
                          ? { color: 'default', label: 'Загрузка справочника' }
                          : { color: 'orange', label: 'Нужно выбрать' };
                    return (
                      <div
                        key={materialKey}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'minmax(170px, 1fr) 24px minmax(260px, 1.4fr) auto',
                          gap: 8,
                          alignItems: 'center',
                        }}
                      >
                        <Space direction="vertical" size={0}>
                          <Text strong>{material.sourceName}</Text>
                          <Text
                            type="secondary"
                            style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}
                          >
                            Стр. {material.pageNumbers.join(', ')} · строк деталей: {material.rowCount}
                          </Text>
                        </Space>
                        <Text type="secondary" style={{ textAlign: 'center' }}>→</Text>
                        <Select
                          value={resolvedId ?? undefined}
                          loading={sheetMaterialTypesLoading}
                          placeholder="Выберите материал справочника"
                          options={cuttableMaterialOptions}
                          showSearch
                          optionFilterProp="label"
                          onChange={(materialId: number) =>
                            onSectionMaterialMappingChange(material.sourceName, materialId)}
                        />
                        <Tag color={status.color}>{status.label}</Tag>
                      </div>
                    );
                  })}
                </Space>
              }
            />
          )}
          {table.geometryCandidateCells && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="Нужно классифицировать первую строку"
              description={
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Text>{table.geometryCandidateCells.filter(Boolean).join(' · ')}</Text>
                  <Select
                    placeholder="Это заголовок или данные?"
                    style={{ width: 260 }}
                    value={mapping?.geometryCandidateRole}
                    options={[
                      { value: 'header', label: 'Заголовок колонок' },
                      { value: 'data', label: 'Первая строка данных' },
                    ]}
                    onChange={(role: 'header' | 'data') =>
                      onGeometryCandidateRoleChange(table.id, role)}
                  />
                </Space>
              }
            />
          )}
          {occurrences.flatMap(occurrence =>
            occurrence.unresolvedLines.map((cells, lineIndex) => (
            <Alert
              key={`${occurrence.id}-unresolved-${lineIndex}`}
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message={`Нераспознанная строка ${lineIndex + 1}, стр. ${occurrence.pageNumber}`}
              description={
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Text>{cells.filter(Boolean).join(' · ')}</Text>
                  <Select
                    placeholder="Выберите действие"
                    style={{ width: 320 }}
                    options={[
                      { value: 'ignore', label: 'Игнорировать эту строку' },
                      { value: 'row', label: 'Считать отдельной строкой данных' },
                      ...occurrence.rows.map((_, rowIndex) => ({
                        value: `attach:${rowIndex}`,
                        label: `Присоединить к строке данных ${rowIndex + 1}`,
                      })),
                    ]}
                    onChange={(value: string) => {
                      const action: PdfUnresolvedLineAction = value.startsWith('attach:')
                        ? { kind: 'attach', rowIndex: Number(value.split(':')[1]) }
                        : { kind: value as 'ignore' | 'row' };
                      onUnresolvedLineAction(occurrence.id, lineIndex, action);
                    }}
                  />
                </Space>
              }
            />
          )))}
          <Table
            size="small"
            pagination={false}
            rowKey={(_, index) => String(index)}
            dataSource={table.columns.map((column, index) => ({
              index,
              header: column.header,
              samples: table.rows.slice(0, 3).map(row => row[index]).filter(Boolean).join(' · '),
            }))}
            columns={[
              { title: 'Колонка PDF', dataIndex: 'header', width: 180 },
              {
                title: 'Пример',
                dataIndex: 'samples',
                ellipsis: true,
                render: (value: string) => <Text type="secondary">{value || '—'}</Text>,
              },
              {
                title: 'Поле заказа',
                width: 220,
                render: (_: unknown, row: { index: number }) => (
                  <Select
                    style={{ width: '100%' }}
                    options={TARGETS}
                    value={mapping?.columns.find(item => item.columnIndex === row.index)?.target ?? 'ignore'}
                    onChange={(target: PdfLayoutTarget) => onTargetChange(table.id, row.index, target)}
                  />
                ),
              },
            ]}
          />
        </Card>
      );
    })}
  </Space>
  );
};
