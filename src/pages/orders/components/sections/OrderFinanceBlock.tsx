// Order Finance Block (Read-only for show page)
// Minimalist design with gold border

import React from 'react';
import { Typography } from 'antd';
import { formatNumber } from '../../../../utils/numberFormat';
import { CURRENCY_SYMBOL } from '../../../../config/currency';

const { Text } = Typography;

interface OrderFinanceBlockProps {
  record: any;
}

export const OrderFinanceBlock: React.FC<OrderFinanceBlockProps> = ({ record }) => {
  return (
    <div
      style={{
        marginBottom: 16,
        border: '1px solid #faad14',
        borderRadius: 6,
        background: '#FFFFFF',
        padding: '10px 16px',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 16,
        }}
      >
        <div>
          <Text style={{ fontSize: 12, color: '#8c8c8c', display: 'block', marginBottom: 4 }}>
            Менеджер
          </Text>
          <Text style={{ fontSize: 13, color: '#262626' }}>
            {record?.manager_id || '—'}
          </Text>
        </div>

        <div>
          <Text style={{ fontSize: 12, color: '#8c8c8c', display: 'block', marginBottom: 4 }}>
            Оплачено
          </Text>
          <Text strong style={{ fontSize: 13, color: '#262626' }}>
            {formatNumber(record?.paid_amount || 0, 2)} {CURRENCY_SYMBOL}
          </Text>
        </div>
      </div>
    </div>
  );
};
