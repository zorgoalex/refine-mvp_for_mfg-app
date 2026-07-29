import React from 'react';
import { Card, List, Typography } from 'antd';
import type { TablePaginationConfig } from 'antd';
import { OrderDeletedTag, ORDER_DELETED_REFERENCE_LINE_CLASS } from '../../../components/OrderDeletedTag';
import { buildPaymentCardModel, PaymentCardLookups } from './paymentCardModel';

export interface PaymentCardListProps {
  rows: readonly Record<string, unknown>[];
  loading?: boolean;
  pagination: TablePaginationConfig | false;
  lookups: PaymentCardLookups;
  onPaginationChange: (page: number, pageSize: number) => void;
  onOpen: (id: number) => void;
}

export const PaymentCardList: React.FC<PaymentCardListProps> = ({ rows, loading, pagination, lookups, onPaginationChange, onOpen }) => (
  <List
    dataSource={rows as Record<string, unknown>[]}
    loading={loading}
    pagination={pagination === false ? false : {
      ...pagination,
      simple: false,
      showLessItems: true,
      showSizeChanger: true,
      onChange: onPaginationChange,
    }}
    rowKey={(r) => String(r.payment_id)}
    renderItem={(row) => {
      const m = buildPaymentCardModel(row, lookups);
      return (
        <Card
          size="small"
          className={m.orderDeleted ? ORDER_DELETED_REFERENCE_LINE_CLASS : undefined}
          style={{ marginBottom: 8 }}
          onClick={() => onOpen(m.id)}
          hoverable
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <Typography.Text strong ellipsis style={{ minWidth: 0 }}>
              {m.orderLabel} <OrderDeletedTag deleted={m.orderDeleted} />
            </Typography.Text>
            <Typography.Text strong>{m.amount}</Typography.Text>
          </div>
          <div style={{ marginTop: 4 }}>
            <Typography.Text type="secondary" style={{ display: 'block' }}>
              {m.typeLabel} · {m.date}
            </Typography.Text>
            {m.notes && (
              <Typography.Text type="secondary" ellipsis style={{ display: 'block' }}>
                {m.notes}
              </Typography.Text>
            )}
          </div>
        </Card>
      );
    }}
  />
);
