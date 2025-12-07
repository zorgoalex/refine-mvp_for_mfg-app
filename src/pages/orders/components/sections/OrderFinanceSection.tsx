// Order Finance Section
// Contains: Total Amount, Discount, Discounted Amount, Paid Amount, Payment Date

import React, { useEffect, useState, useMemo } from 'react';
import { Form, InputNumber, DatePicker, Row, Col, Button, Select, Switch } from 'antd';
import { CalculatorOutlined, DownOutlined } from '@ant-design/icons';
import { useSelect } from '@refinedev/antd';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { numberParser, currencySmartFormatter } from '../../../../utils/numberFormat';
import { CURRENCY_SYMBOL } from '../../../../config/currency';
import dayjs from 'dayjs';

export const OrderFinanceSection: React.FC = () => {
  const { header, updateHeaderField, isTotalAmountManual, setTotalAmountManual, payments, details } =
    useOrderFormStore();

  // FIX: Calculate totals directly from details/payments for proper reactivity
  // Previously used useShallow(selectTotals) which didn't react to details changes
  const totals = useMemo(() => ({
    positions_count: details.length,
    parts_count: details.reduce((sum, d) => sum + (d.quantity || 0), 0),
    total_area: details.reduce((sum, d) => sum + (d.area || 0), 0),
    total_paid: payments.reduce((sum, p) => sum + (p.amount || 0), 0),
    total_amount: details.reduce((sum, d) => sum + (d.detail_cost || 0), 0),
  }), [details, payments]);

  // State for showing/hiding percent input field
  const [showPercentInput, setShowPercentInput] = useState(false);
  const [percentValue, setPercentValue] = useState<number | null>(null);

  // State for discount/surcharge mode - determine from header values
  const [adjustmentMode, setAdjustmentMode] = useState<'discount' | 'surcharge'>(() => {
    // If surcharge > 0, use surcharge mode, otherwise default to discount
    return (header.surcharge || 0) > 0 ? 'surcharge' : 'discount';
  });

  // Sync adjustmentMode when header changes (e.g., on order load)
  useEffect(() => {
    const hasDiscount = (header.discount || 0) > 0;
    const hasSurcharge = (header.surcharge || 0) > 0;
    if (hasSurcharge && !hasDiscount) {
      setAdjustmentMode('surcharge');
    } else if (hasDiscount && !hasSurcharge) {
      setAdjustmentMode('discount');
    }
    // If both are 0, keep current mode
  }, [header.discount, header.surcharge]);

  // Load payment statuses for manual selection
  const { selectProps: paymentStatusSelectProps } = useSelect({
    resource: 'payment_statuses',
    optionLabel: 'payment_status_name',
    optionValue: 'payment_status_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
  });

  const handleTotalAmountChange = (value: number | null) => {
    if (!isTotalAmountManual) {
      setTotalAmountManual(true);
    }
    updateHeaderField('total_amount', value ?? 0);
  };

  const handleRestoreAuto = () => {
    setTotalAmountManual(false);
  };

  const handlePaymentStatusChange = (value: number) => {
    updateHeaderField('payment_status_id', value);
  };

  // Get current adjustment value (either discount or surcharge based on mode)
  const currentAdjustmentValue = adjustmentMode === 'discount'
    ? (header.discount || 0)
    : (header.surcharge || 0);

  // Calculate adjustment percent from absolute amount
  const adjustmentPercent = (() => {
    const totalAmount = header.total_amount || 0;
    if (totalAmount > 0 && currentAdjustmentValue > 0) {
      return (currentAdjustmentValue / totalAmount) * 100;
    }
    return 0;
  })();

  // Handler for mode change (discount <-> surcharge)
  const handleModeChange = (mode: 'discount' | 'surcharge') => {
    setAdjustmentMode(mode);
    // Clear both values and recalculate final_amount
    updateHeaderField('discount', 0);
    updateHeaderField('surcharge', 0);
    const totalAmount = header.total_amount || 0;
    updateHeaderField('final_amount', totalAmount);
    setPercentValue(null);
  };

  // Handler for absolute adjustment amount (primary field)
  const handleAdjustmentChange = (value: number | null) => {
    const amount = value || 0;
    const totalAmount = header.total_amount || 0;

    if (adjustmentMode === 'discount') {
      updateHeaderField('discount', amount);
      updateHeaderField('surcharge', 0);
      const finalAmount = totalAmount - amount;
      updateHeaderField('final_amount', Number(finalAmount.toFixed(2)));
    } else {
      updateHeaderField('surcharge', amount);
      updateHeaderField('discount', 0);
      const finalAmount = totalAmount + amount;
      updateHeaderField('final_amount', Number(finalAmount.toFixed(2)));
    }
  };

  // Handler for percent input (calculator mode)
  const handlePercentChange = (value: number | null) => {
    setPercentValue(value);

    const percent = value || 0;
    const totalAmount = header.total_amount || 0;
    const absoluteAmount = (totalAmount * percent) / 100;

    if (adjustmentMode === 'discount') {
      updateHeaderField('discount', Number(absoluteAmount.toFixed(2)));
      updateHeaderField('surcharge', 0);
      const finalAmount = totalAmount - absoluteAmount;
      updateHeaderField('final_amount', Number(finalAmount.toFixed(2)));
    } else {
      updateHeaderField('surcharge', Number(absoluteAmount.toFixed(2)));
      updateHeaderField('discount', 0);
      const finalAmount = totalAmount + absoluteAmount;
      updateHeaderField('final_amount', Number(finalAmount.toFixed(2)));
    }
  };

  const handleFinalAmountChange = (value: number | null) => {
    const finalAmount = value || 0;
    updateHeaderField('final_amount', finalAmount);

    const totalAmount = header.total_amount || 0;
    const difference = Math.abs(totalAmount - finalAmount);

    if (adjustmentMode === 'discount') {
      // final_amount < total_amount means discount
      const discount = Math.max(0, totalAmount - finalAmount);
      updateHeaderField('discount', Number(discount.toFixed(2)));
      updateHeaderField('surcharge', 0);
    } else {
      // final_amount > total_amount means surcharge
      const surcharge = Math.max(0, finalAmount - totalAmount);
      updateHeaderField('surcharge', Number(surcharge.toFixed(2)));
      updateHeaderField('discount', 0);
    }
  };

  // Toggle calculator mode
  const togglePercentInput = () => {
    if (!showPercentInput) {
      // Opening: sync percent value with current adjustment
      setPercentValue(adjustmentPercent > 0 ? Number(adjustmentPercent.toFixed(2)) : null);
    }
    setShowPercentInput(!showPercentInput);
  };

  // NOTE: Auto-update of total_amount, final_amount, paid_amount, and payment_status_id
  // is now handled in OrderForm.tsx (always-mounted component) to ensure recalculation
  // happens regardless of active tab.

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

  // Calculate remaining amount to pay
  const remainingAmount = useMemo(() => {
    const discounted = header.final_amount || 0;
    const paid = header.paid_amount || 0;
    return Math.max(0, discounted - paid);
  }, [header.final_amount, header.paid_amount]);

  const hasPaidAmount = (header.paid_amount || 0) > 0;

  return (
    <div
      style={{
        padding: '12px 16px',
        border: '1px solid #d9d9d9',
        borderRadius: '6px',
        background: '#fafafa',
      }}
    >
      <Form layout="vertical" size="small">
        <Row gutter={8}>
          {/* Общая сумма */}
          <Col span={3}>
            <Form.Item
              label={
                <span style={{ fontSize: 11 }}>
                  Общая сумма ({CURRENCY_SYMBOL})
                  {isTotalAmountManual && (
                    <Button
                      type="link"
                      size="small"
                      onClick={handleRestoreAuto}
                      style={{ padding: '0 0 0 2px', height: 'auto', fontSize: 9 }}
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
                placeholder="0.00"
                formatter={currencySmartFormatter}
                parser={numberParser}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>

          {/* Скидка / Наценка */}
          <Col span={5}>
            <Form.Item
              label={
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{
                    fontSize: 11,
                    fontWeight: (header.discount || 0) > 0 && adjustmentMode === 'discount' ? 600 : 400,
                    color: adjustmentMode === 'discount'
                      ? ((header.discount || 0) > 0 ? '#cf1322' : '#111827')  // красный если скидка > 0, иначе чёрный
                      : '#8c8c8c'  // неактивный серый
                  }}>
                    Скидка{adjustmentMode === 'discount' && adjustmentPercent > 0 ? ` ${adjustmentPercent.toFixed(1)}%` : ''}
                  </span>
                  <Switch
                    size="small"
                    checked={adjustmentMode === 'surcharge'}
                    onChange={(checked) => handleModeChange(checked ? 'surcharge' : 'discount')}
                    style={{ minWidth: 28 }}
                  />
                  <span style={{
                    fontSize: 11,
                    fontWeight: (header.surcharge || 0) > 0 && adjustmentMode === 'surcharge' ? 600 : 400,
                    color: adjustmentMode === 'surcharge'
                      ? ((header.surcharge || 0) > 0 ? '#fa8c16' : '#111827')  // ярко-оранжевый если наценка > 0, иначе чёрный
                      : '#8c8c8c'  // неактивный серый
                  }}>
                    Наценка{adjustmentMode === 'surcharge' && adjustmentPercent > 0 ? ` ${adjustmentPercent.toFixed(1)}%` : ''}
                  </span>
                </div>
              }
              style={{ marginBottom: 0 }}
            >
              <InputNumber
                value={currentAdjustmentValue}
                onChange={handleAdjustmentChange}
                min={0}
                precision={2}
                placeholder="0.00"
                formatter={currencySmartFormatter}
                parser={numberParser}
                style={{ width: '100%' }}
                addonAfter={
                  <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <DownOutlined
                      onClick={togglePercentInput}
                      style={{
                        cursor: 'pointer',
                        color: showPercentInput ? '#1890ff' : '#8c8c8c',
                        fontSize: 9,
                        transform: showPercentInput ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 0.3s ease'
                      }}
                    />
                    <CalculatorOutlined
                      onClick={togglePercentInput}
                      style={{
                        cursor: 'pointer',
                        color: showPercentInput ? '#1890ff' : '#8c8c8c',
                        fontSize: 12
                      }}
                    />
                  </span>
                }
              />
              {showPercentInput && (
                <div style={{ marginTop: 4 }}>
                  <InputNumber
                    value={percentValue}
                    onChange={handlePercentChange}
                    min={0}
                    max={100}
                    precision={2}
                    placeholder="%"
                    formatter={currencySmartFormatter}
                    parser={numberParser}
                    style={{ width: '100%' }}
                    addonAfter="%"
                    size="small"
                  />
                </div>
              )}
            </Form.Item>
          </Col>

          {/* Сумма со скидкой / Сумма с наценкой */}
          <Col span={3}>
            <Form.Item
              label={
                <span style={{ fontSize: 11 }}>
                  {adjustmentMode === 'discount' ? 'Сумма со скидкой' : 'Сумма с наценкой'} ({CURRENCY_SYMBOL})
                </span>
              }
              style={{ marginBottom: 0 }}
            >
              <InputNumber
                value={header.final_amount}
                onChange={handleFinalAmountChange}
                min={0}
                precision={2}
                placeholder="0.00"
                formatter={currencySmartFormatter}
                parser={numberParser}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>

          {/* Оплачено */}
          <Col span={3}>
            <Form.Item
              label={<span style={{ fontSize: 11 }}>Оплачено ({CURRENCY_SYMBOL})</span>}
              tooltip="Из платежей"
              style={{ marginBottom: 0 }}
            >
              <InputNumber
                value={header.paid_amount}
                readOnly
                precision={2}
                placeholder="0.00"
                formatter={currencySmartFormatter}
                parser={numberParser}
                style={{ width: '100%', background: '#f5f5f5' }}
              />
            </Form.Item>
          </Col>

          {/* Дата оплаты */}
          <Col span={3}>
            <Form.Item
              label={<span style={{ fontSize: 11 }}>Дата оплаты</span>}
              tooltip="Дата последнего платежа"
              style={{ marginBottom: 0 }}
            >
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

          {/* Осталось оплатить - показывается только если есть оплата */}
          {hasPaidAmount && (
            <Col span={3}>
              <Form.Item
                label={<span style={{ fontSize: 11 }}>Осталось ({CURRENCY_SYMBOL})</span>}
                style={{ marginBottom: 0 }}
              >
                <InputNumber
                  value={remainingAmount}
                  readOnly
                  precision={2}
                  formatter={currencySmartFormatter}
                  parser={numberParser}
                  style={{
                    width: '100%',
                    background: remainingAmount > 0 ? '#fff2e8' : '#f6ffed',
                    color: remainingAmount > 0 ? '#d4380d' : '#389e0d',
                  }}
                />
              </Form.Item>
            </Col>
          )}

          {/* Статус оплаты */}
          <Col span={hasPaidAmount ? 4 : 7}>
            <Form.Item
              label={<span style={{ fontSize: 11 }}>Статус оплаты</span>}
              style={{ marginBottom: 0 }}
            >
              <Select
                {...paymentStatusSelectProps}
                value={header.payment_status_id}
                onChange={handlePaymentStatusChange}
                style={{ width: '100%' }}
                placeholder="Статус"
              />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </div>
  );
};
