// Order Finance Block (Read-only for show page)
// Table-style layout with borders

import React, { useMemo } from 'react';
import { Typography, Table } from 'antd';
import { useList } from '@refinedev/core';
import { formatNumber } from '../../../../utils/numberFormat';
import { CURRENCY_SYMBOL } from '../../../../config/currency';
import dayjs from 'dayjs';

const { Text } = Typography;

interface OrderFinanceBlockProps {
  record: any;
}

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

  // Calculate remaining amount to pay
  const remainingAmount = useMemo(() => {
    const discounted = record?.final_amount || 0;
    const paid = paidAmount;
    return Math.max(0, discounted - paid);
  }, [record?.final_amount, paidAmount]);

  const showRemaining = remainingAmount > 0;

  const formatDate = (date: string | null) => {
    if (!date) return '—';
    return dayjs(date).format('DD.MM.YYYY');
  };

  // Calculate discount/surcharge values and percents
  const discount = record?.discount || 0;
  const surcharge = record?.surcharge || 0;
  const totalAmount = record?.total_amount || 0;

  const discountPercent = useMemo(() => {
    if (totalAmount > 0 && discount > 0) {
      return (discount / totalAmount) * 100;
    }
    return 0;
  }, [totalAmount, discount]);

  const surchargePercent = useMemo(() => {
    if (totalAmount > 0 && surcharge > 0) {
      return (surcharge / totalAmount) * 100;
    }
    return 0;
  }, [totalAmount, surcharge]);

  // Determine final amount label based on discount/surcharge
  const finalAmountLabel = useMemo(() => {
    if (discount > 0) return 'Сумма со скидкой';
    if (surcharge > 0) return 'Сумма с наценкой';
    return 'Сумма, итого';
  }, [discount, surcharge]);

  // Show total amount field if there's discount or surcharge
  const showTotalAmount = discount > 0 || surcharge > 0;

  // Count visible columns for dynamic width
  const visibleColumnsCount = useMemo(() => {
    let count = 4; // Final amount, Paid, Payment date, Payment status (always visible)
    if (showTotalAmount) count++; // Total amount (only if discount or surcharge)
    if (discount > 0) count++; // Discount
    if (surcharge > 0) count++; // Surcharge
    if (showRemaining) count++; // Remaining
    return count;
  }, [showTotalAmount, discount, surcharge, showRemaining]);

  // Payment status color
  const getPaymentStatusColor = (statusName: string | null) => {
    if (!statusName) return '#262626';
    if (statusName === 'Оплачен') return '#52c41a';
    if (statusName === 'Частично оплачен') return '#d4a574';
    if (statusName === 'Не оплачен') return '#ff4d4f';
    return '#262626';
  };

  // Стили для ячеек таблицы финансов
  const cellStyle: React.CSSProperties = {
    border: '1px solid #d9d9d9',
    padding: '4px 8px',
    textAlign: 'center',
    verticalAlign: 'middle',
  };

  const headerCellStyle: React.CSSProperties = {
    ...cellStyle,
    background: '#fafafa',
    fontSize: 11,
    color: '#8c8c8c',
    fontWeight: 500,
  };

  const valueCellStyle: React.CSSProperties = {
    ...cellStyle,
    fontSize: 13,
    fontWeight: 600,
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
      {/* Finance summary as table row */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: payments.length > 0 ? 16 : 0, tableLayout: 'fixed' }}>
        <thead>
          <tr>
            {showTotalAmount && (
              <th style={{ ...headerCellStyle, width: `${100 / visibleColumnsCount}%` }}>
                Сумма заказа ({CURRENCY_SYMBOL})
              </th>
            )}
            {discount > 0 && (
              <th style={{ ...headerCellStyle, width: `${100 / visibleColumnsCount}%` }}>
                Скидка {discountPercent.toFixed(1)}%
              </th>
            )}
            {surcharge > 0 && (
              <th style={{ ...headerCellStyle, width: `${100 / visibleColumnsCount}%` }}>
                Наценка {surchargePercent.toFixed(1)}%
              </th>
            )}
            <th style={{ ...headerCellStyle, width: `${100 / visibleColumnsCount}%` }}>
              {finalAmountLabel} ({CURRENCY_SYMBOL})
            </th>
            <th style={{ ...headerCellStyle, width: `${100 / visibleColumnsCount}%` }}>Оплачено ({CURRENCY_SYMBOL})</th>
            {showRemaining && (
              <th style={{ ...headerCellStyle, width: `${100 / visibleColumnsCount}%` }}>Осталось ({CURRENCY_SYMBOL})</th>
            )}
            <th style={{ ...headerCellStyle, width: `${100 / visibleColumnsCount}%` }}>Дата оплаты</th>
            <th style={{ ...headerCellStyle, width: `${100 / visibleColumnsCount}%` }}>Статус оплаты</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            {showTotalAmount && (
              <td style={valueCellStyle}>
                {formatNumber(totalAmount, 2)}
              </td>
            )}
            {discount > 0 && (
              <td style={{ ...valueCellStyle, color: '#cf1322' }}>
                -{formatNumber(discount, 2)}
              </td>
            )}
            {surcharge > 0 && (
              <td style={{ ...valueCellStyle, color: '#111827' }}>
                +{formatNumber(surcharge, 2)}
              </td>
            )}
            <td style={{ ...valueCellStyle, color: '#1890ff' }}>
              {formatNumber(record?.final_amount || 0, 2)}
            </td>
            <td style={{ ...valueCellStyle, color: '#52c41a' }}>
              {formatNumber(paidAmount, 2)}
            </td>
            {showRemaining && (
              <td style={{ ...valueCellStyle, color: '#d4380d', background: '#fff2e8' }}>
                {formatNumber(remainingAmount, 2)}
              </td>
            )}
            <td style={valueCellStyle}>{formatDate(record?.payment_date)}</td>
            <td style={{ ...valueCellStyle, color: getPaymentStatusColor(record?.payment_status_name) }}>
              {record?.payment_status_name || '—'}
            </td>
          </tr>
        </tbody>
      </table>

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
            className="payments-table-dark-borders"
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
