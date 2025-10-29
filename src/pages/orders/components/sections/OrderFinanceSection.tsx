// Order Finance Section
// Contains: Total Amount, Discount, Discounted Amount, Paid Amount, Payment Date

import React, { useEffect } from 'react';
import { Form, InputNumber, DatePicker, Row, Col, Collapse } from 'antd';
import { useOrderFormStore, selectTotals } from '../../../../stores/orderFormStore';
import { useShallow } from 'zustand/react/shallow';
import { numberFormatter, numberParser } from '../../../../utils/numberFormat';
import dayjs from 'dayjs';

const { Panel } = Collapse;

export const OrderFinanceSection: React.FC = () => {
  const { header, updateHeaderField } = useOrderFormStore();
  const totals = useOrderFormStore(useShallow(selectTotals));

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
              <Form.Item label="Общая сумма">
                <InputNumber
                  value={header.total_amount}
                  onChange={(value) => updateHeaderField('total_amount', value)}
                  min={0}
                  precision={2}
                  formatter={(value) => numberFormatter(value, 2)}
                  parser={numberParser}
                  style={{ width: '100%' }}
                  addonAfter="₽"
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
                  addonAfter="₽"
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
                  style={{ width: '100%' }}
                  addonAfter="₽"
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
        </Form>
      </Panel>
    </Collapse>
  );
};
