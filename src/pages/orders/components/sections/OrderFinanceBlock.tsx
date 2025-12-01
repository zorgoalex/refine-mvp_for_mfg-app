// Order Finance Block (Read-only for show page)
// Minimalist design with gold border

import React, { useMemo } from 'react';
import { Typography, Table, Row, Col } from 'antd';
import { useList } from '@refinedev/core';
import { formatNumber } from '../../../../utils/numberFormat';
import { CURRENCY_SYMBOL } from '../../../../config/currency';
import dayjs from 'dayjs';

const { Text } = Typography;

interface OrderFinanceBlockProps {
  record: any;
}

// Helper component for read-only field display
const FinanceField: React.FC<{ label: string; value: string; color?: string }> = ({ label, value, color }) => (
  <div>
    <Text style={{ fontSize: 10, color: '#8c8c8c', display: 'block' }}>{label}</Text>
    <Text strong style={{ fontSize: 13, color: color || '#262626' }}>{value}</Text>
  </div>
);

export const OrderFinanceBlock: React.FC<OrderFinanceBlockProps> = ({ record }) => {
  // Загружаем платежи для текущего заказа
  const { data: paymentsData } = useList({
    resource: 'payments',
    filters: [
      {
        field: 'order_id',
        operator: 'eq',
        value: record?.order_id,
      },
    ],
    pagination: {
      pageSize: 1000,
    },
    queryOptions: {
      enabled: !!record?.order_id,
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

  const paidAmount = record?.paid_amount || 0;
  const isAmountMismatch = Math.abs(totalPaymentsAmount - paidAmount) > 0.01;

  const formatDate = (date: string | null) => {
    if (!date) return '—';
    return dayjs(date).format('DD.MM.YYYY');
  };

  // Calculate discount percent
  const discountPercent = useMemo(() => {
    const totalAmount = record?.total_amount || 0;
    const discount = record?.discount || 0;
    if (totalAmount > 0 && discount > 0) {
      return (discount / totalAmount) * 100;
    }
    return 0;
  }, [record?.total_amount, record?.discount]);

  // Calculate remaining amount to pay
  const remainingAmount = useMemo(() => {
    const discounted = record?.discounted_amount || 0;
    const paid = paidAmount;
    return Math.max(0, discounted - paid);
  }, [record?.discounted_amount, paidAmount]);

  const hasPaidAmount = paidAmount > 0;

  // Payment status color
  const getPaymentStatusColor = (statusName: string | null) => {
    if (!statusName) return '#262626';
    if (statusName === 'Оплачен') return '#52c41a';
    if (statusName === 'Частично оплачен') return '#d4a574';
    if (statusName === 'Не оплачен') return '#ff4d4f';
    return '#262626';
  };

  return (
    <div
      style={{
        marginBottom: 16,
        border: '1px solid #faad14',
        borderRadius: 6,
        background: '#FFFFFF',
        padding: '12px 16px',
      }}
    >
      {/* Read-only finance summary row */}
      <Row gutter={12} style={{ marginBottom: payments.length > 0 ? 16 : 0 }}>
        <Col span={4}>
          <FinanceField
            label={`Общая сумма (${CURRENCY_SYMBOL})`}
            value={formatNumber(record?.total_amount || 0, 2)}
          />
        </Col>
        <Col span={3}>
          <FinanceField
            label={`Скидка${discountPercent > 0 ? ` (${discountPercent.toFixed(1)}%)` : ''}`}
            value={formatNumber(record?.discount || 0, 2)}
            color={record?.discount > 0 ? '#cf1322' : undefined}
          />
        </Col>
        <Col span={4}>
          <FinanceField
            label={`Сумма со скидкой (${CURRENCY_SYMBOL})`}
            value={formatNumber(record?.discounted_amount || 0, 2)}
            color="#1890ff"
          />
        </Col>
        <Col span={3}>
          <FinanceField
            label={`Оплачено (${CURRENCY_SYMBOL})`}
            value={formatNumber(paidAmount, 2)}
            color="#52c41a"
          />
        </Col>
        <Col span={3}>
          <FinanceField
            label="Дата оплаты"
            value={formatDate(record?.payment_date)}
          />
        </Col>
        {/* Осталось оплатить - показывается только если есть оплата */}
        {hasPaidAmount && (
          <Col span={3}>
            <FinanceField
              label={`Осталось (${CURRENCY_SYMBOL})`}
              value={formatNumber(remainingAmount, 2)}
              color={remainingAmount > 0 ? '#d4380d' : '#389e0d'}
            />
          </Col>
        )}
        <Col span={hasPaidAmount ? 4 : 7}>
          <FinanceField
            label="Статус оплаты"
            value={record?.payment_status_name || '—'}
            color={getPaymentStatusColor(record?.payment_status_name)}
          />
        </Col>
      </Row>

      {/* Таблица платежей */}
      {payments.length > 0 && (
        <div>
          <Text style={{ fontSize: 12, color: '#8c8c8c', display: 'block', marginBottom: 8 }}>
            Платежи по заказу
          </Text>
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
                  <Text strong style={{ fontSize: '1.2em' }}>{formatNumber(totalPaymentsAmount, 2)} {CURRENCY_SYMBOL}</Text>
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
            <Text
              style={{ fontSize: 11, display: 'block', marginTop: 8, color: '#ff4d4f' }}
            >
              {totalPaymentsAmount > paidAmount
                ? `Переплата: ${formatNumber(totalPaymentsAmount - paidAmount, 2)} ${CURRENCY_SYMBOL}`
                : `Недоплата: ${formatNumber(paidAmount - totalPaymentsAmount, 2)} ${CURRENCY_SYMBOL}`
              }
            </Text>
          )}
        </div>
      )}
    </div>
  );
};
