// Order delivery and production start shift (ERP → 1C phase 1, slice B).
// Delivery way, address and notes become the 1C customer order delivery fields; the start shift becomes the
// 1C state «N смена В производстве» while the order is in production.

import React from 'react';
import { Col, Form, Input, Row, Select } from 'antd';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { ORDER_DELIVERY_ADDRESS_MAX, ORDER_DELIVERY_NOTES_MAX, orderDeliveryMethodOptions, orderStartShiftOptions } from './orderDelivery';

const { TextArea } = Input;

export const OrderDeliverySection: React.FC = () => {
  const { header, updateHeaderField } = useOrderFormStore();
  const courier = header.delivery_method === 'courier';

  return (
    <Form layout="vertical">
      <Row gutter={16}>
        <Col xs={24} md={6}>
          <Form.Item label="Смена запуска">
            <Select<number>
              allowClear
              placeholder="Не выбрана"
              value={header.start_shift ?? undefined}
              options={orderStartShiftOptions}
              onChange={(value) => updateHeaderField('start_shift', value ?? null)}
            />
          </Form.Item>
        </Col>
        <Col xs={24} md={6}>
          <Form.Item label="Доставка">
            <Select<string>
              allowClear
              placeholder="Не указана"
              value={header.delivery_method ?? undefined}
              options={orderDeliveryMethodOptions}
              onChange={(value) => updateHeaderField('delivery_method', value === 'courier' || value === 'pickup' ? value : null)}
            />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item label="Адрес доставки">
            <Input
              value={header.delivery_address ?? ''}
              disabled={!courier && !header.delivery_address}
              placeholder={courier ? 'Город, улица, дом' : 'Для курьерской доставки'}
              maxLength={ORDER_DELIVERY_ADDRESS_MAX}
              onChange={(e) => updateHeaderField('delivery_address', e.target.value || null)}
            />
          </Form.Item>
        </Col>
      </Row>
      <Row gutter={16}>
        <Col span={24}>
          <Form.Item label="Примечание к доставке">
            <TextArea
              value={header.delivery_notes ?? ''}
              placeholder="Подъезд, этаж, время, телефон получателя"
              autoSize={{ minRows: 1, maxRows: 4 }}
              maxLength={ORDER_DELIVERY_NOTES_MAX}
              onChange={(e) => updateHeaderField('delivery_notes', e.target.value || null)}
            />
          </Form.Item>
        </Col>
      </Row>
    </Form>
  );
};
