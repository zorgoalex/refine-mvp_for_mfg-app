import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Input, Modal, Popconfirm, Space, Table, Typography, message } from 'antd';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import { Link } from 'react-router-dom';

import { ordersApi } from '../../api/ordersApi';
import type { OrderListItemDto } from '../../api/types/orderApi.types';
import { featureFlags } from '../../config/featureFlags';
import { formatDate, formatDateTime } from '../../utils/dateFormat';
import { formatNumber } from '../../utils/numberFormat';
import { can } from '../../utils/permissions';
import { makeRestoreHandler } from './orderRestoreAction';

const { Search } = Input;
const { Title } = Typography;

interface TrashPaginationState {
  page: number;
  pageSize: number;
  total: number;
}

const INITIAL_PAGINATION: TrashPaginationState = {
  page: 1,
  pageSize: 20,
  total: 0,
};

const modalConfirm = (content: string): Promise<boolean> =>
  new Promise((resolve) => {
    Modal.confirm({
      title: 'Подтверждение',
      content,
      okText: 'Восстановить',
      cancelText: 'Отмена',
      onOk: () => {
        resolve(true);
      },
      onCancel: () => {
        resolve(false);
      },
    });
  });

export const OrderTrash: React.FC = () => {
  const canManageOrderTrash = !featureFlags.useBackendPermissions || can('orders.delete');
  const [items, setItems] = useState<OrderListItemDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [pagination, setPagination] = useState<TrashPaginationState>(INITIAL_PAGINATION);
  const [restoringOrderId, setRestoringOrderId] = useState<number | null>(null);

  const loadOrders = useCallback(async () => {
    if (!featureFlags.useBackendOrdersRead || !canManageOrderTrash) return;

    setLoading(true);
    try {
      const response = await ordersApi.list({
        deleted: true,
        page: pagination.page,
        pageSize: pagination.pageSize,
        search: search || undefined,
        sortBy: 'deletedAt',
        sortOrder: 'desc',
      });
      setItems(response.data);
      setPagination((current) => ({
        ...current,
        page: response.pagination.page,
        pageSize: response.pagination.pageSize,
        total: response.pagination.total,
      }));
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Не удалось загрузить корзину');
      setItems([]);
      setPagination((current) => ({ ...current, total: 0 }));
    } finally {
      setLoading(false);
    }
  }, [canManageOrderTrash, pagination.page, pagination.pageSize, search]);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  const columns = useMemo<ColumnsType<OrderListItemDto>>(() => {
    const baseColumns: ColumnsType<OrderListItemDto> = [
      {
        dataIndex: 'fullNumber',
        key: 'fullNumber',
        title: 'Заказ',
        render: (_, record) => <Link to={`/orders/show/${record.orderId}`}>{record.fullNumber}</Link>,
      },
      {
        dataIndex: 'clientName',
        key: 'clientName',
        title: 'Клиент',
        render: (value: OrderListItemDto['clientName']) => value ?? '—',
      },
      {
        dataIndex: 'finalAmount',
        key: 'finalAmount',
        title: 'Сумма',
        align: 'right',
        render: (value: OrderListItemDto['finalAmount']) => formatNumber(value as number, 0),
      },
      {
        dataIndex: 'orderDate',
        key: 'orderDate',
        title: 'Дата заказа',
        render: (value: string | null | undefined) => formatDate(value),
      },
      {
        dataIndex: 'deletedAt',
        key: 'deletedAt',
        title: 'Удалён',
        render: (value: string | null | undefined) => formatDateTime(value),
      },
      {
        dataIndex: 'deletedByName',
        key: 'deletedByName',
        title: 'Кем',
        render: (value: OrderListItemDto['deletedByName']) => value ?? '—',
      },
    ];

    if (!featureFlags.useBackendOrdersWrite) {
      return baseColumns;
    }

    return [
      ...baseColumns,
      {
        key: 'actions',
        title: 'Действия',
        render: (_, record) => {
          const handleRestore = makeRestoreHandler({
            restoreFn: (req) => ordersApi.restore(record.orderId, req),
            confirmFn: modalConfirm,
            notify: {
              success: (msg) => message.success(msg),
              warning: (msg) => message.warning(msg),
              error: (msg) => message.error(msg),
            },
            onRestored: () => {
              void loadOrders();
            },
            onStale: () => {
              void loadOrders();
            },
          });

          return (
            <Popconfirm
              title={`Восстановить заказ №${record.orderName}?`}
              okText="Восстановить"
              cancelText="Отмена"
              onConfirm={() => {
                setRestoringOrderId(record.orderId);
                return handleRestore(record.version ?? 0).finally(() => {
                  setRestoringOrderId((current) => (current === record.orderId ? null : current));
                });
              }}
            >
              <Button type="link" loading={restoringOrderId === record.orderId}>
                Восстановить
              </Button>
            </Popconfirm>
          );
        },
      },
    ];
  }, [loadOrders, restoringOrderId]);

  const tablePagination = useMemo<TablePaginationConfig>(
    () => ({
      current: pagination.page,
      pageSize: pagination.pageSize,
      total: pagination.total,
      showSizeChanger: true,
      showTotal: (total) => `Всего: ${total}`,
    }),
    [pagination.page, pagination.pageSize, pagination.total],
  );

  if (!featureFlags.useBackendOrdersRead || !canManageOrderTrash) {
    return <Alert type="warning" message="Недостаточно прав" showIcon />;
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Title level={3} style={{ margin: 0 }}>
          Корзина
        </Title>
        <Card size="small">
          <Search
            value={searchDraft}
            placeholder="Поиск по номеру или клиенту"
            allowClear
            enterButton="Найти"
            onChange={(event) => setSearchDraft(event.target.value)}
            onSearch={(value) => {
              setPagination((current) => ({ ...current, page: 1 }));
              setSearch(value.trim());
            }}
          />
        </Card>
      </Space>

      <Card size="small">
        <Table<OrderListItemDto>
          rowKey="orderId"
          size="small"
          columns={columns}
          dataSource={items}
          loading={loading}
          pagination={tablePagination}
          onChange={(nextPagination) => {
            setPagination((current) => ({
              ...current,
              page: nextPagination.current ?? current.page,
              pageSize: nextPagination.pageSize ?? current.pageSize,
            }));
          }}
          locale={{ emptyText: 'Удалённых заказов нет' }}
        />
      </Card>
    </Space>
  );
};

export default OrderTrash;
