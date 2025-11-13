// Quick Create Modal for Milling Type
// Allows creating a new milling type without leaving the order form

import React from 'react';
import { Modal, Form, Input, InputNumber, notification, Collapse } from 'antd';
import { useCreate } from '@refinedev/core';
import { numberFormatter, numberParser } from '../../../../utils/numberFormat';
import { DraggableModalWrapper } from '../../../../components/DraggableModalWrapper';

interface MillingTypeQuickCreateProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (millingTypeId: number) => void;
}

export const MillingTypeQuickCreate: React.FC<MillingTypeQuickCreateProps> = ({
  open,
  onClose,
  onSuccess,
}) => {
  const [form] = Form.useForm();
  const { mutate: createMillingType, isLoading } = useCreate();

  const handleOk = async () => {
    try {
      const values = await form.validateFields();

      createMillingType(
        {
          resource: 'milling_types',
          values: {
            milling_type_name: values.milling_type_name.trim(),
            cost_per_sqm: values.cost_per_sqm || null,
            sort_order: values.sort_order || 100,
            is_active: true,
          },
        },
        {
          onSuccess: (data) => {
            notification.success({
              message: 'Тип фрезеровки создан',
              description: `Тип "${values.milling_type_name}" успешно создан`,
            });
            form.resetFields();
            onSuccess(data.data.milling_type_id);
            onClose();
          },
          onError: (error: any) => {
            notification.error({
              message: 'Ошибка создания типа фрезеровки',
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
      title="Создать тип фрезеровки"
      open={open}
      onOk={handleOk}
      onCancel={handleCancel}
      confirmLoading={isLoading}
      okText="Создать"
      cancelText="Отмена"
      width={500}
      modalRender={(modal) => <DraggableModalWrapper open={open}>{modal}</DraggableModalWrapper>}
    >
      <Form form={form} layout="vertical" initialValues={{ sort_order: 100 }}>
        <Form.Item
          label="Название типа"
          name="milling_type_name"
          rules={[
            { required: true, message: 'Обязательное поле' },
            { max: 100, message: 'Максимум 100 символов' },
          ]}
        >
          <Input
            placeholder="Введите название типа фрезеровки"
            maxLength={100}
            autoFocus
          />
        </Form.Item>

        <Form.Item
          label="Цена за кв.м."
          name="cost_per_sqm"
          tooltip="Необязательно"
        >
          <InputNumber
            placeholder="0.00"
            min={0}
            precision={2}
            parser={numberParser}
            style={{ width: '100%' }}
            addonAfter="₸/м²"
          />
        </Form.Item>

        <Collapse
          defaultActiveKey={[]}
          items={[
            {
              key: 'sort_order',
              label: 'Порядок сортировки',
              children: (
                <Form.Item
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
              ),
            },
          ]}
        />
      </Form>
    </Modal>
  );
};
