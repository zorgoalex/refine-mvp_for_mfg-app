// Order Meta Block (Read-only for show page)
// Minimalist design with gray border

import React from 'react';
import { Typography, Tag } from 'antd';
import { useOne } from '../../../../query/orderLifecycleQueries';
import dayjs from 'dayjs';
import { authStorage } from '../../../../utils/auth';
import { canQueryUsersResource } from '../../../../utils/resourcePermissions';

const { Text } = Typography;

interface OrderMetaBlockProps {
  record: any;
  compact?: boolean;
}

export const OrderMetaBlock: React.FC<OrderMetaBlockProps> = ({ record, compact = false }) => {
  const canViewUsers = canQueryUsersResource(authStorage.getUser());

  const formatDate = (date?: string | Date | null) => {
    if (!date) return '—';
    return dayjs(date).format('DD.MM.YYYY HH:mm');
  };

  // Загружаем данные пользователя, создавшего заказ
  const { data: createdByUser } = useOne({
    resource: 'users',
    id: record?.created_by,
    queryOptions: {
      enabled: canViewUsers && !!record?.created_by,
    },
  });

  // Загружаем данные пользователя, редактировавшего заказ
  const { data: editedByUser } = useOne({
    resource: 'users',
    id: record?.edited_by,
    queryOptions: {
      enabled: canViewUsers && !!record?.edited_by,
    },
  });

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
            Создал
          </Text>
          <Text style={{ fontSize: compact ? 12 : 13, color: 'var(--app-text)' }}>
            {createdByUser?.data?.username || record?.created_by || '—'}
          </Text>
        </div>

        <div>
          <Text style={{ fontSize: compact ? 11 : 12, color: 'var(--app-text-muted)', display: 'block', marginBottom: compact ? 1 : 4 }}>
            Изменил
          </Text>
          <Text style={{ fontSize: compact ? 12 : 13, color: 'var(--app-text)' }}>
            {editedByUser?.data?.username || record?.edited_by || '—'}
          </Text>
        </div>
      </div>
  );
};
