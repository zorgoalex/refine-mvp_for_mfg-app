// Quick Create Modal for Client
// Allows creating a new client without leaving the order form

import React, { useState } from 'react';
import { Modal, Form, Input, notification } from 'antd';
import { useCreate } from '@refinedev/core';
import { DraggableModalWrapper } from '../../../../components/DraggableModalWrapper';

interface ClientQuickCreateProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (clientId: number) => void;
}

export const ClientQuickCreate: React.FC<ClientQuickCreateProps> = ({
  open,
  onClose,
  onSuccess,
}) => {
  const [form] = Form.useForm();
  const { mutate: createClient, isLoading } = useCreate();

  const handleOk = async () => {
    try {
      const values = await form.validateFields();

      createClient(
        {
          resource: 'clients',
          values: {
            client_name: values.client_name.trim(),
            is_active: true,
          },
        },
        {
          onSuccess: (data) => {
            notification.success({
              message: 'Клиент создан',
              description: `Клиент "${values.client_name}" успешно создан`,
            });
            form.resetFields();
            onSuccess(data.data.client_id);
            onClose();
          },
          onError: (error: any) => {
            notification.error({
              message: 'Ошибка создания клиента',
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
      title="Создать клиента"
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
          label="Название клиента"
          name="client_name"
          rules={[
            { required: true, message: 'Обязательное поле' },
            { min: 2, message: 'Минимум 2 символа' },
            { max: 200, message: 'Максимум 200 символов' },
            {
              pattern: /^(?!\s)(?!.*\s$)/,
              message: 'Название не должно начинаться или заканчиваться пробелом',
            },
          ]}
        >
          <Input
            placeholder="Введите название клиента"
            maxLength={200}
            autoFocus
          />
        </Form.Item>
      </Form>
    </Modal>
  );
};
