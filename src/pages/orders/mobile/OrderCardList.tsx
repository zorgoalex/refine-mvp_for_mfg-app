import React from 'react';
import { Card, List, Tag, Typography } from 'antd';
import { StarFilled } from '@ant-design/icons';
import type { TablePaginationConfig } from 'antd';
import { buildOrderCardModel } from './orderCardModel';

export interface OrderCardListProps {
  rows: readonly Record<string, unknown>[];
  loading?: boolean;
  pagination: TablePaginationConfig | false;
  onPageChange: (page: number) => void;
  onOpen: (id: number) => void;
}

export const buildOrderCardPagination = (
  pagination: TablePaginationConfig | false,
  onPageChange: (page: number) => void,
) => {
  if (pagination === false) return false;

  // Table uses an array such as ['bottomRight']; Ant List accepts only
  // 'top' | 'bottom' | 'both'. Passing the table value makes List render no pager.
  const { position: _tablePosition, ...sharedPagination } = pagination;
  return {
    ...sharedPagination,
    position: 'bottom' as const,
    simple: true,
    showSizeChanger: false,
    onChange: onPageChange,
  };
};

export const OrderCardList: React.FC<OrderCardListProps> = ({ rows, loading, pagination, onPageChange, onOpen }) => (
  <List
    dataSource={rows as Record<string, unknown>[]}
    loading={loading}
    pagination={buildOrderCardPagination(pagination, onPageChange)}
    rowKey={(r) => String(r.order_id)}
    renderItem={(row) => {
      const m = buildOrderCardModel(row);
      return (
        <Card
          size="small"
          style={{ marginBottom: 8 }}
          onClick={() => onOpen(m.id)}
          hoverable
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <Typography.Text strong ellipsis style={{ minWidth: 0 }}>
              {m.priority && <StarFilled style={{ color: '#faad14', marginRight: 4 }} />}
              {m.title}
            </Typography.Text>
            <Typography.Text type="secondary">#{m.id}</Typography.Text>
          </div>
          <div style={{ marginTop: 4 }}>
            <Typography.Text ellipsis style={{ display: 'block' }}>{m.client}</Typography.Text>
            <Typography.Text type="secondary" style={{ display: 'block' }}>{m.dates}</Typography.Text>
          </div>
          <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {m.statusTag && <Tag>{m.statusTag}</Tag>}
            {m.paymentTag && <Tag>{m.paymentTag}</Tag>}
            {m.productionTag && <Tag>{m.productionTag}</Tag>}
          </div>
          <Typography.Text strong style={{ display: 'block', marginTop: 6 }}>{m.amountLine}</Typography.Text>
        </Card>
      );
    }}
  />
);
