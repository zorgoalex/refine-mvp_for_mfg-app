// Order Finance Section
// Contains: Total Amount, Discount, Discounted Amount, Paid Amount, Payment Date

import React, { useEffect, useMemo } from 'react';
import { Form, InputNumber, DatePicker, Row, Col, Collapse, Button, Table, Typography } from 'antd';
import { useList } from '@refinedev/core';
import { useOrderFormStore, selectTotals } from '../../../../stores/orderFormStore';
import { useShallow } from 'zustand/react/shallow';
import { numberFormatter, numberParser, formatNumber } from '../../../../utils/numberFormat';
import { CURRENCY_SYMBOL } from '../../../../config/currency';
import dayjs from 'dayjs';

const { Text } = Typography;

const { Panel } = Collapse;

export const OrderFinanceSection: React.FC = () => {
  const { header, updateHeaderField, isTotalAmountManual, setTotalAmountManual } =
    useOrderFormStore();
  const totals = useOrderFormStore(useShallow(selectTotals));

  // Загружаем платежи для текущего заказа
  const { data: paymentsData } = useList({
    resource: 'payments',
    filters: [
      {
        field: 'order_id',
        operator: 'eq',
        value: header.order_id,
      },
    ],
    pagination: {
      pageSize: 1000,
    },
    queryOptions: {
      enabled: !!header.order_id,
    },
  });

  // Загружаем справочник типов оплаты
  const { data: paymentTypesData } = useList({
    resource: 'payment_types',
    pagination: { pageSize: 1000 },
  });

  // Создаем lookup map для типов оплаты
  const paymentTypesMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (paymentTypesData?.data || []).forEach((pt: any) => {
      map[pt.type_paid_id] = pt.type_paid_name;
    });
    return map;
  }, [paymentTypesData]);

  const payments = paymentsData?.data || [];

  // Считаем сумму всех платежей
  const totalPaymentsAmount = useMemo(() => {
    return payments.reduce((sum, p: any) => sum + (p.amount || 0), 0);
  }, [payments]);

  // Проверяем, совпадает ли сумма платежей с paid_amount
  const paidAmount = header.paid_amount || 0;
  const isAmountMismatch = Math.abs(totalPaymentsAmount - paidAmount) > 0.01;

  const formatDate = (date: string | null) => {
    if (!date) return '—';
    return dayjs(date).format('DD.MM.YYYY');
  };

  const handleTotalAmountChange = (value: number | null) => {
    if (!isTotalAmountManual) {
      setTotalAmountManual(true);
    }
    updateHeaderField('total_amount', value ?? 0);
  };

  const handleRestoreAuto = () => {
    setTotalAmountManual(false);
  };

  // Auto-calculate discounted_amount when total_amount or discount changes
  useEffect(() => {
    if (header.total_amount && header.discount) {
      const discountedAmount = header.total_amount * (1 - header.discount / 100);
      updateHeaderField('discounted_amount', Number(discountedAmount.toFixed(2)));
    }
  }, [header.total_amount, header.discount]);

  // Update paid_amount from payments totals
  useEffect(() => {
    updateHeaderField('paid_amount', totals.total_paid);
  }, [totals.total_paid]);

  return (
    <Collapse defaultActiveKey={['1']}>
      <Panel header="Финансовая информация" key="1">
        <Form layout="vertical">
          <Row gutter={16}>
            <Col span={6}>
              <Form.Item
                label="Общая сумма"
                extra={
                  isTotalAmountManual ? (
                    <span>
                      Ручной режим.{' '}
                      <Button type="link" size="small" onClick={handleRestoreAuto}>
                        Вернуть авторасчет
                      </Button>
                    </span>
                  ) : (
                    <span>Рассчитывается автоматически по сумме деталей</span>
                  )
                }
              >
                <InputNumber
                  value={header.total_amount}
                  onChange={handleTotalAmountChange}
                  min={0}
                  precision={2}
                  formatter={(value) => numberFormatter(value, 2)}
                  parser={numberParser}
                  style={{ width: '100%' }}
                  addonAfter={CURRENCY_SYMBOL}
                />
              </Form.Item>
            </Col>

            <Col span={6}>
              <Form.Item label="Скидка (%)">
                <InputNumber
                  value={header.discount}
                  onChange={(value) => updateHeaderField('discount', value || 0)}
                  min={0}
                  max={100}
                  precision={2}
                  formatter={(value) => numberFormatter(value, 2)}
                  parser={numberParser}
                  style={{ width: '100%' }}
                  addonAfter="%"
                />
              </Form.Item>
            </Col>

            <Col span={6}>
              <Form.Item label="Сумма со скидкой">
                <InputNumber
                  value={header.discounted_amount}
                  onChange={(value) => updateHeaderField('discounted_amount', value)}
                  min={0}
                  precision={2}
                  formatter={(value) => numberFormatter(value, 2)}
                  parser={numberParser}
                  style={{ width: '100%' }}
                  addonAfter={CURRENCY_SYMBOL}
                />
              </Form.Item>
            </Col>

            <Col span={6}>
              <Form.Item label="Оплачено" tooltip="Вычисляется автоматически из платежей">
                <InputNumber
                  value={header.paid_amount}
                  readOnly
                  precision={2}
                  formatter={(value) => numberFormatter(value, 2)}
                  parser={numberParser}
                  style={{
                    width: '100%',
                    color: isAmountMismatch ? '#ff4d4f' : undefined,
                    fontWeight: isAmountMismatch ? 'bold' : undefined,
                  }}
                  addonAfter={CURRENCY_SYMBOL}
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={6}>
              <Form.Item label="Дата оплаты">
                <DatePicker
                  value={header.payment_date ? dayjs(header.payment_date) : null}
                  onChange={(date) =>
                    updateHeaderField('payment_date', date ? date.format('YYYY-MM-DD') : null)
                  }
                  style={{ width: '100%' }}
                  format="DD.MM.YYYY"
                />
              </Form.Item>
            </Col>
          </Row>

          {/* Таблица платежей */}
          {payments.length > 0 && (
            <Row gutter={16} style={{ marginTop: 24 }}>
              <Col span={24}>
                <div style={{ marginBottom: 8 }}>
                  <Text style={{ fontSize: 14, fontWeight: 600 }}>Платежи по заказу</Text>
                </div>
                <Table
                  dataSource={payments}
                  rowKey="payment_id"
                  size="small"
                  pagination={false}
                  bordered
                  style={{ fontSize: 12 }}
                  summary={() => (
                    <Table.Summary.Row>
                      <Table.Summary.Cell index={0} colSpan={2}>
                        <Text strong style={{ fontSize: '1.2em' }}>Итого:</Text>
                      </Table.Summary.Cell>
                      <Table.Summary.Cell index={2} align="right">
                        <Text strong style={{ fontSize: '1.2em' }}>
                          {formatNumber(totalPaymentsAmount, 2)} {CURRENCY_SYMBOL}
                        </Text>
                      </Table.Summary.Cell>
                    </Table.Summary.Row>
                  )}
                  columns={[
                    {
                      title: 'Тип оплаты',
                      dataIndex: 'type_paid_id',
                      key: 'type_paid_id',
                      width: 150,
                      render: (value) => paymentTypesMap[value] || '—',
                    },
                    {
                      title: 'Дата',
                      dataIndex: 'payment_date',
                      key: 'payment_date',
                      width: 100,
                      render: (value) => formatDate(value),
                    },
                    {
                      title: 'Сумма',
                      dataIndex: 'amount',
                      key: 'amount',
                      width: 120,
                      align: 'right',
                      render: (value) => `${formatNumber(value || 0, 2)} ${CURRENCY_SYMBOL}`,
                    },
                  ]}
                />
                {isAmountMismatch && (
                  <Text type="danger" style={{ fontSize: 11, display: 'block', marginTop: 8 }}>
                    ⚠ Сумма платежей ({formatNumber(totalPaymentsAmount, 2)} {CURRENCY_SYMBOL}) не
                    совпадает с суммой оплаты заказа
                  </Text>
                )}
              </Col>
            </Row>
          )}
        </Form>
      </Panel>
    </Collapse>
  );
};
