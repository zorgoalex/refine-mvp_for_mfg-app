import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Checkbox, Select, Space, Tag, Typography, message } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Table, Tooltip } from '../../ui/tooltipDelay';
import { inventoryApi } from '../../api/inventoryApi';
import type { InventoryApiError, OnecIssueDto } from '../../api/types/inventoryApi.types';
import { formatMoment, ONEC_ISSUE_HINT, onecIssueDocument, onecIssueLabel, onecRunText } from './onecConsumption';

const { Text } = Typography;
const formatQuantity = (value: number | null) => value == null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(value);

/** «Не учтено из 1С»: строки документов расхода 1С, не попавшие в остатки склада, с причинами. Только чтение + пересчёт. */
export const OnecIssuesTab: React.FC<{
  warehouseId: number | undefined;
  manageAllowed: boolean;
  /** Склад выбирается здесь же (тот же выбор, что на «Остатках»). */
  warehouseOptions: Array<{ value: number; label: string }>;
  onWarehouseChange: (warehouseId: number) => void;
}> = ({ warehouseId, manageAllowed, warehouseOptions, onWarehouseChange }) => {
  const queryClient = useQueryClient();
  const [code, setCode] = useState<string>();
  const [includeBeforeCutoff, setIncludeBeforeCutoff] = useState(false);
  const [page, setPage] = useState({ current: 1, pageSize: 50 });
  const [running, setRunning] = useState(false);
  useEffect(() => { setPage((current) => ({ ...current, current: 1 })); }, [warehouseId, code, includeBeforeCutoff]);
  const issuesQuery = useQuery({
    queryKey: ['inventory', 'onec-issues', warehouseId, code, includeBeforeCutoff, page.current, page.pageSize],
    queryFn: () => inventoryApi.onecIssues({
      warehouseId, code, includeBeforeCutoff: includeBeforeCutoff || undefined,
      offset: (page.current - 1) * page.pageSize, limit: page.pageSize,
    }),
    enabled: warehouseId !== undefined,
    keepPreviousData: true,
  });
  const runNow = async () => {
    setRunning(true);
    try {
      const outcome = onecRunText(await inventoryApi.runOnecConsumption());
      message[outcome.tone](outcome.text);
      await queryClient.invalidateQueries({ queryKey: ['inventory'] });
    } catch (error) {
      message.error((error as InventoryApiError | undefined)?.message ?? 'Не удалось запустить пересчёт');
    } finally { setRunning(false); }
  };
  const counts = issuesQuery.data?.counts ?? [];
  const columns = [
    { title: 'Документ 1С', key: 'doc', render: (_: unknown, row: OnecIssueDto) => <Space direction="vertical" size={0}>
      <Text>{onecIssueDocument(row)}</Text>{row.docAt && <Text type="secondary">{formatMoment(row.docAt)}</Text>}
    </Space> },
    { title: 'Причина', dataIndex: 'code', key: 'code', render: (value: string) => <Tooltip title={ONEC_ISSUE_HINT[value]}><Tag color={value === 'BEFORE_CUTOFF' ? 'default' : 'orange'}>{onecIssueLabel(value)}</Tag></Tooltip> },
    { title: 'Позиция', key: 'item', render: (_: unknown, row: OnecIssueDto) => row.filmName ?? (row.nomenclatureRefKey ? <Tooltip title={`Ключ 1С: ${row.nomenclatureRefKey}`}><Text code>{row.nomenclatureRefKey.slice(0, 8)}…</Text></Tooltip> : '—') },
    { title: 'Кол-во', dataIndex: 'quantity', key: 'quantity', align: 'right' as const, render: formatQuantity },
    { title: 'Обновлено', dataIndex: 'updatedAt', key: 'updatedAt', render: (value: string) => formatMoment(value) },
  ];
  return <Card>
    <Alert style={{ marginBottom: 12 }} type="info" showIcon message="Строки плёнки из документов 1С (реализация, возврат поставщику, списание, перемещение), которые не попали в остатки склада. Прочие материалы (МДФ, фрезеровка) здесь не показываются. Исправленные строки применяются при следующем пересчёте (сам — каждый час и после загрузки документов 1С)." />
    <Space wrap style={{ marginBottom: 12 }}>
      <Select placeholder="Склад" style={{ minWidth: 220 }} value={warehouseId} options={warehouseOptions} onChange={onWarehouseChange} status={warehouseId === undefined ? 'warning' : undefined} />
      <Select allowClear placeholder="Причина" style={{ minWidth: 280 }} value={code} onChange={setCode}
        options={counts.map((row) => ({ value: row.code, label: `${onecIssueLabel(row.code)} (${row.count})` }))} />
      <Checkbox checked={includeBeforeCutoff} onChange={(event) => setIncludeBeforeCutoff(event.target.checked)}>Показать строки до инвентаризации</Checkbox>
      {manageAllowed && <Button loading={running} onClick={() => void runNow()}>Пересчитать сейчас</Button>}
    </Space>
    {issuesQuery.isError && <Alert style={{ marginBottom: 12 }} type="error" showIcon message={(issuesQuery.error as InventoryApiError | undefined)?.message ?? 'Не удалось загрузить строки 1С'} />}
    <Table rowKey="issueId" size="small" dataSource={issuesQuery.data?.items ?? []} columns={columns} loading={issuesQuery.isFetching}
      pagination={{ current: page.current, pageSize: page.pageSize, total: issuesQuery.data?.total ?? 0, showSizeChanger: true, onChange: (current, pageSize) => setPage({ current, pageSize }) }} />
  </Card>;
};
