// Quick Create Modal for Dowelling Order
// Allows creating a new dowelling order linked to the main order

import React from 'react';
import { Modal, Form, Input, notification } from 'antd';
import { useCreate } from '@refinedev/core';
import { DraggableModalWrapper } from '../../../../components/DraggableModalWrapper';
import { authStorage } from '../../../../utils/auth';

interface DowellingOrderQuickCreateProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (dowellingOrderId: number, dowellingOrderName: string) => void;
  orderId?: number; // ID основного заказа (для связи)
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
  const { mutate: createDowellingOrder, isLoading } = useCreate();

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

      // Получаем ID текущего пользователя
      const userId = authStorage.getUserId();
      if (!userId) {
        notification.error({
          message: 'Ошибка авторизации',
          description: 'Не удалось определить текущего пользователя',
        });
        return;
      }

      // Создаем заказ на присадку
      createDowellingOrder(
        {
          resource: 'doweling_orders',
          values: {
            doweling_order_name: values.doweling_order_name.trim(),
            doweling_order_date: orderDate || new Date().toISOString().split('T')[0],
            order_id: orderId,
            payment_status_id: 1, // По умолчанию - первый статус (обычно "Не оплачен")
            discount: 0,
            paid_amount: 0,
            parts_count: 0,
            delete_flag: false,
            version: 0,
            created_by: userId,
          },
        },
        {
          onSuccess: (data) => {
            notification.success({
              message: 'Присадка создана',
              description: `Заказ на присадку "${values.doweling_order_name}" успешно создан`,
            });
            form.resetFields();
            onSuccess(data.data.doweling_order_id, data.data.doweling_order_name);
            onClose();
          },
          onError: (error: any) => {
            notification.error({
              message: 'Ошибка создания присадки',
              description: error?.message || 'Неизвестная ошибка',
            });
          },
        }
      );
    } catch (error) {
      // Validation failed
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
      confirmLoading={isLoading}
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
            { min: 1, message: 'Минимум 1 символ' },
            { max: 200, message: 'Максимум 200 символов' },
            {
              pattern: /^(?!\s)(?!.*\s$)/,
              message: 'Номер не должен начинаться или заканчиваться пробелом',
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
      </Form>
    </Modal>
  );
};
