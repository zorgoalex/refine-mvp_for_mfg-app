// Order Dates Block (Read-only for show page)
// Minimalist design with green border

import React from 'react';
import { Typography } from 'antd';
import dayjs from 'dayjs';

const { Text } = Typography;

interface OrderDatesBlockProps {
  record: any;
  compact?: boolean;
}

export const OrderDatesBlock: React.FC<OrderDatesBlockProps> = ({ record, compact = false }) => {
  const formatDate = (date?: string | Date | null) => {
    if (!date) return '—';
    return dayjs(date).format('DD.MM.YYYY');
  };

  return (
    <div style={{ padding: compact ? '4px 8px' : '10px 16px' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: compact ? 8 : 16,
        }}
      >
        <div>
          <Text style={{ fontSize: compact ? 11 : 12, color: '#8c8c8c', display: 'block', marginBottom: compact ? 1 : 4 }}>
            Дата завершения
          </Text>
          <Text style={{ fontSize: compact ? 12 : 13, color: '#262626' }}>
            {formatDate(record?.completion_date)}
          </Text>
        </div>

        <div>
          <Text style={{ fontSize: compact ? 11 : 12, color: '#8c8c8c', display: 'block', marginBottom: compact ? 1 : 4 }}>
            Дата выдачи
          </Text>
          <Text style={{ fontSize: compact ? 12 : 13, color: '#262626' }}>
            {formatDate(record?.issue_date)}
          </Text>
        </div>

        <div>
          <Text style={{ fontSize: compact ? 11 : 12, color: '#8c8c8c', display: 'block', marginBottom: compact ? 1 : 4 }}>
            Дата оплаты
          </Text>
          <Text style={{ fontSize: compact ? 12 : 13, color: '#262626' }}>
            {formatDate(record?.payment_date)}
          </Text>
        </div>
      </div>
    </div>
  );
};
