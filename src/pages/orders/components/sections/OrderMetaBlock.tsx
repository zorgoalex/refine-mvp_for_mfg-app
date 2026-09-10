// Order Meta Block (Read-only for show page)
// Minimalist design with gray border

import React from 'react';
import { Typography, Tag } from 'antd';
import dayjs from 'dayjs';

const { Text } = Typography;

interface OrderMetaBlockProps {
  record: any;
  compact?: boolean;
}

export const OrderMetaBlock: React.FC<OrderMetaBlockProps> = ({ record, compact = false }) => {
  const formatDate = (date?: string | Date | null) => {
    if (!date) return '—';
    return dayjs(date).format('DD.MM.YYYY HH:mm');
  };

  const header = record?.__backendOrder?.header;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: compact ? 8 : 16,
        padding: compact ? '4px 8px' : '10px 16px',
      }}
    >
        <div>
          <Text style={{ fontSize: compact ? 11 : 12, color: 'var(--app-text-muted)', display: 'block', marginBottom: compact ? 1 : 4 }}>
            ID заказа
          </Text>
          <Text style={{ fontSize: compact ? 12 : 13, color: 'var(--app-text)' }}>
            {record?.order_id || '—'}
          </Text>
        </div>

        <div>
          <Text style={{ fontSize: compact ? 11 : 12, color: 'var(--app-text-muted)', display: 'block', marginBottom: compact ? 1 : 4 }}>
            Ссылка 1C
          </Text>
          <Text style={{ fontSize: compact ? 12 : 13, color: 'var(--app-text)' }}>
            {record?.ref_key_1c || '—'}
          </Text>
        </div>

        <div>
          <Text style={{ fontSize: compact ? 11 : 12, color: 'var(--app-text-muted)', display: 'block', marginBottom: compact ? 1 : 4 }}>
            Версия
          </Text>
          <Text style={{ fontSize: compact ? 12 : 13, color: 'var(--app-text)' }}>
            {record?.version || '—'}
          </Text>
        </div>

        <div>
          <Text style={{ fontSize: compact ? 11 : 12, color: 'var(--app-text-muted)', display: 'block', marginBottom: compact ? 1 : 4 }}>
            Удалён
          </Text>
          <Tag color={record?.delete_flag ? 'red' : 'green'} style={{ marginTop: compact ? 0 : 2 }}>
            {record?.delete_flag ? 'Да' : 'Нет'}
          </Tag>
        </div>

        <div>
          <Text style={{ fontSize: compact ? 11 : 12, color: 'var(--app-text-muted)', display: 'block', marginBottom: compact ? 1 : 4 }}>
            Создан
          </Text>
          <Text style={{ fontSize: compact ? 12 : 13, color: 'var(--app-text)' }}>
            {formatDate(record?.created_at)}
          </Text>
        </div>

        <div>
          <Text style={{ fontSize: compact ? 11 : 12, color: 'var(--app-text-muted)', display: 'block', marginBottom: compact ? 1 : 4 }}>
            Изменён
          </Text>
          <Text style={{ fontSize: compact ? 12 : 13, color: 'var(--app-text)' }}>
            {formatDate(record?.updated_at)}
          </Text>
        </div>

        <div>
          <Text style={{ fontSize: compact ? 11 : 12, color: 'var(--app-text-muted)', display: 'block', marginBottom: compact ? 1 : 4 }}>
            Создал в ERP
          </Text>
          <Text style={{ fontSize: compact ? 12 : 13, color: 'var(--app-text)' }}>
            {header?.created_by_label || record?.created_by_label || (record?.created_by ? `ERP #${record.created_by}` : '—')}
          </Text>
        </div>

        <div>
          <Text style={{ fontSize: compact ? 11 : 12, color: 'var(--app-text-muted)', display: 'block', marginBottom: compact ? 1 : 4 }}>
            Изменил в ERP
          </Text>
          <Text style={{ fontSize: compact ? 12 : 13, color: 'var(--app-text)' }}>
            {header?.edited_by_label || record?.edited_by_label || (record?.edited_by ? `ERP #${record.edited_by}` : '—')}
          </Text>
        </div>
      </div>
  );
};
