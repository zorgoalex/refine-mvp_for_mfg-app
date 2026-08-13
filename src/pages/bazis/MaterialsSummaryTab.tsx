import { Table } from '../../ui/tooltipDelay';
// Вкладка «Материалы»: единый список всех материалов ревизии — листовые
// (со сматченным ERP-материалом из справочника), кромки (с суммарной
// длиной), плёнки и фурнитура. Сводка по узлам живёт на вкладке «Дерево».
// Здесь же — ПОСТ-импортное сопоставление листов: если в визарде выбрали
// «Пропустить» (или маппинга нет), заказ из панелей падает с 422 — чинится
// кнопкой «Сопоставить материалы» без переимпорта.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Empty, Modal, Space, Spin, Tag, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { bazisApi } from '../../api/bazisApi';
import type { BazisRevisionMaterialsSummary } from '../../api/types/bazisApi.types';
import { PAGE_SIZE_OPTIONS, usePageSizePreference } from '../../hooks/usePageSizePreference';
import {
  MaterialMappingStep,
  materialMappingKey,
  type MaterialMappingValue,
  type UnmappedMaterialRow,
} from './MaterialMappingStep';

interface MaterialsSummaryTabProps {
  revisionId: number;
  canManage: boolean;
}

type MaterialKind = 'sheet' | 'edge' | 'film' | 'hardware';

const KIND_LABELS: Record<MaterialKind, { label: string; color: string }> = {
  sheet: { label: 'Листовой материал', color: 'blue' },
  edge: { label: 'Кромка', color: 'orange' },
  film: { label: 'Плёнка', color: 'cyan' },
  hardware: { label: 'Фурнитура', color: 'green' },
};

interface MaterialRow {
  key: string;
  kind: MaterialKind;
  name: string;
  erpMatch: string | null;
  mappingTargetKind: string | null;
  usage: number | null;
  quantity: number | null;
  areaM2: number | null;
  lengthM: number | null;
}

export const MaterialsSummaryTab: React.FC<MaterialsSummaryTabProps> = ({ revisionId, canManage }) => {
  const { pageSize, setPageSize } = usePageSizePreference('bazis:materials-summary', 50);
  const [summary, setSummary] = useState<BazisRevisionMaterialsSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [mappingValues, setMappingValues] = useState<Record<string, MaterialMappingValue>>({});
  const [mappingSaving, setMappingSaving] = useState(false);

  const reload = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setErrorText(null);
    setSummary(null);

    bazisApi.getMaterialsSummary(revisionId)
      .then((response) => {
        if (!cancelled) setSummary(response);
      })
      .catch((error) => {
        if (!cancelled) {
          setErrorText(error instanceof Error ? error.message : 'Не удалось загрузить материалы');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [revisionId]);

  useEffect(() => reload(), [reload]);

  const rows = useMemo<MaterialRow[]>(() => {
    if (!summary) return [];

    const sheets: MaterialRow[] = summary.panelsByMaterial.map((item, index) => ({
      key: `sheet-${index}`,
      kind: 'sheet',
      name: item.materialName ?? '—',
      erpMatch: item.sheetMaterialTypeName
        ?? (item.sheetMaterialTypeId != null ? `#${item.sheetMaterialTypeId}` : null),
      mappingTargetKind: item.mappingTargetKind,
      usage: item.panelCount,
      quantity: item.totalQuantity,
      areaM2: item.totalAreaM2,
      lengthM: null,
    }));

    const edges: MaterialRow[] = summary.edgesByName.map((item, index) => ({
      key: `edge-${index}`,
      kind: 'edge',
      name: item.name,
      erpMatch: null,
      mappingTargetKind: null,
      usage: item.usageCount,
      quantity: null,
      areaM2: null,
      lengthM: item.totalLengthMm != null ? item.totalLengthMm / 1000 : null,
    }));

    const films: MaterialRow[] = summary.filmsByName.map((item, index) => ({
      key: `film-${index}`,
      kind: 'film',
      name: item.name,
      erpMatch: null,
      mappingTargetKind: null,
      usage: item.usageCount,
      quantity: null,
      areaM2: null,
      lengthM: null,
    }));

    const hardware: MaterialRow[] = summary.hardwareByName.map((item, index) => ({
      key: `hw-${index}`,
      kind: 'hardware',
      name: item.name ?? '—',
      erpMatch: null,
      mappingTargetKind: null,
      usage: null,
      quantity: item.totalQuantity,
      areaM2: null,
      lengthM: null,
    }));

    return [...sheets, ...edges, ...films, ...hardware];
  }, [summary]);

  // Листы, требующие внимания: без ERP-соответствия ИЛИ явно пропущенные в
  // визарде («ignore»). Оба состояния валят создание заказа из панелей 422.
  const remappableSheets = useMemo<UnmappedMaterialRow[]>(
    () =>
      rows
        .filter(
          (row) =>
            row.kind === 'sheet'
            && row.name !== '—'
            && (row.mappingTargetKind === 'ignore' || !row.erpMatch),
        )
        .map((row) => ({ name: row.name, kindGuess: 'sheet', usageCount: row.usage ?? 0 })),
    [rows],
  );

  const openMapping = () => {
    // Prefill: пропущенные в визарде показываем как «Пропустить», чтобы было
    // видно текущее состояние; несопоставленные остаются пустыми.
    const initial: Record<string, MaterialMappingValue> = {};
    for (const row of rows) {
      if (row.kind !== 'sheet' || row.name === '—') continue;
      if (row.mappingTargetKind === 'ignore') {
        initial[materialMappingKey({ name: row.name, kindGuess: 'sheet' })] = {
          targetKind: 'ignore',
          targetId: null,
        };
      }
    }
    setMappingValues(initial);
    setMappingOpen(true);
  };

  const handleMappingSave = async () => {
    const incomplete = remappableSheets.some((item) => {
      const value = mappingValues[materialMappingKey(item)];
      return value == null || value.targetKind == null || (value.targetKind !== 'ignore' && value.targetId == null);
    });
    if (incomplete) {
      message.warning('Для каждого материала выберите соответствие или "Пропустить"');
      return;
    }

    setMappingSaving(true);
    try {
      await bazisApi.upsertMaterialMappings(
        remappableSheets.map((item) => {
          const value = mappingValues[materialMappingKey(item)];
          return {
            sourceKind: 'sheet' as const,
            bazisName: item.name,
            targetKind: value.targetKind ?? 'ignore',
            sheetMaterialTypeId: value.targetKind === 'sheet' ? value.targetId : null,
            filmId: null,
            edgeTypeId: null,
          };
        }),
      );
      message.success('Сопоставления сохранены');
      setMappingOpen(false);
      reload();
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось сохранить сопоставления');
    } finally {
      setMappingSaving(false);
    }
  };

  const columns = useMemo<ColumnsType<MaterialRow>>(
    () => [
      {
        title: 'Тип',
        dataIndex: 'kind',
        key: 'kind',
        width: 160,
        filters: Object.entries(KIND_LABELS).map(([value, meta]) => ({ text: meta.label, value })),
        onFilter: (value, row) => row.kind === value,
        render: (kind: MaterialKind) => <Tag color={KIND_LABELS[kind].color}>{KIND_LABELS[kind].label}</Tag>,
      },
      { title: 'Наименование', dataIndex: 'name', key: 'name' },
      {
        title: 'Материал ERP',
        key: 'erp',
        width: 220,
        render: (_, row) => {
          if (row.kind !== 'sheet') return '—';
          if (row.mappingTargetKind === 'ignore') return <Tag>игнор</Tag>;
          if (row.erpMatch) return <Tag color="green">{row.erpMatch}</Tag>;
          return <Tag color="red">не сопоставлен</Tag>;
        },
      },
      { title: 'Вхождений', dataIndex: 'usage', key: 'usage', width: 100, render: (v: number | null) => v ?? '—' },
      { title: 'Кол-во', dataIndex: 'quantity', key: 'quantity', width: 90, render: (v: number | null) => v ?? '—' },
      {
        title: 'Площадь, м²',
        dataIndex: 'areaM2',
        key: 'area',
        width: 110,
        render: (v: number | null) => (v != null ? v.toFixed(2) : '—'),
      },
      {
        title: 'Длина, м',
        dataIndex: 'lengthM',
        key: 'length',
        width: 100,
        render: (v: number | null) => (v != null ? v.toFixed(2) : '—'),
      },
    ],
    [],
  );

  if (errorText) {
    return <Alert type="warning" showIcon message={errorText} />;
  }

  if (loading || !summary) {
    return <Spin />;
  }

  if (rows.length === 0) {
    return <Empty description="В ревизии нет материалов" />;
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {remappableSheets.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`Листовых материалов без ERP-соответствия: ${remappableSheets.length}. Пока они не сопоставлены, создать заказ из панелей с этими материалами нельзя.`}
          action={
            canManage ? (
              <Button size="small" type="primary" onClick={openMapping}>
                Сопоставить материалы
              </Button>
            ) : undefined
          }
        />
      )}
      <Table<MaterialRow>
        size="small"
        columns={columns}
        dataSource={rows}
        pagination={rows.length > pageSize ? {
          pageSize,
          pageSizeOptions: PAGE_SIZE_OPTIONS,
          showSizeChanger: true,
          onShowSizeChange: (_current, nextPageSize) => setPageSize(nextPageSize),
        } : false}
        scroll={{ y: 480 }}
      />

      <Modal
        title="Сопоставление материалов"
        open={mappingOpen}
        onOk={() => void handleMappingSave()}
        onCancel={() => setMappingOpen(false)}
        okText="Сохранить"
        cancelText="Отмена"
        confirmLoading={mappingSaving}
        width={760}
        destroyOnClose
      >
        <MaterialMappingStep
          items={remappableSheets}
          values={mappingValues}
          onChange={(mappingKey, nextValue) =>
            setMappingValues((prev) => ({ ...prev, [mappingKey]: nextValue }))
          }
        />
      </Modal>
    </Space>
  );
};
