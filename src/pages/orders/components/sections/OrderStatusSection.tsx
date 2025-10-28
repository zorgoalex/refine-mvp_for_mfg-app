// Order Status Section
// Contains: Order Status, Payment Status

import React from 'react';
import { Form, Row, Col, Select } from 'antd';
import { useSelect } from '@refinedev/antd';
import { useOrderFormStore } from '../../../../stores/orderFormStore';

export const OrderStatusSection: React.FC = () => {
  const { header, updateHeaderField } = useOrderFormStore();

  // Load order statuses
  const { selectProps: orderStatusProps } = useSelect({
    resource: 'order_statuses',
    optionLabel: 'order_status_name',
    optionValue: 'order_status_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
  });

  // Load payment statuses
  const { selectProps: paymentStatusProps } = useSelect({
    resource: 'payment_statuses',
    optionLabel: 'payment_status_name',
    optionValue: 'payment_status_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
  });

  return (
    <Form layout="vertical">
      <Row gutter={16}>
        <Col span={12}>
          <Form.Item
            label="Статус заказа"
            required
            help={!header.order_status_id && 'Обязательное поле'}
            validateStatus={!header.order_status_id ? 'error' : ''}
          >
            <Select
              {...orderStatusProps}
              value={header.order_status_id}
              onChange={(value) => updateHeaderField('order_status_id', value)}
              placeholder="Выберите статус заказа"
            />
          </Form.Item>
        </Col>

        <Col span={12}>
          <Form.Item
            label="Статус оплаты"
            required
            help={!header.payment_status_id && 'Обязательное поле'}
            validateStatus={!header.payment_status_id ? 'error' : ''}
          >
            <Select
              {...paymentStatusProps}
              value={header.payment_status_id}
              onChange={(value) => updateHeaderField('payment_status_id', value)}
              placeholder="Выберите статус оплаты"
            />
          </Form.Item>
        </Col>
      </Row>
    </Form>
  );
};
