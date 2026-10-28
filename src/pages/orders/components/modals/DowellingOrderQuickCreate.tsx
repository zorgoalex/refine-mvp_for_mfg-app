// Quick create of a Bazis project card from the order form (POST /api/v1/bazis/cards: audit, order scope, same
// transaction) — no Hasura writes. A saved order is linked in the same command; for a new, unsaved order (e.g. right
// after a PDF import) the card is created with the client of the form and linked by the order save (dowelingLinks).

import React, { useEffect, useRef, useState } from 'react';
import { Modal, Form, Input, Select, notification } from 'antd';
import {
  buildCreateDowelingRequest,
  createDowelingIdempotencyKey,
  dowelingApi,
  isOutdatedBackendError,
  OUTDATED_BACKEND_MESSAGE,
} from '../../../../api/dowelingApi';
import { useSelect } from '../../../../query/orderLifecycleQueries';
import { DraggableModalWrapper } from '../../../../components/DraggableModalWrapper';
import { useBazisCardsCapability } from '../../../../hooks/useBazisCardsCapability';
import { useWorkspaceModalFormCheckpoint } from '../../../../workspace/workspaceModalFormCheckpoint';

interface DowellingOrderQuickCreateProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (dowellingOrderId: number, dowellingOrderName: string, designEngineerId?: number, designEngineer?: string, linkId?: number) => void;
  orderId?: number; // ID основного заказа (для связи через order_doweling_links)
  orderDate?: string; // Дата заказа (для doweling_order_date)
  /** Клиент формы заказа: клиент Базис-проекта (обязателен для нового, ещё не сохранённого заказа). */
  clientId?: number | null;
  /** Номер для подстановки (например, номер проекта Базис из загруженного PDF). */
  suggestedName?: string | null;
}

export const DowellingOrderQuickCreate: React.FC<DowellingOrderQuickCreateProps> = ({
  open,
  onClose,
  onSuccess,
  orderId,
  orderDate,
  clientId,
  suggestedName,
}) => {
  const [form] = Form.useForm();
  const workspaceKey = useWorkspaceModalFormCheckpoint('dowelling-quick-create', open, form);
  const [isCreating, setIsCreating] = useState(false);
  const cardsSupported = useBazisCardsCapability();
  // One key per opening of the modal: a retry after a lost answer replays the same create instead of a duplicate.
  const idempotencyKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (open) idempotencyKeyRef.current = createDowelingIdempotencyKey('doweling-order-quick-create');
  }, [open]);
  useEffect(() => {
    if (open && suggestedName && !form.getFieldValue('doweling_order_name')) {
      form.setFieldsValue({ doweling_order_name: suggestedName });
    }
  }, [open, suggestedName, form]);

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

      if (!cardsSupported) {
        notification.error({ message: 'Ошибка', description: OUTDATED_BACKEND_MESSAGE });
        return;
      }
      if (!orderId && !clientId) {
        notification.error({
          message: 'Ошибка',
          description: 'Сначала выберите клиента заказа',
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
            orderId: orderId ?? null,
            clientId: orderId ? null : clientId ?? null,
            idempotencyKey: idempotencyKeyRef.current ?? createDowelingIdempotencyKey('doweling-order-quick-create'),
          }),
        );

        const newDowelingOrderId = created.dowelingOrder.dowelingOrderId;
        const newDowelingOrderName = created.dowelingOrder.dowelingOrderName;
        const newLinkId = created.link?.orderDowelingLinkId;

        notification.success({
          message: 'Базис-проект создан',
          description: orderId
            ? `Базис-проект "${newDowelingOrderName}" создан и связан с заказом`
            : `Базис-проект "${newDowelingOrderName}" создан; связь с заказом сохранится вместе с заказом`,
        });
        form.resetFields();
        idempotencyKeyRef.current = null;
        onSuccess(newDowelingOrderId, newDowelingOrderName, values.design_engineer_id, designEngineerName, newLinkId);
        onClose();
      } catch (error: any) {
        console.error('[DowellingOrderQuickCreate] Error:', error);
        notification.error({
          message: 'Ошибка создания Базис-проекта',
          description: isOutdatedBackendError(error) ? OUTDATED_BACKEND_MESSAGE : error?.message || 'Неизвестная ошибка',
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
      title="Создать Базис-проект"
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
          label="Номер Базис-проекта"
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
          extra="Номер Базис-проекта для данного заказа"
        >
          <Input
            placeholder="Введите номер Базис-проекта"
            maxLength={200}
            autoFocus
          />
        </Form.Item>

        <Form.Item
          label="Конструктор"
          name="design_engineer_id"
          rules={[{ required: true, message: 'Обязательное поле' }]}
          extra="Конструктор, ответственный за Базис-проект"
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
