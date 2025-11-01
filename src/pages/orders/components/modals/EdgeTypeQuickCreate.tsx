// Quick Create Modal for Edge Type
// Allows creating a new edge type without leaving the order form

import React from 'react';
import { Modal, Form, Input, InputNumber, notification } from 'antd';
import { useCreate } from '@refinedev/core';
import { numberFormatter, numberParser } from '../../../../utils/numberFormat';

interface EdgeTypeQuickCreateProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (edgeTypeId: number) => void;
}

export const EdgeTypeQuickCreate: React.FC<EdgeTypeQuickCreateProps> = ({
  open,
  onClose,
  onSuccess,
}) => {
  const [form] = Form.useForm();
  const { mutate: createEdgeType, isLoading } = useCreate();

  const handleOk = async () => {
    try {
      const values = await form.validateFields();

      createEdgeType(
        {
          resource: 'edge_types',
          values: {
            edge_type_name: values.edge_type_name.trim(),
            sort_order: values.sort_order || 100,
            is_active: true,
          },
        },
        {
          onSuccess: (data) => {
            notification.success({
              message: 'Тип кромки создан',
              description: `Тип "${values.edge_type_name}" успешно создан`,
            });
            form.resetFields();
            onSuccess(data.data.edge_type_id);
            onClose();
          },
          onError: (error: any) => {
            notification.error({
              message: 'Ошибка создания типа кромки',
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
      title="Создать тип кромки"
      open={open}
      onOk={handleOk}
      onCancel={handleCancel}
      confirmLoading={isLoading}
      okText="Создать"
      cancelText="Отмена"
      width={500}
    >
      <Form form={form} layout="vertical" initialValues={{ sort_order: 100 }}>
        <Form.Item
          label="Название типа"
          name="edge_type_name"
          rules={[
            { required: true, message: 'Обязательное поле' },
            { max: 50, message: 'Максимум 50 символов' },
          ]}
        >
          <Input
            placeholder="Введите название типа кромки"
            maxLength={50}
            autoFocus
          />
        </Form.Item>

        <Form.Item
          label="Порядок сортировки"
          name="sort_order"
          tooltip="Определяет порядок отображения в списках"
        >
          <InputNumber
            min={1}
            max={32767}
            formatter={(value) => numberFormatter(value, 0)}
            parser={numberParser}
            style={{ width: '100%' }}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
};
