// Order Production Block (Read-only for show page)
// Minimalist design with orange border

import React from 'react';
import { Typography } from 'antd';

const { Text } = Typography;

interface OrderProductionBlockProps {
  record: any;
}

export const OrderProductionBlock: React.FC<OrderProductionBlockProps> = ({ record }) => {
  return (
    <div style={{ padding: '10px 16px' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 16,
        }}
      >
        <div>
          <Text style={{ fontSize: 12, color: '#8c8c8c', display: 'block', marginBottom: 4 }}>
            Тип фрезеровки
          </Text>
          <Text style={{ fontSize: 13, color: '#262626' }}>
            {record?.milling_type_name || '—'}
          </Text>
        </div>

        <div>
          <Text style={{ fontSize: 12, color: '#8c8c8c', display: 'block', marginBottom: 4 }}>
            Тип кромки
          </Text>
          <Text style={{ fontSize: 13, color: '#262626' }}>
            {record?.edge_type_name || '—'}
          </Text>
        </div>

        <div>
          <Text style={{ fontSize: 12, color: '#8c8c8c', display: 'block', marginBottom: 4 }}>
            Плёнка
          </Text>
          <Text style={{ fontSize: 13, color: '#262626' }}>
            {record?.film_name || '—'}
          </Text>
        </div>
      </div>
    </div>
  );
};
