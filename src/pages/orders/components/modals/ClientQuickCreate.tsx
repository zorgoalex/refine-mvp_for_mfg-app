// Quick Create Modal for Client
// Allows creating a new client without leaving the order form

import React from 'react';
import { Modal, Form, Input, Select, Checkbox, Space, notification, Radio } from 'antd';
import { useCreate } from '@refinedev/core';
import { PhoneOutlined, StarFilled } from '@ant-design/icons';
import { DraggableModalWrapper } from '../../../../components/DraggableModalWrapper';
import { PHONE_TYPE_LABELS } from '../../../../types/clients';

const PHONE_TYPE_OPTIONS = Object.entries(PHONE_TYPE_LABELS).map(([value, label]) => ({
  value,
  label,
}));

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
  const { mutateAsync: createClient, isLoading: isClientLoading } = useCreate();
  const { mutateAsync: createPhone } = useCreate();

  const handleOk = async () => {
    try {
      const values = await form.validateFields();

      const data = await createClient({
        resource: 'clients',
        values: {
          client_name: values.client_name.trim(),
          person_type: values.person_type || 'individual',
          is_active: true,
        },
        successNotification: false,
      });
      const clientId = data.data.client_id;

      if (values.phone_number?.trim()) {
        try {
          await createPhone({
            resource: 'client_phones',
            values: {
              client_id: clientId,
              phone_number: values.phone_number.trim(),
              phone_type: values.phone_type || 'mobile',
              is_primary: values.is_primary ?? true,
            },
            successNotification: false,
          });
        } catch (phoneError: any) {
          notification.error({
            message: 'Клиент создан, но телефон не сохранён',
            description:
              phoneError?.message ||
              `Клиент #${clientId} создан. Исправьте телефон и повторите сохранение в карточке клиента.`,
          });
          return;
        }
      }

      notification.success({
        message: 'Клиент создан',
        description: `Клиент "${values.client_name}" успешно создан`,
      });
      form.resetFields();
      onSuccess(clientId);
      onClose();
    } catch (error) {
      if (error instanceof Error) {
        notification.error({
          message: 'Ошибка создания клиента',
          description: error.message,
        });
      }
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
      confirmLoading={isClientLoading}
      okText="Создать"
      cancelText="Отмена"
      width={500}
      modalRender={(modal) => <DraggableModalWrapper open={open}>{modal}</DraggableModalWrapper>}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ person_type: 'individual', phone_type: 'mobile', is_primary: true }}
      >
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

        <Form.Item
          label="Тип лица"
          name="person_type"
          rules={[{ required: true, message: 'Выберите тип лица' }]}
        >
          <Radio.Group>
            <Radio value="individual">Физическое лицо</Radio>
            <Radio value="legal">Юридическое лицо</Radio>
          </Radio.Group>
        </Form.Item>

        <Form.Item
          label="Телефон"
          name="phone_number"
          rules={[
            { min: 7, message: 'Минимум 7 символов' },
            { max: 20, message: 'Максимум 20 символов' },
            {
              pattern: /^\+?[0-9\s\-\(\)]{7,20}$/,
              message: 'Неверный формат номера телефона',
            },
          ]}
        >
          <Input
            placeholder="+7 (XXX) XXX-XX-XX"
            prefix={<PhoneOutlined />}
          />
        </Form.Item>

        <Space style={{ width: '100%' }} size="middle">
          <Form.Item
            label="Тип телефона"
            name="phone_type"
            style={{ marginBottom: 0, width: 150 }}
          >
            <Select options={PHONE_TYPE_OPTIONS} />
          </Form.Item>

          <Form.Item
            name="is_primary"
            valuePropName="checked"
            style={{ marginBottom: 0, marginTop: 30 }}
          >
            <Checkbox>
              <Space>
                <StarFilled style={{ color: '#faad14' }} />
                Основной
              </Space>
            </Checkbox>
          </Form.Item>
        </Space>
      </Form>
    </Modal>
  );
};
