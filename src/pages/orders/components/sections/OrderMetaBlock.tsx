// Order Meta Block (Read-only for show page)
// Minimalist design with gray border

import React from 'react';
import { Typography, Tag } from 'antd';
import { useOne } from '@refinedev/core';
import dayjs from 'dayjs';

const { Text } = Typography;

interface OrderMetaBlockProps {
  record: any;
}

export const OrderMetaBlock: React.FC<OrderMetaBlockProps> = ({ record }) => {
  const formatDate = (date?: string | Date | null) => {
    if (!date) return '—';
    return dayjs(date).format('DD.MM.YYYY HH:mm');
  };

  // Загружаем данные пользователя, создавшего заказ
  const { data: createdByUser } = useOne({
    resource: 'users',
    id: record?.created_by,
    queryOptions: {
      enabled: !!record?.created_by,
    },
  });

  // Загружаем данные пользователя, редактировавшего заказ
  const { data: editedByUser } = useOne({
    resource: 'users',
    id: record?.edited_by,
    queryOptions: {
      enabled: !!record?.edited_by,
    },
  });

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 16,
        padding: '10px 16px',
      }}
    >
        <div>
          <Text style={{ fontSize: 12, color: '#8c8c8c', display: 'block', marginBottom: 4 }}>
            ID заказа
          </Text>
          <Text style={{ fontSize: 13, color: '#262626' }}>
            {record?.order_id || '—'}
          </Text>
        </div>

        <div>
          <Text style={{ fontSize: 12, color: '#8c8c8c', display: 'block', marginBottom: 4 }}>
            Ссылка 1C
          </Text>
          <Text style={{ fontSize: 13, color: '#262626' }}>
            {record?.ref_key_1c || '—'}
          </Text>
        </div>

        <div>
          <Text style={{ fontSize: 12, color: '#8c8c8c', display: 'block', marginBottom: 4 }}>
            Версия
          </Text>
          <Text style={{ fontSize: 13, color: '#262626' }}>
            {record?.version || '—'}
          </Text>
        </div>

        <div>
          <Text style={{ fontSize: 12, color: '#8c8c8c', display: 'block', marginBottom: 4 }}>
            Удалён
          </Text>
          <Tag color={record?.delete_flag ? 'red' : 'green'} style={{ marginTop: 2 }}>
            {record?.delete_flag ? 'Да' : 'Нет'}
          </Tag>
        </div>

        <div>
          <Text style={{ fontSize: 12, color: '#8c8c8c', display: 'block', marginBottom: 4 }}>
            Создан
          </Text>
          <Text style={{ fontSize: 13, color: '#262626' }}>
            {formatDate(record?.created_at)}
          </Text>
        </div>

        <div>
          <Text style={{ fontSize: 12, color: '#8c8c8c', display: 'block', marginBottom: 4 }}>
            Изменён
          </Text>
          <Text style={{ fontSize: 13, color: '#262626' }}>
            {formatDate(record?.updated_at)}
          </Text>
        </div>

        <div>
          <Text style={{ fontSize: 12, color: '#8c8c8c', display: 'block', marginBottom: 4 }}>
            Создал
          </Text>
          <Text style={{ fontSize: 13, color: '#262626' }}>
            {createdByUser?.data?.username || record?.created_by || '—'}
          </Text>
        </div>

        <div>
          <Text style={{ fontSize: 12, color: '#8c8c8c', display: 'block', marginBottom: 4 }}>
            Изменил
          </Text>
          <Text style={{ fontSize: 13, color: '#262626' }}>
            {editedByUser?.data?.username || record?.edited_by || '—'}
          </Text>
        </div>
      </div>
  );
};
