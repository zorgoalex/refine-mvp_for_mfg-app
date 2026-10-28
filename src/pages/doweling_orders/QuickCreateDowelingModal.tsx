// Quick-create of a Bazis project card (the former doweling order) from the list: the backend command
// POST /api/v1/bazis/cards (audited/idempotent) with its client and, optionally, the order to link — NOT a page-level
// Hasura write. The order list is limited to the chosen client (a card links orders of its own client only).

import React, { useEffect, useRef, useState } from 'react';
import { Form, Input, Modal, Select, message } from 'antd';
import { useSelect } from '@refinedev/antd';
import { useOrderFinancialVisibility } from '../../hooks/useOrderFinancialVisibility';
import {
  buildCreateDowelingRequest,
  createDowelingIdempotencyKey,
  dowelingApi,
  isOutdatedBackendError,
  OUTDATED_BACKEND_MESSAGE,
} from '../../api/dowelingApi';
import { createBackendSelectProps, useOrderFormData } from '../../hooks/useOrderFormData';
import { useBazisCardsCapability } from '../../hooks/useBazisCardsCapability';

interface QuickCreateDowelingModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

interface QuickCreateFormValues {
  dowelingOrderName: string;
  clientId: number;
  orderId?: number;
  designEngineerId: number;
  paymentStatusId?: number;
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
  const cardsSupported = useBazisCardsCapability();
  const idempotencyKeyRef = useRef<string>('');
  // Monotonic open-session token: bumped on each OPEN. A create that resolves after its session is no
  // longer current (modal was reopened) MUST NOT close/refetch — guards the stale-success race.
  const openSessionRef = useRef(0);

  // Regenerate the idempotency key once per OPEN (not per keystroke, not per submit): re-clicking after a
  // transient failure replays the SAME key -> idempotent, no duplicate row/outbox.
  useEffect(() => {
    if (open) {
      openSessionRef.current += 1;
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

  const orderFormData = useOrderFormData();
  const useBackendReferences = orderFormData.enabled;
  const { selectProps: legacyClientSelectProps } = useSelect({
    resource: 'clients',
    optionLabel: 'client_name',
    optionValue: 'client_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    queryOptions: { enabled: open && !useBackendReferences },
  });
  const clientSelectProps = useBackendReferences
    ? createBackendSelectProps(orderFormData.references.clients, orderFormData.isLoading)
    : legacyClientSelectProps;
  const clientId = Form.useWatch('clientId', form);
  const { selectProps: orderSelectProps } = useSelect({
    resource: 'orders_view',
    optionLabel: 'order_name',
    optionValue: 'order_id',
    filters: [{ field: 'client_id', operator: 'eq', value: clientId }],
    sorters: [{ field: 'order_id', order: 'desc' }],
    queryOptions: { enabled: open && Boolean(clientId) },
  });

  const { canViewFinancials } = useOrderFinancialVisibility();
  const { selectProps: paymentStatusSelectProps } = useSelect({
    resource: 'payment_statuses',
    optionLabel: 'payment_status_name',
    optionValue: 'payment_status_id',
  });

  const handleOk = async () => {
    if (busy) {
      return;
    }

    if (!cardsSupported) {
      message.error(OUTDATED_BACKEND_MESSAGE);
      return;
    }
    let values: QuickCreateFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return; // validation errors are shown inline by AntD; keep the modal open
    }

    const session = openSessionRef.current;
    setBusy(true);
    try {
      await dowelingApi.create(
        buildCreateDowelingRequest({
          dowelingOrderName: values.dowelingOrderName,
          designEngineerId: values.designEngineerId,
          clientId: values.clientId,
          orderId: values.orderId ?? null,
          // Without the money right (or hidden by the settings) the server sets «Не оплачен».
          paymentStatusId: canViewFinancials ? values.paymentStatusId : undefined,
          idempotencyKey: idempotencyKeyRef.current,
        }),
      );
      // Ignore a completion whose open-session is stale (modal was closed + reopened mid-flight).
      if (session !== openSessionRef.current) {
        return;
      }
      message.success('Базис-проект создан');
      form.resetFields();
      onCreated();
      onClose();
    } catch (error) {
      // Failure: keep the modal open and re-submittable; do NOT call onClose/onCreated.
      message.error(isOutdatedBackendError(error)
        ? OUTDATED_BACKEND_MESSAGE
        : extractErrorMessage(error, 'Не удалось создать Базис-проект'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Быстрое создание Базис-проекта"
      open={open}
      onOk={handleOk}
      onCancel={() => {
        if (!busy) {
          onClose();
        }
      }}
      confirmLoading={busy}
      okText="Создать"
      cancelText="Отмена"
      width={500}
      destroyOnClose
      // While a create is in-flight, block every close path so the modal cannot be reopened mid-request
      // (defends the stale-success race together with the open-session guard above).
      closable={!busy}
      maskClosable={!busy}
      keyboard={!busy}
      cancelButtonProps={{ disabled: busy }}
    >
      <Form form={form} layout="vertical">
        <Form.Item
          label="Номер Базис-проекта"
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
        >
          <Input placeholder="Введите номер Базис-проекта" maxLength={200} autoFocus />
        </Form.Item>

        <Form.Item label="Клиент" name="clientId" rules={[{ required: true, message: 'Обязательное поле' }]}>
          <Select
            {...clientSelectProps}
            placeholder="Выберите клиента"
            showSearch
            onChange={(value: unknown) => form.setFieldsValue({ clientId: Number(value), orderId: undefined })}
            filterOption={(input, option) =>
              (option?.label ?? '').toString().toLowerCase().includes(input.toLowerCase())
            }
          />
        </Form.Item>

        <Form.Item label="Заказ" name="orderId" extra="Необязательно: заказ этого клиента, к которому относится Базис-проект">
          <Select
            {...orderSelectProps}
            placeholder={clientId ? 'Выберите заказ' : 'Сначала выберите клиента'}
            disabled={!clientId}
            allowClear
            showSearch
          />
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

        {canViewFinancials && (
          <Form.Item
            label="Статус оплаты"
            name="paymentStatusId"
            rules={[{ required: true, message: 'Обязательное поле' }]}
          >
            <Select {...paymentStatusSelectProps} placeholder="Выберите статус оплаты" />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
};
