import { Create, useForm } from "@refinedev/antd";
import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { Form, Input, Select, Checkbox, message } from "antd";
import { authStorage } from "../../utils/auth";
import { useState } from "react";

export const UserCreate: React.FC<IResourceComponentsProps> = () => {
  const { list } = useNavigation();
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (values: any) => {
    setLoading(true);
    try {
      const token = authStorage.getAccessToken();

      if (!token) {
        message.error('Не авторизован');
        return;
      }

      const response = await fetch('/api/users/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          username: values.username,
          email: values.email,
          password: values.password,
          role: values.role,
          full_name: values.full_name,
          is_active: values.is_active ?? true,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        message.error(data.error || 'Ошибка создания пользователя');
        return;
      }

      message.success('Пользователь успешно создан');
      list('users');
    } catch (error) {
      console.error('Create user error:', error);
      message.error('Ошибка подключения к серверу');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Create
      saveButtonProps={{
        onClick: () => {
          // Trigger form submit
          document.getElementById('user-create-form')?.dispatchEvent(
            new Event('submit', { cancelable: true, bubbles: true })
          );
        },
        loading,
      }}
    >
      <Form
        id="user-create-form"
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{ is_active: true, role: 'viewer' }}
      >
        <Form.Item
          label="Логин"
          name="username"
          rules={[
            { required: true, message: 'Пожалуйста, введите логин' },
            { min: 2, message: 'Логин должен содержать минимум 2 символа' },
          ]}
        >
          <Input placeholder="ivanov" />
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
          label="Пароль"
          name="password"
          rules={[
            { required: true, message: 'Пожалуйста, введите пароль' },
            { min: 6, message: 'Пароль должен содержать минимум 6 символов' },
          ]}
        >
          <Input.Password placeholder="Минимум 6 символов" />
        </Form.Item>

        <Form.Item
          label="Роль"
          name="role"
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
    </Create>
  );
};
