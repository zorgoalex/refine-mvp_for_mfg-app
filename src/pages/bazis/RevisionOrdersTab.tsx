import React, { useEffect, useState } from 'react';
import { Alert, Empty, Spin, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Link } from 'react-router-dom';
import { bazisApi } from '../../api/bazisApi';
import type { BazisRevisionOrder } from '../../api/types/bazisApi.types';

interface RevisionOrdersTabProps {
  revisionId: number;
}

const columns: ColumnsType<BazisRevisionOrder> = [
  {
    title: 'ID заказа',
    dataIndex: 'orderId',
    key: 'orderId',
    width: 120,
    render: (value: number) => <Link to={`/orders/show/${value}`}>#{value}</Link>,
  },
  {
    title: 'Название',
    dataIndex: 'orderName',
    key: 'orderName',
    render: (value: string | null) => value ?? '—',
  },
  {
    title: 'Создан',
    dataIndex: 'createdAt',
    key: 'createdAt',
    width: 170,
    render: (value: string) => formatDateTime(value),
  },
  {
    title: 'Узлов замаплено',
    dataIndex: 'nodesMapped',
    key: 'nodesMapped',
    width: 150,
  },
  {
    title: 'Деталей создано',
    dataIndex: 'detailsCreated',
    key: 'detailsCreated',
    width: 150,
  },
];

export const RevisionOrdersTab: React.FC<RevisionOrdersTabProps> = ({ revisionId }) => {
  const [rows, setRows] = useState<BazisRevisionOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadOrders = async () => {
      setLoading(true);
      setErrorText(null);
      try {
        const response = await bazisApi.listRevisionOrders(revisionId);
        if (!cancelled) {
          setRows(response);
        }
      } catch (error) {
        if (!cancelled) {
          setErrorText(error instanceof Error ? error.message : 'Не удалось загрузить заказы ревизии');
          setRows([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadOrders();

    return () => {
      cancelled = true;
    };
  }, [revisionId]);

  if (errorText) {
    return <Alert type="warning" showIcon message={errorText} />;
  }

  if (loading) {
    return <Spin />;
  }

  if (rows.length === 0) {
    return <Empty description="Из этой ревизии заказы не создавались" />;
  }

  return (
    <Table<BazisRevisionOrder>
      rowKey="orderId"
      size="small"
      pagination={false}
      columns={columns}
      dataSource={rows}
    />
  );
};

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}
