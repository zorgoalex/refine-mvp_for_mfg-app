import { nameRule } from '../../utils/nameRules';
import { Edit, useForm, useSelect } from "@refinedev/antd";
import { IResourceComponentsProps, useGetIdentity } from "@refinedev/core";
import {
  Button,
  Card,
  Checkbox,
  Col,
  Divider,
  Form,
  Input,
  message,
  Row,
  Select,
} from "antd";
import { authStorage } from "../../utils/auth";
import { useEffect, useRef, useState } from "react";
import { createActionKeyStore } from "../../api/actionIdempotency";
import { advanceOwnVersion, formRowVersion } from "./userFormVersion";
import { usersApi } from "../../api/usersApi";
import { legacyApiRoutes } from "../../api/legacyApiRoutes";
import { featureFlags } from "../../config/featureFlags";
import type { UserIdentity } from "../../types/auth";
import { can } from "../../utils/permissions";
import { WorkosAdminLinksCard } from "./WorkosAdminLinksCard";
import { UserAccessGroupsCard, canViewUserAccessGroups } from "./UserAccessGroupsCard";
import {
  isCreationOnlyRole,
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
      setAuthorizationReload((value) => value + 1);
    },
  });

  const { selectProps: employeeSelectProps } = useSelect({
    resource: "employees",
    optionLabel: "full_name",
    optionValue: "employee_id",
    defaultValue: queryResult?.data?.data?.employee_id ?? undefined,
  });

  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordForm] = Form.useForm();
  // One Idempotency-Key per action, repeated while the same request is retried (lost response, network error).
  const saveKeys = useRef(createActionKeyStore()).current;
  const passwordKeys = useRef(createActionKeyStore()).current;
  // Row version advanced by this form's own confirmed commands (see userFormVersion): the next command compares with
  // it without reloading the form, which would drop unsaved fields.
  const [ownRowVersion, setOwnRowVersion] = useState<number | undefined>(undefined);
  const [authorizationReload, setAuthorizationReload] = useState(0);
  const currentVersion = () => formRowVersion(queryResult?.data?.data?.row_version, ownRowVersion);

  const userId = queryResult?.data?.data?.user_id ?? queryResult?.data?.data?.id;
  // The same route shows another user: versions confirmed for the previous one say nothing about this one, and an
  // answer to a command sent for the previous one must not advance them (shownUserId is compared on every answer).
  const shownUserId = useRef(userId);
  shownUserId.current = userId;
  useEffect(() => {
    setOwnRowVersion(undefined);
  }, [userId]);
  const advanceFor = (requestUserId: unknown, sent: number | undefined, returned: number | undefined) => {
    if (String(shownUserId.current) !== String(requestUserId)) return;
    setOwnRowVersion((own) => advanceOwnVersion(own, sent, returned));
  };
  // «Оператор интеграции 1С» назначается только при создании: у такой учётки роль не меняется, другим не предлагается.
  const roleLocked = isCreationOnlyRole(queryResult?.data?.data?.role);
  const canManageSso = can("users.manage_sso", identity);

  const handlePasswordChange = async (values: { new_password: string }) => {
    setPasswordLoading(true);
    try {
      if (featureFlags.useBackendUsers) {
        const expectedVersion = currentVersion();
        const request = {
          newPassword: values.new_password,
          revokeExistingSessions: true,
          ...(typeof expectedVersion === 'number' ? { expectedVersion } : {}),
        };
        const key = passwordKeys.keyFor(request);
        const requestUserId = userId;
        const response = await usersApi.changePassword(Number(requestUserId), request, key);
        passwordKeys.succeeded(key);
        advanceFor(requestUserId, expectedVersion, response.rowVersion);

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
      const expectedVersion = currentVersion();
      const request = mapBackendUpdateUserRequest(values, expectedVersion);
      const key = saveKeys.keyFor(request);
      const requestUserId = userId;
      usersApi.update(Number(requestUserId), request, key).then((response) => {
        saveKeys.succeeded(key);
        advanceFor(requestUserId, expectedVersion, response.user.rowVersion);
        // Role or activity may have changed the effective rights shown in the access groups card.
        setAuthorizationReload((value) => value + 1);
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
        <Row gutter={[16, 0]}>
          <Col xs={24} md={12}>
            <Form.Item
              label="Логин"
              name="username"
              rules={[...([
                { required: true, message: 'Пожалуйста, введите логин' },
                { min: 3, message: 'Логин должен содержать минимум 3 символа' },
              ]), nameRule("username")]}
            >
              <Input placeholder="ivanov" disabled />
            </Form.Item>
          </Col>

          <Col xs={24} md={12}>
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
          </Col>

          <Col xs={24} md={12}>
            <Form.Item label="Полное имя" name="full_name" rules={[nameRule("full_name", 255, 0)]}>
              <Input placeholder="Иванов Иван Иванович" />
            </Form.Item>
          </Col>

          <Col xs={24} sm={12} md={8}>
            <Form.Item
              label="Роль"
              name="role"
              rules={[{ required: true, message: 'Пожалуйста, выберите роль' }]}
              extra={roleLocked ? 'Роль назначается при создании пользователя и не меняется. Чтобы снять доступ — отключите учётную запись.' : undefined}
            >
              <Select placeholder="Выберите роль пользователя" disabled={roleLocked}>
                {roleLocked && (
                  <Select.Option value="onec_operator">Оператор интеграции 1С (onec_operator)</Select.Option>
                )}
                <Select.Option value="admin">Администратор (admin)</Select.Option>
                <Select.Option value="manager">Менеджер (manager)</Select.Option>
                <Select.Option value="operator">Оператор (operator)</Select.Option>
                <Select.Option value="top_manager">Топ-менеджер (top_manager)</Select.Option>
                <Select.Option value="worker">Работник (worker)</Select.Option>
                <Select.Option value="packer">Упаковщик (packer)</Select.Option>
                <Select.Option value="viewer">Наблюдатель (viewer)</Select.Option>
              </Select>
            </Form.Item>
          </Col>

          {featureFlags.useBackendUsers && (
            <Col xs={24} md={12}>
              <Form.Item label="Сотрудник" name="employee_id" normalize={(value) => value ?? null}
                extra="Несколько пользователей могут быть связаны с одним сотрудником">
                <Select {...employeeSelectProps} allowClear showSearch placeholder="Не связан" />
              </Form.Item>
            </Col>
          )}

          <Col xs={24} sm={12} md={4}>
            <Form.Item label="Статус" name="is_active" valuePropName="checked">
              <Checkbox>Активен</Checkbox>
            </Form.Item>
          </Col>
        </Row>
      </Form>

      {canViewUserAccessGroups() && userId != null && (
        <UserAccessGroupsCard
          key={String(userId)}
          userId={Number(userId)}
          // Only a group command sent from this form's own baseline moves it: one sent from a newer version (after a
          // conflict) must leave the form stale, or its old fields (role, activity) would pass the next check.
          onVersionAdvanced={(sent, returned) => {
            if (sent === currentVersion()) advanceFor(userId, sent, returned);
          }}
          reloadKey={authorizationReload}
        />
      )}

      <Divider />

      <Card title="Изменить пароль" style={{ marginTop: 16 }}>
        <Form
          form={passwordForm}
          layout="vertical"
          onFinish={handlePasswordChange}
        >
          <Row gutter={[16, 0]} align="bottom">
            <Col xs={24} md={16} xl={8}>
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
            </Col>

            <Col xs={24} md={8} xl={4}>
              <Form.Item>
                <Button type="primary" htmlType="submit" loading={passwordLoading}>
                  Изменить пароль
                </Button>
              </Form.Item>
            </Col>
          </Row>
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
