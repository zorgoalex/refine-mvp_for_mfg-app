// Quick Create Modal for Dowelling Order
// Allows creating a new dowelling order and linking it to the main order via order_doweling_links

import React, { useState } from 'react';
import { Modal, Form, Input, Select, notification } from 'antd';
import { useCreate } from '@refinedev/core';
import { useSelect } from '@refinedev/antd';
import { DraggableModalWrapper } from '../../../../components/DraggableModalWrapper';

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
  const [isCreating, setIsCreating] = useState(false);
  const { mutateAsync: createDowellingOrder } = useCreate();
  const { mutateAsync: createDowelingLink } = useCreate();

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

        // Шаг 1: Создаем заказ на присадку БЕЗ order_id (many-to-many)
        const dowelingResult = await createDowellingOrder({
          resource: 'doweling_orders',
          values: {
            doweling_order_name: values.doweling_order_name.trim(),
            doweling_order_date: orderDate || new Date().toISOString().split('T')[0],
            design_engineer_id: values.design_engineer_id,
            operator_id: values.design_engineer_id, // По умолчанию тот же что и конструктор
            payment_status_id: 1, // По умолчанию - первый статус (обычно "Не оплачен")
            production_status_id: 1, // По умолчанию - первый статус
            discount: 0,
            paid_amount: 0,
            parts_count: 0,
            delete_flag: false,
            version: 0,
          },
        });

        const newDowelingOrderId = dowelingResult.data.doweling_order_id;
        const newDowelingOrderName = dowelingResult.data.doweling_order_name;

        // Шаг 2: Создаем связь в order_doweling_links
        const linkResult = await createDowelingLink({
          resource: 'order_doweling_links',
          values: {
            order_id: orderId,
            doweling_order_id: newDowelingOrderId,
            delete_flag: false,
            version: 0,
          },
        });

        const newLinkId = linkResult.data.order_doweling_link_id;

        notification.success({
          message: 'Присадка создана',
          description: `Заказ на присадку "${newDowelingOrderName}" успешно создан и связан с заказом`,
        });
        form.resetFields();
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
      modalRender={(modal) => <DraggableModalWrapper open={open}>{modal}</DraggableModalWrapper>}
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
