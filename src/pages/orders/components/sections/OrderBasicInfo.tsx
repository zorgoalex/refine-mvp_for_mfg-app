// Order Basic Info Section
// Row 1: Client, Order Name, Order Date
// Row 2: Order Status, Payment Status, Manager, Priority
// Row 3: Doweling Orders Table (Name, Engineer)

import React, { useState } from 'react';
import { Form, Input, DatePicker, InputNumber, Row, Col, Select, Button, Space, Table, Popconfirm } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { useSelect } from '@refinedev/antd';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { numberFormatter, numberParser } from '../../../../utils/numberFormat';
import { ClientQuickCreate } from '../modals/ClientQuickCreate';
import { DowellingOrderQuickCreate } from '../modals/DowellingOrderQuickCreate';
import dayjs from 'dayjs';

export const OrderBasicInfo: React.FC = () => {
  const { header, updateHeaderField, dowelingLinks, addDowelingLink, updateDowelingLink, deleteDowelingLink } = useOrderFormStore();
  const [clientModalOpen, setClientModalOpen] = useState(false);
  const [dowellingModalOpen, setDowellingModalOpen] = useState(false);
  const [selectedDowelingId, setSelectedDowelingId] = useState<number | undefined>(undefined);
  const [dowelingSearchValue, setDowelingSearchValue] = useState<string>('');

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

  // Load existing doweling orders for selection
  const { selectProps: dowelingSelectProps, queryResult: dowelingQueryResult } = useSelect({
    resource: 'doweling_orders_view',
    optionLabel: 'doweling_order_name',
    optionValue: 'doweling_order_id',
    sorters: [{ field: 'doweling_order_id', order: 'desc' }],
    pagination: { pageSize: 50 },
  });

  // Get full doweling order data for linking
  const dowelingOrdersData = dowelingQueryResult?.data?.data || [];

  // Handle selection of existing doweling order
  const handleDowelingSelect = (dowelingOrderId: number) => {
    if (!header.order_id) return;

    // Check if already linked
    const alreadyLinked = dowelingLinks.some(l => l.doweling_order_id === dowelingOrderId);
    if (alreadyLinked) return;

    // Find the selected doweling order data
    const selectedDoweling = dowelingOrdersData.find((d: any) => d.doweling_order_id === dowelingOrderId);
    if (!selectedDoweling) return;

    addDowelingLink({
      order_id: header.order_id,
      doweling_order_id: dowelingOrderId,
      doweling_order: {
        doweling_order_id: dowelingOrderId,
        doweling_order_name: selectedDoweling.doweling_order_name,
        design_engineer_id: selectedDoweling.design_engineer_id,
        design_engineer: selectedDoweling.design_engineer,
      },
    });

    // Update header fields for backward compatibility
    updateHeaderField('doweling_order_id', dowelingOrderId);
    updateHeaderField('doweling_order_name', selectedDoweling.doweling_order_name);
    updateHeaderField('design_engineer_id', selectedDoweling.design_engineer_id);
    updateHeaderField('design_engineer', selectedDoweling.design_engineer);

    // Clear the select after adding
    setSelectedDowelingId(undefined);
  };

  // Колонки таблицы присадок
  const dowelingColumns = [
    {
      title: 'Номер присадки',
      dataIndex: ['doweling_order', 'doweling_order_name'],
      key: 'name',
      render: (_: any, record: any) =>
        record.doweling_order?.doweling_order_name || `Присадка #${record.doweling_order_id}`,
    },
    {
      title: 'Конструктор',
      dataIndex: ['doweling_order', 'design_engineer'],
      key: 'engineer',
      width: 200,
      render: (_: any, record: any) => (
        <Select
          {...employeeSelectProps}
          value={record.doweling_order?.design_engineer_id}
          onChange={(value, option: any) => {
            const linkId = record.temp_id || record.order_doweling_link_id;
            updateDowelingLink(linkId, {
              doweling_order: {
                ...record.doweling_order,
                design_engineer_id: value,
                design_engineer: option?.label || null,
              },
            });
          }}
          placeholder="Выберите"
          size="small"
          style={{ width: '100%' }}
          showSearch
          filterOption={(input, option) =>
            (option?.label ?? '').toString().toLowerCase().includes(input.toLowerCase())
          }
        />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 50,
      render: (_: any, record: any) => (
        <Popconfirm
          title="Удалить связь с присадкой?"
          onConfirm={() =>
            deleteDowelingLink(
              record.temp_id || record.order_doweling_link_id!,
              record.order_doweling_link_id
            )
          }
          okText="Да"
          cancelText="Нет"
        >
          <Button
            type="text"
            size="small"
            icon={<DeleteOutlined />}
            danger
          />
        </Popconfirm>
      ),
    },
  ];

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

        {/* Row 2: Статус заказа, Статус оплаты, Менеджер, Приоритет */}
        <Row gutter={16}>
          <Col span={6}>
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
                placeholder="Выберите статус"
              />
            </Form.Item>
          </Col>

          <Col span={6}>
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
                placeholder="Выберите статус"
              />
            </Form.Item>
          </Col>

          <Col span={6}>
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

          <Col span={6}>
            <Form.Item
              label="Приоритет"
              tooltip="1 — наивысший приоритет, большее число — ниже"
            >
              <InputNumber
                value={header.priority}
                onChange={(value) => updateHeaderField('priority', value || 100)}
                min={1}
                max={100}
                formatter={(value) => numberFormatter(value, 0)}
                parser={numberParser}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
        </Row>

        {/* Row 3: Присадки */}
        <Row gutter={16}>
          <Col span={24}>
            <Form.Item
              label="Присадки"
              tooltip="Связанные заказы на присадку"
            >
              <Space direction="vertical" style={{ width: '100%' }}>
                {/* Таблица связанных присадок */}
                {dowelingLinks.length > 0 && (
                  <Table
                    dataSource={dowelingLinks}
                    columns={dowelingColumns}
                    rowKey={(record) => record.order_doweling_link_id || record.temp_id || record.doweling_order_id}
                    size="small"
                    pagination={false}
                    style={{ marginBottom: 8 }}
                  />
                )}

                {dowelingLinks.length === 0 && (
                  <span style={{ color: '#8c8c8c', fontStyle: 'italic' }}>Нет связанных присадок</span>
                )}

                {/* Выбор существующей или создание новой присадки */}
                <Select
                  options={dowelingSelectProps.options}
                  loading={dowelingSelectProps.loading}
                  value={selectedDowelingId}
                  searchValue={dowelingSearchValue}
                  onSearch={(value) => {
                    setDowelingSearchValue(value);
                    dowelingSelectProps.onSearch?.(value);
                  }}
                  onChange={(value) => {
                    if (value) {
                      handleDowelingSelect(value as number);
                    }
                    setSelectedDowelingId(undefined);
                    setDowelingSearchValue('');
                  }}
                  onClear={() => {
                    setSelectedDowelingId(undefined);
                    setDowelingSearchValue('');
                  }}
                  placeholder="Выберите присадку или создайте новую"
                  disabled={!header.order_id}
                  size="small"
                  style={{ width: 300 }}
                  showSearch
                  allowClear
                  filterOption={(input, option) =>
                    (option?.label ?? '').toString().toLowerCase().includes(input.toLowerCase())
                  }
                  dropdownRender={(menu) => (
                    <>
                      {menu}
                      <div style={{ borderTop: '1px solid #e8e8e8', padding: '8px' }}>
                        <Button
                          type="text"
                          icon={<PlusOutlined />}
                          onClick={() => setDowellingModalOpen(true)}
                          style={{ width: '100%', textAlign: 'left' }}
                        >
                          Создать присадку
                        </Button>
                      </div>
                    </>
                  )}
                />
                {!header.order_id && (
                  <span style={{ fontSize: 12, color: '#8c8c8c' }}>
                    Сначала сохраните заказ
                  </span>
                )}
              </Space>
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
          addDowelingLink({
            order_id: header.order_id!,
            doweling_order_id: dowellingOrderId,
            doweling_order: {
              doweling_order_id: dowellingOrderId,
              doweling_order_name: dowellingOrderName,
              design_engineer_id: designEngineerId,
              design_engineer: designEngineer,
            },
          });
          updateHeaderField('doweling_order_id', dowellingOrderId);
          updateHeaderField('doweling_order_name', dowellingOrderName);
          updateHeaderField('design_engineer_id', designEngineerId);
          updateHeaderField('design_engineer', designEngineer);
        }}
      />
    </>
  );
};
