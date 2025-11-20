import { Edit, useForm } from "@refinedev/antd";
import { IResourceComponentsProps, useOne } from "@refinedev/core";
import { Form, Input, Select, Checkbox, Button, Divider, message, Card } from "antd";
import { authStorage } from "../../utils/auth";
import { useState } from "react";

export const UserEdit: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps, queryResult } = useForm();
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordForm] = Form.useForm();

  const userId = queryResult?.data?.data?.user_id;

  // Преобразуем role_id в role name для отображения
  const roleIdMap: Record<number, string> = {
    1: 'admin',
    10: 'manager',
    11: 'operator',
    15: 'top_manager',
    20: 'worker',
    100: 'viewer',
  };

  // Обратная карта для сохранения
  const roleNameToId: Record<string, number> = {
    admin: 1,
    manager: 10,
    operator: 11,
    top_manager: 15,
    worker: 20,
    viewer: 100,
  };

  // Преобразуем данные для отображения
  const initialValues = queryResult?.data?.data;
  const roleForDisplay = initialValues?.role_id ? roleIdMap[initialValues.role_id] : undefined;

  const handlePasswordChange = async (values: { new_password: string }) => {
    setPasswordLoading(true);
    try {
      const token = authStorage.getAccessToken();

      if (!token) {
        message.error('Не авторизован');
        return;
      }

      const response = await fetch('/api/users/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          user_id: userId,
          new_password: values.new_password,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        message.error(data.error || 'Ошибка смены пароля');
        return;
      }

      message.success('Пароль успешно изменён');
      passwordForm.resetFields();
    } catch (error) {
      console.error('Change password error:', error);
      message.error('Ошибка подключения к серверу');
    } finally {
      setPasswordLoading(false);
    }
  };

  return (
    <Edit
      saveButtonProps={{
        ...saveButtonProps,
        onClick: () => {
          // Преобразуем role обратно в role_id перед сохранением
          const values = formProps.form?.getFieldsValue();
          if (values?.role) {
            formProps.form?.setFieldsValue({
              ...values,
              role_id: roleNameToId[values.role],
            });
          }
          saveButtonProps.onClick?.();
        },
      }}
    >
      <Form {...formProps} layout="vertical">
        <Form.Item
          label="Логин"
          name="username"
          rules={[
            { required: true, message: 'Пожалуйста, введите логин' },
            { min: 2, message: 'Логин должен содержать минимум 2 символа' },
          ]}
        >
          <Input placeholder="ivanov" disabled />
        </Form.Item>

        <Form.Item
          label="Email"
          name="email"
          rules={[
            { required: true, message: 'Пожалуйста, введите email' },
            { type: 'email', message: 'Введите корректный email' },
          ]}
        >
          <Input placeholder="ivanov@mebelkz.local" />
        </Form.Item>

        <Form.Item
          label="Роль"
          name="role"
          initialValue={roleForDisplay}
          rules={[{ required: true, message: 'Пожалуйста, выберите роль' }]}
        >
          <Select placeholder="Выберите роль пользователя">
            <Select.Option value="admin">Администратор (admin)</Select.Option>
            <Select.Option value="manager">Менеджер (manager)</Select.Option>
            <Select.Option value="operator">Оператор (operator)</Select.Option>
            <Select.Option value="top_manager">Топ-менеджер (top_manager)</Select.Option>
            <Select.Option value="worker">Работник (worker)</Select.Option>
            <Select.Option value="viewer">Наблюдатель (viewer)</Select.Option>
          </Select>
        </Form.Item>

        <Form.Item label="Полное имя" name="full_name">
          <Input placeholder="Иванов Иван Иванович" />
        </Form.Item>

        <Form.Item label="Активен" name="is_active" valuePropName="checked">
          <Checkbox />
        </Form.Item>
      </Form>

      <Divider />

      <Card title="Изменить пароль" style={{ marginTop: 16 }}>
        <Form
          form={passwordForm}
          layout="vertical"
          onFinish={handlePasswordChange}
        >
          <Form.Item
            label="Новый пароль"
            name="new_password"
            rules={[
              { required: true, message: 'Пожалуйста, введите новый пароль' },
              { min: 6, message: 'Пароль должен содержать минимум 6 символов' },
            ]}
          >
            <Input.Password placeholder="Минимум 6 символов" />
          </Form.Item>

          <Form.Item>
            <Button type="primary" htmlType="submit" loading={passwordLoading}>
              Изменить пароль
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </Edit>
  );
};
