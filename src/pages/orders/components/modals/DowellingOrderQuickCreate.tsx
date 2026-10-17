// Quick Create Modal for Dowelling Order
// Creates a new doweling order linked to the main order in ONE backend command
// (POST /api/v1/doweling-orders with orderId: audit, order scope, same transaction) — no Hasura writes.

import React, { useEffect, useRef, useState } from 'react';
import { Modal, Form, Input, Select, notification } from 'antd';
import { buildCreateDowelingRequest, createDowelingIdempotencyKey, dowelingApi } from '../../../../api/dowelingApi';
import { useSelect } from '../../../../query/orderLifecycleQueries';
import { DraggableModalWrapper } from '../../../../components/DraggableModalWrapper';
import { useWorkspaceModalFormCheckpoint } from '../../../../workspace/workspaceModalFormCheckpoint';

interface DowellingOrderQuickCreateProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (dowellingOrderId: number, dowellingOrderName: string, designEngineerId?: number, designEngineer?: string, linkId?: number) => void;
  orderId?: number; // ID основного заказа (для связи через order_doweling_links)
  orderDate?: string; // Дата заказа (для doweling_order_date)
}

export const DowellingOrderQuickCreate: React.FC<DowellingOrderQuickCreateProps> = ({
  open,
  onClose,
  onSuccess,
  orderId,
  orderDate,
}) => {
  const [form] = Form.useForm();
  const workspaceKey = useWorkspaceModalFormCheckpoint('dowelling-quick-create', open, form);
  const [isCreating, setIsCreating] = useState(false);
  // One key per opening of the modal: a retry after a lost answer replays the same create instead of a duplicate.
  const idempotencyKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (open) idempotencyKeyRef.current = createDowelingIdempotencyKey('doweling-order-quick-create');
  }, [open]);

  // Load employees for design_engineer selector
  const { selectProps: employeeSelectProps } = useSelect({
    resource: 'employees',
    optionLabel: 'full_name',
    optionValue: 'employee_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
  });

  const handleOk = async () => {
    try {
      const values = await form.validateFields();

      if (!orderId) {
        notification.error({
          message: 'Ошибка',
          description: 'Сначала необходимо сохранить основной заказ',
        });
        return;
      }

      setIsCreating(true);

      try {
        // Находим имя конструктора для передачи в onSuccess
        const selectedEmployee = employeeSelectProps.options?.find(
          (opt: any) => opt.value === values.design_engineer_id
        );
        const designEngineerName = selectedEmployee?.label as string | undefined;

        const created = await dowelingApi.create(
          buildCreateDowelingRequest({
            dowelingOrderName: values.doweling_order_name,
            designEngineerId: values.design_engineer_id,
            operatorId: values.design_engineer_id, // По умолчанию тот же, что и конструктор
            // No payment status: the server sets «Не оплачен» (by code; money needs orders.view_financials).
            productionStatusId: 1,
            dowelingOrderDate: /^\d{4}-\d{2}-\d{2}/.test(orderDate ?? '') ? orderDate!.slice(0, 10) : new Date().toISOString().split('T')[0],
            orderId,
            idempotencyKey: idempotencyKeyRef.current ?? createDowelingIdempotencyKey('doweling-order-quick-create'),
          }),
        );

        const newDowelingOrderId = created.dowelingOrder.dowelingOrderId;
        const newDowelingOrderName = created.dowelingOrder.dowelingOrderName;
        const newLinkId = created.link?.orderDowelingLinkId;

        notification.success({
          message: 'Присадка создана',
          description: `Заказ на присадку "${newDowelingOrderName}" успешно создан и связан с заказом`,
        });
        form.resetFields();
        idempotencyKeyRef.current = null;
        onSuccess(newDowelingOrderId, newDowelingOrderName, values.design_engineer_id, designEngineerName, newLinkId);
        onClose();
      } catch (error: any) {
        console.error('[DowellingOrderQuickCreate] Error:', error);
        notification.error({
          message: 'Ошибка создания присадки',
          description: error?.message || 'Неизвестная ошибка',
        });
      } finally {
        setIsCreating(false);
      }
    } catch (error: any) {
      // Validation failed
      if (error?.errorFields) {
        const firstError = error.errorFields[0]?.errors?.[0];
        if (firstError) {
          notification.warning({
            message: 'Ошибка валидации',
            description: firstError,
          });
        }
      }
    }
  };

  const handleCancel = () => {
    form.resetFields();
    onClose();
  };

  return (
    <Modal
      title="Создать заказ на присадку"
      open={open}
      onOk={handleOk}
      onCancel={handleCancel}
      confirmLoading={isCreating}
      okText="Создать"
      cancelText="Отмена"
      width={500}
      modalRender={(modal) => (
        <DraggableModalWrapper open={open} workspaceKey={workspaceKey}>{modal}</DraggableModalWrapper>
      )}
    >
      <Form form={form} layout="vertical">
        <Form.Item
          label="Номер заказа присадки"
          name="doweling_order_name"
          rules={[
            { required: true, message: 'Обязательное поле' },
            { whitespace: true, message: 'Номер не может состоять только из пробелов' },
            { max: 200, message: 'Максимум 200 символов' },
            {
              validator: (_, value) => {
                if (value && (value.startsWith(' ') || value.endsWith(' '))) {
                  return Promise.reject('Номер не должен начинаться или заканчиваться пробелом');
                }
                return Promise.resolve();
              },
            },
          ]}
          extra="Номер заказа присадки для данного заказа"
        >
          <Input
            placeholder="Введите номер заказа присадки"
            maxLength={200}
            autoFocus
          />
        </Form.Item>

        <Form.Item
          label="Конструктор"
          name="design_engineer_id"
          rules={[{ required: true, message: 'Обязательное поле' }]}
          extra="Конструктор, ответственный за присадку"
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
      </Form>
    </Modal>
  );
};
