// Standalone quick-create присадки modal. Creates ONE doweling order via the backend command
// POST /api/v1/doweling-orders (audited/idempotent) — NOT a page-level Hasura write, and NOT linked to
// any order (order_doweling_links stays in order-save). Distinct from the order-context
// DowellingOrderQuickCreate modal (that one is create+link via Hasura inside the order form).

import React, { useEffect, useRef, useState } from 'react';
import { Form, Input, Modal, Select, message } from 'antd';
import { useSelect } from '@refinedev/antd';
import {
  buildCreateDowelingRequest,
  createDowelingIdempotencyKey,
  dowelingApi,
} from '../../api/dowelingApi';

interface QuickCreateDowelingModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

interface QuickCreateFormValues {
  dowelingOrderName: string;
  designEngineerId: number;
  paymentStatusId: number;
}

function extractErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const candidate = error as { message?: unknown; body?: { message?: unknown } };
    if (typeof candidate.body?.message === 'string' && candidate.body.message) {
      return candidate.body.message;
    }
    if (typeof candidate.message === 'string' && candidate.message) {
      return candidate.message;
    }
  }
  return fallback;
}

export const QuickCreateDowelingModal: React.FC<QuickCreateDowelingModalProps> = ({
  open,
  onClose,
  onCreated,
}) => {
  const [form] = Form.useForm<QuickCreateFormValues>();
  const [busy, setBusy] = useState(false);
  const idempotencyKeyRef = useRef<string>('');

  // Regenerate the idempotency key once per OPEN (not per keystroke, not per submit): re-clicking after a
  // transient failure replays the SAME key -> idempotent, no duplicate row/outbox.
  useEffect(() => {
    if (open) {
      idempotencyKeyRef.current = createDowelingIdempotencyKey();
      form.resetFields();
    }
  }, [open, form]);

  const { selectProps: employeeSelectProps } = useSelect({
    resource: 'employees',
    optionLabel: 'full_name',
    optionValue: 'employee_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
  });

  const { selectProps: paymentStatusSelectProps } = useSelect({
    resource: 'payment_statuses',
    optionLabel: 'payment_status_name',
    optionValue: 'payment_status_id',
  });

  const handleOk = async () => {
    if (busy) {
      return;
    }

    let values: QuickCreateFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return; // validation errors are shown inline by AntD; keep the modal open
    }

    setBusy(true);
    try {
      await dowelingApi.create(
        buildCreateDowelingRequest({
          dowelingOrderName: values.dowelingOrderName,
          designEngineerId: values.designEngineerId,
          paymentStatusId: values.paymentStatusId,
          idempotencyKey: idempotencyKeyRef.current,
        }),
      );
      message.success('Присадка создана');
      form.resetFields();
      onCreated();
      onClose();
    } catch (error) {
      // Failure: keep the modal open and re-submittable; do NOT call onClose/onCreated.
      message.error(extractErrorMessage(error, 'Не удалось создать присадку'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Быстрое создание присадки"
      open={open}
      onOk={handleOk}
      onCancel={onClose}
      confirmLoading={busy}
      okText="Создать"
      cancelText="Отмена"
      width={500}
      destroyOnClose
    >
      <Form form={form} layout="vertical">
        <Form.Item
          label="Номер присадки"
          name="dowelingOrderName"
          rules={[
            { required: true, message: 'Обязательное поле' },
            { whitespace: true, message: 'Не может состоять только из пробелов' },
            { max: 200, message: 'Максимум 200 символов' },
            {
              validator: (_, value) => {
                if (value && (value.startsWith(' ') || value.endsWith(' '))) {
                  return Promise.reject('Не должен начинаться или заканчиваться пробелом');
                }
                return Promise.resolve();
              },
            },
          ]}
          extra="Создаётся отдельно, без привязки к заказу"
        >
          <Input placeholder="Введите номер присадки" maxLength={200} autoFocus />
        </Form.Item>

        <Form.Item
          label="Конструктор"
          name="designEngineerId"
          rules={[{ required: true, message: 'Обязательное поле' }]}
        >
          <Select
            {...employeeSelectProps}
            placeholder="Выберите конструктора"
            showSearch
            filterOption={(input, option) =>
              (option?.label ?? '').toString().toLowerCase().includes(input.toLowerCase())
            }
          />
        </Form.Item>

        <Form.Item
          label="Статус оплаты"
          name="paymentStatusId"
          rules={[{ required: true, message: 'Обязательное поле' }]}
        >
          <Select {...paymentStatusSelectProps} placeholder="Выберите статус оплаты" />
        </Form.Item>
      </Form>
    </Modal>
  );
};
