// Order Basic Info Section
// Contains: Client, Order Name, Date, Manager, Priority

import React from 'react';
import { Form, Input, DatePicker, InputNumber, Row, Col, Select } from 'antd';
import { useSelect } from '@refinedev/antd';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { numberFormatter, numberParser } from '../../../../utils/numberFormat';
import dayjs from 'dayjs';

export const OrderBasicInfo: React.FC = () => {
  const { header, updateHeaderField } = useOrderFormStore();

  // Load clients - with defaultValue to show current selection properly
  // IMPORTANT: only pass defaultValue if it exists to avoid null in GraphQL query
  const { selectProps: clientSelectProps } = useSelect({
    resource: 'clients',
    optionLabel: 'client_name',
    optionValue: 'client_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    ...(header.client_id ? { defaultValue: header.client_id } : {}),
  });

  // Load employees (for manager) - with defaultValue only if exists
  const { selectProps: employeeSelectProps } = useSelect({
    resource: 'employees',
    optionLabel: 'full_name',
    optionValue: 'employee_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    ...(header.manager_id ? { defaultValue: header.manager_id } : {}),
  });

  return (
    <Form layout="vertical">
      <Row gutter={16}>
        <Col span={12}>
          <Form.Item
            label="Клиент"
            required
            help={!header.client_id && 'Обязательное поле'}
            validateStatus={!header.client_id ? 'error' : ''}
          >
            <Select
              {...clientSelectProps}
              value={header.client_id}
              onChange={(value) => updateHeaderField('client_id', value)}
              placeholder="Выберите клиента"
              showSearch
              filterOption={(input, option) =>
                (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
              }
            />
          </Form.Item>
        </Col>

        <Col span={12}>
          <Form.Item
            label="Название заказа"
            required
            help={!header.order_name && 'Обязательное поле'}
            validateStatus={!header.order_name ? 'error' : ''}
          >
            <Input
              value={header.order_name}
              onChange={(e) => updateHeaderField('order_name', e.target.value)}
              placeholder="Введите название заказа"
              maxLength={200}
            />
          </Form.Item>
        </Col>
      </Row>

      <Row gutter={16}>
        <Col span={8}>
          <Form.Item
            label="Дата заказа"
            required
            help={!header.order_date && 'Обязательное поле'}
            validateStatus={!header.order_date ? 'error' : ''}
          >
            <DatePicker
              value={header.order_date ? dayjs(header.order_date) : null}
              onChange={(date) =>
                updateHeaderField('order_date', date ? date.format('YYYY-MM-DD') : '')
              }
              style={{ width: '100%' }}
              format="DD.MM.YYYY"
            />
          </Form.Item>
        </Col>

        <Col span={8}>
          <Form.Item label="Менеджер">
            <Select
              {...employeeSelectProps}
              value={header.manager_id}
              onChange={(value) => updateHeaderField('manager_id', value)}
              placeholder="Выберите менеджера"
              allowClear
              showSearch
              filterOption={(input, option) =>
                (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
              }
            />
          </Form.Item>
        </Col>

        <Col span={8}>
          <Form.Item
            label="Приоритет"
            tooltip="1 — наивысший приоритет, большее число — ниже"
          >
            <InputNumber
              value={header.priority}
              onChange={(value) => updateHeaderField('priority', value ?? 1)}
              min={1}
              max={100}
              formatter={(value) => numberFormatter(value, 0)}
              parser={numberParser}
              style={{ width: '100%' }}
            />
          </Form.Item>
        </Col>
      </Row>
    </Form>
  );
};
