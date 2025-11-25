// Payment Modal
// Modal for creating/editing payments

import React, { useEffect } from 'react';
import { Modal, Form, InputNumber, Row, Col, Select, Input, DatePicker } from 'antd';
import { useSelect } from '@refinedev/antd';
import { Payment } from '../../../../types/orders';
import { numberFormatter, numberParser } from '../../../../utils/numberFormat';
import { CURRENCY_SYMBOL } from '../../../../config/currency';
import { DraggableModalWrapper } from '../../../../components/DraggableModalWrapper';
import dayjs from 'dayjs';

interface PaymentModalProps {
  open: boolean;
  mode: 'create' | 'edit';
  payment?: Payment;
  onSave: (payment: Omit<Payment, 'temp_id'>) => void;
  onCancel: () => void;
}

export const PaymentModal: React.FC<PaymentModalProps> = ({
  open,
  mode,
  payment,
  onSave,
  onCancel,
}) => {
  const [form] = Form.useForm();

  // Load payment types
  const { selectProps: paymentTypeSelectProps } = useSelect({
    resource: 'payment_types',
    optionLabel: 'type_paid_name',
    optionValue: 'type_paid_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
    ...(payment?.type_paid_id ? { defaultValue: payment.type_paid_id } : {}),
  });

  // Initialize form when payment changes
  useEffect(() => {
    if (open) {
      if (mode === 'edit' && payment) {
        form.setFieldsValue({
          ...payment,
          payment_date: payment.payment_date ? dayjs(payment.payment_date) : undefined,
        });
      } else {
        form.resetFields();
        // Set default payment date to today
        form.setFieldsValue({
          payment_date: dayjs(),
        });
      }
    }
  }, [open, mode, payment, form]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();

      // Format payment_date to ISO string
      const formattedValues = {
        ...values,
        payment_date: values.payment_date
          ? dayjs(values.payment_date).format('YYYY-MM-DD')
          : dayjs().format('YYYY-MM-DD'),
      };

      onSave(formattedValues);
    } catch (error) {
      console.error('Validation failed:', error);
    }
  };

  return (
    <DraggableModalWrapper>
      <Modal
        title={mode === 'create' ? 'Создать оплату' : 'Редактировать оплату'}
        open={open}
        onOk={handleOk}
        onCancel={onCancel}
        width={600}
        okText={mode === 'create' ? 'Создать' : 'Сохранить'}
        cancelText="Отмена"
      >
        <Form
          form={form}
          layout="vertical"
          autoComplete="off"
        >
          <Row gutter={16}>
            <Col span={24}>
              <Form.Item
                label="Тип оплаты"
                name="type_paid_id"
                rules={[{ required: true, message: 'Выберите тип оплаты' }]}
              >
                <Select
                  {...paymentTypeSelectProps}
                  placeholder="Выберите тип оплаты"
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label="Дата платежа"
                name="payment_date"
                rules={[{ required: true, message: 'Укажите дату платежа' }]}
              >
                <DatePicker
                  style={{ width: '100%' }}
                  format="DD.MM.YYYY"
                  placeholder="Выберите дату"
                />
              </Form.Item>
            </Col>

            <Col span={12}>
              <Form.Item
                label={`Сумма (${CURRENCY_SYMBOL})`}
                name="amount"
                rules={[
                  { required: true, message: 'Укажите сумму' },
                  {
                    type: 'number',
                    min: 0.01,
                    message: 'Сумма должна быть больше 0',
                  },
                ]}
              >
                <InputNumber
                  style={{ width: '100%' }}
                  placeholder="0.00"
                  min={0}
                  precision={2}
                  formatter={(value) => numberFormatter(value, 2)}
                  parser={numberParser}
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={24}>
              <Form.Item
                label="Примечание"
                name="notes"
              >
                <Input.TextArea
                  rows={3}
                  placeholder="Дополнительная информация о платеже"
                  maxLength={500}
                  showCount
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={24}>
              <Form.Item
                label="1C ключ"
                name="ref_key_1c"
              >
                <Input
                  placeholder="Ключ из 1С (опционально)"
                  maxLength={50}
                />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </DraggableModalWrapper>
  );
};
