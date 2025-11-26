// Order Finance Section
// Contains: Total Amount, Discount, Discounted Amount, Paid Amount, Payment Date

import React, { useEffect } from 'react';
import { Form, InputNumber, DatePicker, Row, Col, Button } from 'antd';
import { useOrderFormStore, selectTotals } from '../../../../stores/orderFormStore';
import { useShallow } from 'zustand/react/shallow';
import { numberFormatter, numberParser } from '../../../../utils/numberFormat';
import { CURRENCY_SYMBOL } from '../../../../config/currency';
import dayjs from 'dayjs';

export const OrderFinanceSection: React.FC = () => {
  const { header, updateHeaderField, isTotalAmountManual, setTotalAmountManual, payments } =
    useOrderFormStore();
  const totals = useOrderFormStore(useShallow(selectTotals));

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

  // Update payment_date with the latest payment date
  useEffect(() => {
    if (payments && payments.length > 0) {
      // Find the latest payment date
      const latestPaymentDate = payments.reduce((latest, payment) => {
        if (!payment.payment_date) return latest;
        const currentDate = dayjs(payment.payment_date);
        if (!latest || currentDate.isAfter(latest)) {
          return currentDate;
        }
        return latest;
      }, null as dayjs.Dayjs | null);

      if (latestPaymentDate) {
        const formattedDate = latestPaymentDate.format('YYYY-MM-DD');
        // Only update if different to avoid unnecessary re-renders
        if (header.payment_date !== formattedDate) {
          updateHeaderField('payment_date', formattedDate);
        }
      }
    }
  }, [payments, updateHeaderField]);

  return (
    <div
      style={{
        padding: '16px',
        border: '1px solid #d9d9d9',
        borderRadius: '6px',
        background: '#fafafa',
      }}
    >
      <div style={{ marginBottom: 12, fontSize: 14, fontWeight: 600 }}>
        Финансовая информация
      </div>
      <Form layout="vertical" size="small">
        <Row gutter={8}>
          <Col span={5}>
            <Form.Item
              label={
                <span style={{ fontSize: 12 }}>
                  Общая сумма
                  {isTotalAmountManual && (
                    <Button
                      type="link"
                      size="small"
                      onClick={handleRestoreAuto}
                      style={{ padding: '0 0 0 4px', height: 'auto', fontSize: 10 }}
                      title="Вернуть авторасчет"
                    >
                      (авто)
                    </Button>
                  )}
                </span>
              }
              style={{ marginBottom: 0 }}
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

          <Col span={4}>
            <Form.Item label={<span style={{ fontSize: 12 }}>Скидка (%)</span>} style={{ marginBottom: 0 }}>
              <InputNumber
                value={header.discount}
                onChange={(value) => updateHeaderField('discount', value || 0)}
                min={0}
                max={100}
                precision={2}
                formatter={(value) => !value || value === 0 ? '' : numberFormatter(value, 2)}
                parser={numberParser}
                style={{ width: '100%' }}
                addonAfter="%"
              />
            </Form.Item>
          </Col>

          <Col span={5}>
            <Form.Item label={<span style={{ fontSize: 12 }}>Сумма со скидкой</span>} style={{ marginBottom: 0 }}>
              <InputNumber
                value={header.discounted_amount}
                onChange={(value) => updateHeaderField('discounted_amount', value)}
                min={0}
                precision={2}
                formatter={(value) => !value || value === 0 ? '' : numberFormatter(value, 2)}
                parser={numberParser}
                style={{ width: '100%' }}
                addonAfter={CURRENCY_SYMBOL}
              />
            </Form.Item>
          </Col>

          <Col span={5}>
            <Form.Item
              label={<span style={{ fontSize: 12 }}>Оплачено</span>}
              tooltip="Вычисляется автоматически из платежей"
              style={{ marginBottom: 0 }}
            >
              <InputNumber
                value={header.paid_amount}
                readOnly
                precision={2}
                formatter={(value) => numberFormatter(value, 2)}
                parser={numberParser}
                style={{ width: '100%' }}
                addonAfter={CURRENCY_SYMBOL}
              />
            </Form.Item>
          </Col>

          <Col span={5}>
            <Form.Item label={<span style={{ fontSize: 12 }}>Дата оплаты</span>} style={{ marginBottom: 0 }}>
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
      </Form>
    </div>
  );
};
