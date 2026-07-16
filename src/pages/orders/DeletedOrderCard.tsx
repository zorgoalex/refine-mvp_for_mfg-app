import React from 'react';
import { Alert, Button, Card, Descriptions, Space } from 'antd';

import { formatDate, formatDateTime } from '../../utils/dateFormat';
import { formatNumber } from '../../utils/numberFormat';
import type { DeletedOrderCardModel } from './deletedOrderCard';

interface DeletedOrderCardProps {
  model: DeletedOrderCardModel;
  onRestore: (version: number) => void | Promise<void>;
  canRestore: boolean;
}

export const DeletedOrderCard: React.FC<DeletedOrderCardProps> = ({
  model,
  onRestore,
  canRestore,
}) => (
  <Space direction="vertical" size="middle" style={{ width: '100%' }}>
    <Alert
      type="warning"
      showIcon
      message={`Заказ удалён ${formatDateTime(model.deletedAt)} пользователем ${model.deletedByName ?? '—'}`}
      action={
        canRestore ? (
          <Button type="primary" onClick={() => void onRestore(model.version)}>
            Восстановить
          </Button>
        ) : null
      }
    />

    <Card size="small">
      <Descriptions column={1} bordered size="small">
        <Descriptions.Item label="Номер">{model.orderName}</Descriptions.Item>
        <Descriptions.Item label="Клиент">{model.clientName ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Сумма">
          {model.finalAmount === null ? '—' : formatNumber(model.finalAmount, 0)}
        </Descriptions.Item>
        <Descriptions.Item label="Дата заказа">{formatDate(model.orderDate)}</Descriptions.Item>
        <Descriptions.Item label="Кол-во деталей">{model.detailsCount}</Descriptions.Item>
      </Descriptions>
    </Card>
  </Space>
);
