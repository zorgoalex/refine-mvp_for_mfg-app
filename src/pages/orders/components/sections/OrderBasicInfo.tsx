// Order Basic Info Section
// Row 1: Client, Order Name, Order Date
// Row 2: Doweling Order, Design Engineer, Manager
// Row 3: Order Status, Payment Status, Priority

import React, { useState } from 'react';
import { Form, Input, DatePicker, InputNumber, Row, Col, Select, Button, Space, notification } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useSelect } from '@refinedev/antd';
import { useUpdate } from '@refinedev/core';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { numberFormatter, numberParser } from '../../../../utils/numberFormat';
import { ClientQuickCreate } from '../modals/ClientQuickCreate';
import { DowellingOrderQuickCreate } from '../modals/DowellingOrderQuickCreate';
import dayjs from 'dayjs';

export const OrderBasicInfo: React.FC = () => {
  const { header, updateHeaderField } = useOrderFormStore();
  const [clientModalOpen, setClientModalOpen] = useState(false);
  const [dowellingModalOpen, setDowellingModalOpen] = useState(false);

  // Hook for updating doweling_order's design_engineer_id
  const { mutate: updateDowellingOrder } = useUpdate();

  // Load clients
  const { selectProps: clientSelectProps } = useSelect({
    resource: 'clients',
    optionLabel: 'client_name',
    optionValue: 'client_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    ...(header.client_id ? { defaultValue: header.client_id } : {}),
  });

  // Load employees (for manager)
  const { selectProps: employeeSelectProps } = useSelect({
    resource: 'employees',
    optionLabel: 'full_name',
    optionValue: 'employee_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    ...(header.manager_id ? { defaultValue: header.manager_id } : {}),
  });

  // Load doweling orders from view (has design_engineer field)
  const { selectProps: dowellingSelectProps, queryResult: dowellingQueryResult } = useSelect({
    resource: 'doweling_orders_view',
    optionLabel: 'doweling_order_name',
    optionValue: 'doweling_order_id',
    ...(header.doweling_order_id ? { defaultValue: header.doweling_order_id } : {}),
  });

  // Load employees for design_engineer selector
  const { selectProps: designEngineerSelectProps } = useSelect({
    resource: 'employees',
    optionLabel: 'full_name',
    optionValue: 'employee_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    ...(header.design_engineer_id ? { defaultValue: header.design_engineer_id } : {}),
  });

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

  // Helper to get design_engineer info from selected doweling order
  const getDowellingOrderInfo = (dowellingOrderId: number | undefined) => {
    if (!dowellingOrderId) return null;
    const dowellingOrder = dowellingQueryResult?.data?.data?.find(
      (item: any) => item.doweling_order_id === dowellingOrderId
    );
    return dowellingOrder || null;
  };

  // Handle design_engineer change - update both UI and backend
  const handleDesignEngineerChange = (employeeId: number | undefined, option: any) => {
    const employeeName = option?.label || null;

    // Update local state
    updateHeaderField('design_engineer_id', employeeId || null);
    updateHeaderField('design_engineer', employeeName);

    // Update doweling_order in backend if it exists
    if (header.doweling_order_id) {
      updateDowellingOrder(
        {
          resource: 'doweling_orders',
          id: header.doweling_order_id,
          values: {
            design_engineer_id: employeeId || null,
          },
        },
        {
          onSuccess: () => {
            notification.success({
              message: 'Конструктор обновлён',
              description: employeeName
                ? `Конструктор присадки изменён на "${employeeName}"`
                : 'Конструктор присадки удалён',
            });
          },
          onError: (error: any) => {
            notification.error({
              message: 'Ошибка обновления',
              description: error?.message || 'Не удалось обновить конструктора присадки',
            });
          },
        }
      );
    }
  };

  return (
    <>
      <Form layout="vertical">
        {/* Row 1: Клиент, Название заказа, Дата заказа */}
        <Row gutter={16}>
          <Col span={8}>
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
                dropdownRender={(menu) => (
                  <>
                    {menu}
                    <Space style={{ padding: '8px' }}>
                      <Button
                        type="text"
                        icon={<PlusOutlined />}
                        onClick={() => setClientModalOpen(true)}
                      >
                        Создать клиента
                      </Button>
                    </Space>
                  </>
                )}
              />
            </Form.Item>
          </Col>

          <Col span={8}>
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
        </Row>

        {/* Row 2: Присадка, Конструктор присадки, Менеджер */}
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item
              label="Присадка"
              tooltip="Номер заказа на присадку для данного заказа"
            >
              <Select
                {...dowellingSelectProps}
                value={header.doweling_order_id}
                onChange={(value, option: any) => {
                  updateHeaderField('doweling_order_id', value);
                  updateHeaderField('doweling_order_name', option?.label || null);
                  // Get design_engineer info from the selected doweling order
                  const dowellingInfo = getDowellingOrderInfo(value);
                  updateHeaderField('design_engineer', dowellingInfo?.design_engineer || null);
                  updateHeaderField('design_engineer_id', dowellingInfo?.design_engineer_id || null);
                }}
                placeholder="Выберите или создайте присадку"
                allowClear
                showSearch
                filterOption={(input, option) =>
                  (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                }
                dropdownRender={(menu) => (
                  <>
                    {menu}
                    <Space style={{ padding: '8px' }}>
                      <Button
                        type="text"
                        icon={<PlusOutlined />}
                        onClick={() => setDowellingModalOpen(true)}
                        disabled={!header.order_id}
                      >
                        Создать присадку
                      </Button>
                    </Space>
                  </>
                )}
              />
            </Form.Item>
          </Col>

          <Col span={8}>
            <Form.Item
              label="Конструктор присадки"
              tooltip="Конструктор, назначенный на присадку. Изменение обновит запись присадки."
            >
              <Select
                {...designEngineerSelectProps}
                value={header.design_engineer_id || undefined}
                onChange={handleDesignEngineerChange}
                placeholder={header.doweling_order_id ? "Выберите конструктора" : "Сначала выберите присадку"}
                disabled={!header.doweling_order_id}
                allowClear
                showSearch
                filterOption={(input, option) =>
                  (option?.label ?? '').toString().toLowerCase().includes(input.toLowerCase())
                }
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
        </Row>

        {/* Row 3: Статус заказа, Статус оплаты, Приоритет */}
        <Row gutter={16}>
          <Col span={8}>
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

          <Col span={8}>
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

          <Col span={8}>
            <Form.Item
              label="Приоритет"
              tooltip="1 — наивысший приоритет, большее число — ниже"
            >
              <InputNumber
                value={header.priority || 100}
                onChange={(value) => updateHeaderField('priority', value ?? 100)}
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

      <ClientQuickCreate
        open={clientModalOpen}
        onClose={() => setClientModalOpen(false)}
        onSuccess={(clientId) => {
          updateHeaderField('client_id', clientId);
        }}
      />

      <DowellingOrderQuickCreate
        open={dowellingModalOpen}
        onClose={() => setDowellingModalOpen(false)}
        orderId={header.order_id}
        orderDate={typeof header.order_date === 'string' ? header.order_date : undefined}
        onSuccess={(dowellingOrderId, dowellingOrderName, designEngineerId, designEngineer) => {
          updateHeaderField('doweling_order_id', dowellingOrderId);
          updateHeaderField('doweling_order_name', dowellingOrderName);
          updateHeaderField('design_engineer_id', designEngineerId || null);
          updateHeaderField('design_engineer', designEngineer || null);
        }}
      />
    </>
  );
};
