// Quick Create Modal for Film
// Allows creating a new film without leaving the order form

import React from 'react';
import { Modal, Form, Input, Switch, Select, notification, Divider } from 'antd';
import { useCreate } from '@refinedev/core';
import { useSelect } from '@refinedev/antd';
import { DraggableModalWrapper } from '../../../../components/DraggableModalWrapper';

interface FilmQuickCreateProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (filmId: number) => void;
}

export const FilmQuickCreate: React.FC<FilmQuickCreateProps> = ({
  open,
  onClose,
  onSuccess,
}) => {
  const [form] = Form.useForm();
  const { mutate: createFilm, isLoading } = useCreate();

  const { selectProps: filmTypeSelectProps } = useSelect({
    resource: 'film_types',
    optionLabel: 'film_type_name',
    optionValue: 'film_type_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    pagination: { mode: 'off' },
    queryOptions: { enabled: open },
  });

  const { selectProps: vendorSelectProps } = useSelect({
    resource: 'vendors',
    optionLabel: 'vendor_name',
    optionValue: 'vendor_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    pagination: { mode: 'off' },
    queryOptions: { enabled: open },
  });

  const handleOk = async () => {
    try {
      const values = await form.validateFields();

      createFilm(
        {
          resource: 'films',
          values: {
            film_name: values.film_name.trim(),
            film_type_id: values.film_type_id || null,
            vendor_id: values.vendor_id || null,
            film_texture: values.film_texture || false,
            is_active: true,
          },
        },
        {
          onSuccess: (data) => {
            notification.success({
              message: 'Плёнка создана',
              description: `Плёнка "${values.film_name}" успешно создана`,
            });
            form.resetFields();
            onSuccess(data.data.film_id);
            onClose();
          },
          onError: (error: any) => {
            notification.error({
              message: 'Ошибка создания плёнки',
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
      title="Создать плёнку"
      open={open}
      onOk={handleOk}
      onCancel={handleCancel}
      confirmLoading={isLoading}
      okText="Создать"
      cancelText="Отмена"
      width={500}
      modalRender={(modal) => <DraggableModalWrapper open={open}>{modal}</DraggableModalWrapper>}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ film_texture: false }}
      >
        <Form.Item
          label="Название плёнки"
          name="film_name"
          rules={[
            { required: true, message: 'Обязательное поле' },
            { max: 100, message: 'Максимум 100 символов' },
          ]}
        >
          <Input
            placeholder="Введите название плёнки"
            maxLength={100}
            autoFocus
          />
        </Form.Item>

        <Form.Item
          label="Тип плёнки"
          name="film_type_id"
        >
          <Select
            {...filmTypeSelectProps}
            allowClear
            placeholder="Выберите тип плёнки"
            showSearch
            filterOption={(input, option) =>
              ((option?.label as string) || '').toLowerCase().includes(input.toLowerCase())
            }
          />
        </Form.Item>

        <Form.Item
          label="Производитель"
          name="vendor_id"
        >
          <Select
            {...vendorSelectProps}
            allowClear
            placeholder="Выберите производителя"
            showSearch
            filterOption={(input, option) =>
              ((option?.label as string) || '').toLowerCase().includes(input.toLowerCase())
            }
          />
        </Form.Item>

        <Divider style={{ margin: '12px 0' }} />

        <Form.Item
          label="Фактура"
          name="film_texture"
          valuePropName="checked"
          tooltip="Включите, если плёнка имеет текстуру"
        >
          <Switch checkedChildren="Да" unCheckedChildren="Нет" />
        </Form.Item>
      </Form>
    </Modal>
  );
};
