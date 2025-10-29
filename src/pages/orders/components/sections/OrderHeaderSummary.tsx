// Order Header Summary (Read-only)
// Displays key order information at the top: Client, Status, Dates, Aggregates

import React from 'react';
import { Card, Descriptions, Statistic, Row, Col, Tag, Space } from 'antd';
import { useOne } from '@refinedev/core';
import { useOrderFormStore, selectTotals } from '../../../../stores/orderFormStore';
import { useShallow } from 'zustand/react/shallow';
import { formatNumber } from '../../../../utils/numberFormat';
import dayjs from 'dayjs';

export const OrderHeaderSummary: React.FC = () => {
  const { header } = useOrderFormStore();
  const totals = useOrderFormStore(useShallow(selectTotals));

  // Load client name
  const { data: clientData } = useOne({
    resource: 'clients',
    id: header.client_id,
    queryOptions: {
      enabled: !!header.client_id,
    },
  });

  // Load order status
  const { data: orderStatusData } = useOne({
    resource: 'order_statuses',
    id: header.order_status_id,
    queryOptions: {
      enabled: !!header.order_status_id,
    },
  });

  // Load payment status
  const { data: paymentStatusData } = useOne({
    resource: 'payment_statuses',
    id: header.payment_status_id,
    queryOptions: {
      enabled: !!header.payment_status_id,
    },
  });

  // Load manager name
  const { data: managerData } = useOne({
    resource: 'employees',
    id: header.manager_id,
    queryOptions: {
      enabled: !!header.manager_id,
    },
  });

  return (
    <Card size="small" style={{ marginBottom: 16 }}>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {/* Main Info */}
        <Descriptions column={4} size="small" bordered>
          <Descriptions.Item label="Клиент" span={2}>
            <strong>{clientData?.data?.client_name || '—'}</strong>
          </Descriptions.Item>
          <Descriptions.Item label="Название заказа" span={2}>
            <strong>{header.order_name || '—'}</strong>
          </Descriptions.Item>

          <Descriptions.Item label="Дата заказа">
            {header.order_date ? dayjs(header.order_date).format('DD.MM.YYYY') : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="Менеджер">
            {managerData?.data?.full_name || '—'}
          </Descriptions.Item>
          <Descriptions.Item label="Приоритет">
            {header.priority !== undefined ? formatNumber(header.priority, 0) : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="Статус заказа">
            <Tag color="blue">{orderStatusData?.data?.order_status_name || '—'}</Tag>
          </Descriptions.Item>

          <Descriptions.Item label="Плановая дата">
            {header.planned_completion_date
              ? dayjs(header.planned_completion_date).format('DD.MM.YYYY')
              : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="Дата завершения">
            {header.completion_date ? dayjs(header.completion_date).format('DD.MM.YYYY') : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="Дата выдачи">
            {header.issue_date ? dayjs(header.issue_date).format('DD.MM.YYYY') : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="Статус оплаты">
            <Tag color="green">{paymentStatusData?.data?.payment_status_name || '—'}</Tag>
          </Descriptions.Item>
        </Descriptions>

        {/* Aggregates and Finance - compact row with smaller font */}
        <Row gutter={12} style={{ fontSize: '13px' }}>
          <Col span={3}>
            <Statistic
              title="Позиций"
              value={formatNumber(totals.positions_count, 0)}
              suffix="поз"
              valueStyle={{ fontSize: '18px' }}
            />
          </Col>
          <Col span={3}>
            <Statistic
              title="Деталей"
              value={formatNumber(totals.parts_count, 0)}
              suffix="шт"
              valueStyle={{ fontSize: '18px' }}
            />
          </Col>
          <Col span={3}>
            <Statistic
              title="Площадь"
              value={formatNumber(totals.total_area, 2)}
              suffix="м²"
              valueStyle={{ fontSize: '18px' }}
            />
          </Col>
          <Col span={4}>
            <Statistic
              title="Сумма"
              value={formatNumber(header.total_amount || 0, 2)}
              suffix="₽"
              valueStyle={{ fontSize: '18px' }}
            />
          </Col>
          <Col span={3}>
            <Statistic
              title="Скидка"
              value={formatNumber(header.discount || 0, 2)}
              suffix="%"
              valueStyle={{ fontSize: '18px' }}
            />
          </Col>
          <Col span={4}>
            <Statistic
              title="Со скидкой"
              value={formatNumber(header.discounted_amount || 0, 2)}
              suffix="₽"
              valueStyle={{ fontSize: '18px' }}
            />
          </Col>
          <Col span={4}>
            <Statistic
              title="Оплачено"
              value={formatNumber(totals.total_paid, 2)}
              suffix="₽"
              valueStyle={{ fontSize: '18px', color: totals.total_paid > 0 ? '#3f8600' : undefined }}
            />
          </Col>
        </Row>
      </Space>
    </Card>
  );
};
