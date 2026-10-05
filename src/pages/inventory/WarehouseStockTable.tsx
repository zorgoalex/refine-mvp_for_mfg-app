import React, { useState } from 'react';
import { Alert, Button, Modal, Select, Space, Tag, Typography, message } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Table } from '../../ui/tooltipDelay';
import { sheetMaterialsApi } from '../../api/sheetMaterialsApi';
import type { WarehouseStockDto, WarehouseStockItemDto } from '../../api/types/inventoryApi.types';
import { canLinkRow, linkDecision, linkInput, onecNotices } from './warehouseStock';

const { Text } = Typography;
const formatQuantity = (value: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(value);

interface Props {
  group: string;
  data: WarehouseStockDto | undefined;
  loading: boolean;
  categoryKey: string | undefined;
  onCategoryChange: (key: string | undefined) => void;
  page: { current: number; pageSize: number };
  onPageChange: (current: number, pageSize: number) => void;
  canLink: boolean;
}

/** Вкладки «Все материалы» и материалов 1С: остатки только для просмотра, привязка к листовому материалу ERP. */
export const WarehouseStockTable: React.FC<Props> = ({ group, data, loading, categoryKey, onCategoryChange, page, onPageChange, canLink }) => {
  const queryClient = useQueryClient();
  const [linkItem, setLinkItem] = useState<WarehouseStockItemDto>();
  const [sheetId, setSheetId] = useState<number>();
  const [linking, setLinking] = useState(false);
  const sheetsQuery = useQuery({ queryKey: ['sheet-materials', 'active'], queryFn: () => sheetMaterialsApi.list(false), enabled: Boolean(linkItem) });

  const closeLink = () => { setLinkItem(undefined); setSheetId(undefined); };
  const put = async (item: WarehouseStockItemDto, fresh: Awaited<ReturnType<typeof sheetMaterialsApi.get>>) => {
    try {
      await sheetMaterialsApi.update(fresh.sheetMaterialTypeId, linkInput(fresh, item.itemRefKey!), fresh.version);
      message.success(`«${item.name}» привязана к «${fresh.name}»`);
      closeLink();
      await queryClient.invalidateQueries({ queryKey: ['inventory', 'stock'] });
      await queryClient.invalidateQueries({ queryKey: ['sheet-materials'] });
    } catch (error) {
      const failure = error as { status?: number; message?: string };
      // Материал изменили между чтением и записью: версию не подставляем — перечитать и спросить снова.
      if (failure.status === 409) message.warning('Листовой материал изменился — проверьте выбор и подтвердите ещё раз');
      else message.error(failure.message ?? 'Не удалось привязать позицию');
      await queryClient.invalidateQueries({ queryKey: ['sheet-materials'] });
    }
  };
  const confirmLink = async () => {
    if (!linkItem?.itemRefKey || sheetId === undefined) return;
    const item = linkItem;
    setLinking(true);
    try {
      const fresh = await sheetMaterialsApi.get(sheetId);
      const decision = linkDecision(fresh, item.itemRefKey!);
      if (decision.kind === 'inactive') { message.error(`«${fresh.name}» отключён — выберите другой материал`); return; }
      if (decision.kind === 'already') {
        message.info(`«${fresh.name}» уже привязан к этой позиции 1С`);
        closeLink();
        await queryClient.invalidateQueries({ queryKey: ['inventory', 'stock'] });
        return;
      }
      if (decision.kind === 'confirm_replace') {
        Modal.confirm({
          title: 'Заменить привязку?',
          content: `У «${fresh.name}» уже есть ключ 1С ${decision.currentKey}. Заменить его на позицию «${item.name}»? Прежняя позиция 1С останется без связи.`,
          okText: 'Заменить', cancelText: 'Отмена',
          onOk: () => put(item, fresh),
        });
        return;
      }
      await put(item, fresh);
    } catch (error) {
      message.error((error as { message?: string }).message ?? 'Не удалось прочитать листовой материал');
    } finally { setLinking(false); }
  };

  const columns = [
    ...(group === 'all' ? [{ title: 'Вкладка', dataIndex: 'groupLabel', key: 'groupLabel' }] : []),
    {
      title: 'Наименование', dataIndex: 'name', key: 'name',
      render: (value: string, item: WarehouseStockItemDto) => <Space size={4} wrap>{value}{item.ambiguousLink && <Tag color="orange">несколько материалов ERP</Tag>}</Space>,
    },
    ...(group === 'all'
      ? [{ title: 'Поставщик / категория 1С', key: 'origin', render: (_: unknown, item: WarehouseStockItemDto) => item.vendorName ?? item.categoryName ?? '—' }]
      : [{ title: 'Код 1С', dataIndex: 'code', key: 'code', render: (value: string | null) => value ?? '—' },
        { title: 'Категория 1С', dataIndex: 'categoryName', key: 'categoryName', render: (value: string | null) => value ?? '—' }]),
    { title: 'Остаток', dataIndex: 'quantity', key: 'quantity', align: 'right' as const, render: (value: number) => formatQuantity(value) },
    { title: 'Ед.', dataIndex: 'unitName', key: 'unitName', render: (value: string | null) => value ?? '—' },
    ...(group === 'all' ? [{ title: 'Источник', dataIndex: 'source', key: 'source', render: (value: 'erp' | '1c') => value === 'erp' ? <Tag color="blue">ERP</Tag> : <Tag>1С</Tag> }] : []),
    ...(canLink && (group === 'unlinked' || group === 'all')
      ? [{ title: '', key: 'link', render: (_: unknown, item: WarehouseStockItemDto) => canLinkRow(item)
        ? <Button size="small" onClick={() => setLinkItem(item)}>Привязать к листовому материалу…</Button> : null }]
      : []),
  ];
  const categoryOptions = (data?.categories ?? []).map((category) => ({ value: category.key, label: `${category.name} · ${category.count}` }));

  return <>
    {onecNotices(data?.onec).map((notice) => <Alert key={notice.message} style={{ marginBottom: 8 }} type={notice.type} showIcon message={notice.message} />)}
    {group !== 'all' && categoryOptions.length > 0 && <Space style={{ marginBottom: 12 }}>
      <Select allowClear placeholder="Категория 1С" style={{ minWidth: 260 }} value={categoryKey} options={categoryOptions} onChange={(value) => onCategoryChange(value ?? undefined)} />
    </Space>}
    <Table
      rowKey={(item: WarehouseStockItemDto) => item.source === 'erp' ? `erp:${item.filmId}` : `1c:${item.itemRefKey}`}
      rowClassName={(item: WarehouseStockItemDto) => item.quantity < 0 ? 'film-stock-negative' : ''}
      dataSource={data?.items ?? []} columns={columns} loading={loading}
      pagination={{ current: page.current, pageSize: page.pageSize, total: data?.total ?? 0, showSizeChanger: true, pageSizeOptions: [20, 50, 100, 200], onChange: onPageChange }}
    />
    <Modal title="Привязать позицию 1С к листовому материалу ERP" open={Boolean(linkItem)} onCancel={closeLink} onOk={() => void confirmLink()} okText="Привязать" confirmLoading={linking} okButtonProps={{ disabled: sheetId === undefined }}>
      {linkItem && <Space direction="vertical" style={{ width: '100%' }}>
        <Text>Позиция 1С: <b>{linkItem.name}</b>{linkItem.code ? ` (${linkItem.code})` : ''}</Text>
        <Text type="secondary">После привязки позиция попадёт во вкладку типа материала выбранного листового материала. Изменение сохраняется в справочнике «Листовые материалы».</Text>
        <Select showSearch optionFilterProp="label" placeholder="Листовой материал ERP" style={{ width: '100%' }} loading={sheetsQuery.isLoading}
          value={sheetId} onChange={setSheetId}
          options={(sheetsQuery.data ?? []).filter((sheet) => sheet.isActive).map((sheet) => ({
            value: sheet.sheetMaterialTypeId,
            label: sheet.refKey1c ? `${sheet.name} · уже привязан к другой позиции 1С` : sheet.name,
          }))} />
      </Space>}
    </Modal>
  </>;
};
