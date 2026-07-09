// Вкладка «Материалы»: единый список всех материалов ревизии — листовые
// (со сматченным ERP-материалом из справочника), кромки (с суммарной
// длиной), плёнки и фурнитура. Сводка по узлам живёт на вкладке «Дерево».

import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Empty, Spin, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { bazisApi } from '../../api/bazisApi';
import type { BazisRevisionMaterialsSummary } from '../../api/types/bazisApi.types';

interface MaterialsSummaryTabProps {
  revisionId: number;
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

export const MaterialsSummaryTab: React.FC<MaterialsSummaryTabProps> = ({ revisionId }) => {
  const [summary, setSummary] = useState<BazisRevisionMaterialsSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
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
    <Table<MaterialRow>
      size="small"
      columns={columns}
      dataSource={rows}
      pagination={rows.length > 50 ? { pageSize: 50 } : false}
      scroll={{ y: 480 }}
    />
  );
};
