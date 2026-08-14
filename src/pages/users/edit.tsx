import { Edit, useForm } from "@refinedev/antd";
import { IResourceComponentsProps, useGetIdentity } from "@refinedev/core";
import { Form, Input, Select, Checkbox, Button, Divider, message, Card } from "antd";
import { authStorage } from "../../utils/auth";
import { useState } from "react";
import { usersApi } from "../../api/usersApi";
import { legacyApiRoutes } from "../../api/legacyApiRoutes";
import { featureFlags } from "../../config/featureFlags";
import type { UserIdentity } from "../../types/auth";
import { can } from "../../utils/permissions";
import { WorkosAdminLinksCard } from "./WorkosAdminLinksCard";
import {
  mapBackendUpdateUserRequest,
  mapLegacyUserFormToHasuraPayload,
  mapUserRecordToFormData,
} from "./userFormMapping";

export const UserEdit: React.FC<IResourceComponentsProps> = () => {
  const { data: identity } = useGetIdentity<UserIdentity>();
  const { formProps, saveButtonProps, queryResult } = useForm({
    // Преобразуем данные при загрузке: role_id → role
    queryOptions: {
      select: (data) => ({
        ...data,
        data: mapUserRecordToFormData(data.data),
      }),
    },
    // Преобразуем данные при сохранении: role → role_id
    onMutationSuccess: () => {
      message.success('Данные пользователя обновлены');
    },
  });

  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordForm] = Form.useForm();

  const userId = queryResult?.data?.data?.user_id ?? queryResult?.data?.data?.id;
  const canManageSso = can("users.manage_sso", identity);

  const handlePasswordChange = async (values: { new_password: string }) => {
    setPasswordLoading(true);
    try {
      if (featureFlags.useBackendUsers) {
        await usersApi.changePassword(Number(userId), {
          newPassword: values.new_password,
          revokeExistingSessions: true,
        });

        message.success('Пароль успешно изменён');
        passwordForm.resetFields();
        return;
      }

      const token = authStorage.getAccessToken();

      if (!token) {
        message.error('Не авторизован');
        return;
      }

      const response = await fetch(legacyApiRoutes.users.changePassword, {
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

  // Кастомный onFinish для преобразования role → role_id
  const handleFinish = (values: any) => {
    if (featureFlags.useBackendUsers) {
      usersApi.update(Number(userId), mapBackendUpdateUserRequest(values)).then(() => {
        message.success('Данные пользователя обновлены');
      }).catch((error) => {
        console.error('Update user error:', error);
        message.error(error instanceof Error ? error.message : 'Ошибка обновления пользователя');
      });
      return;
    }

    // Вызываем оригинальный onFinish с преобразованными данными
    formProps.onFinish?.(mapLegacyUserFormToHasuraPayload(values));
  };

  return (
    <Edit saveButtonProps={saveButtonProps}>
      <Form {...formProps} layout="vertical" onFinish={handleFinish}>
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
          rules={[{ required: true, message: 'Пожалуйста, выберите роль' }]}
        >
          <Select placeholder="Выберите роль пользователя">
            <Select.Option value="admin">Администратор (admin)</Select.Option>
            <Select.Option value="manager">Менеджер (manager)</Select.Option>
            <Select.Option value="operator">Оператор (operator)</Select.Option>
            <Select.Option value="top_manager">Топ-менеджер (top_manager)</Select.Option>
            <Select.Option value="worker">Работник (worker)</Select.Option>
            <Select.Option value="packer">Упаковщик (packer)</Select.Option>
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
              { min: 8, message: 'Пароль должен содержать минимум 8 символов' },
            ]}
          >
            <Input.Password placeholder="Минимум 8 символов" />
          </Form.Item>

          <Form.Item>
            <Button type="primary" htmlType="submit" loading={passwordLoading}>
              Изменить пароль
            </Button>
          </Form.Item>
        </Form>
      </Card>

      {featureFlags.workosAuth && canManageSso && userId != null && (
        <>
          <Divider />
          <WorkosAdminLinksCard userId={String(userId)} />
        </>
      )}
    </Edit>
  );
};
