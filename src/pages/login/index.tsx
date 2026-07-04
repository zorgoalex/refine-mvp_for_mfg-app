import React from "react";
import { Form, Input, Button, Card, Typography } from "antd";
import { UserOutlined, LockOutlined, LoginOutlined } from "@ant-design/icons";
import { useLogin } from "@refinedev/core";
import { featureFlags } from "../../config/featureFlags";

const { Title, Text } = Typography;

/**
 * Кастомная страница входа в систему
 * Использует username вместо email для аутентификации
 */
export const LoginPage: React.FC = () => {
  const { mutate: login, isLoading } = useLogin();

  const onFinish = (values: { username: string; password: string }) => {
    login(values);
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
      }}
    >
      <Card
        style={{
          width: 400,
          boxShadow: "0 20px 60px rgba(0, 0, 0, 0.3)",
          borderRadius: 8,
        }}
      >
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <Title level={2} style={{ margin: 0, fontSize: 28, fontWeight: 600 }}>
            ERP Zhihaz
          </Title>
          <Text type="secondary" style={{ fontSize: 14 }}>
            Система управления производством
          </Text>
        </div>

        <Form
          name="login"
          onFinish={onFinish}
          layout="vertical"
          requiredMark={false}
          size="large"
        >
          <Form.Item
            name="username"
            rules={[
              {
                required: true,
                message: "Пожалуйста, введите имя пользователя",
              },
            ]}
          >
            <Input
              id="username"
              prefix={<UserOutlined style={{ color: "#bfbfbf" }} />}
              placeholder="Имя пользователя"
              autoComplete="username"
            />
          </Form.Item>

          <Form.Item
            name="password"
            rules={[
              {
                required: true,
                message: "Пожалуйста, введите пароль",
              },
            ]}
          >
            <Input.Password
              id="password"
              prefix={<LockOutlined style={{ color: "#bfbfbf" }} />}
              placeholder="Пароль"
              autoComplete="current-password"
            />
          </Form.Item>

          <Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              block
              loading={isLoading}
              style={{ height: 40 }}
            >
              Войти
            </Button>
          </Form.Item>
        </Form>

        {featureFlags.workosAuth && <WorkosSsoButton />}
      </Card>
    </div>
  );
};

/** Вход через hosted SSO (WorkOS AuthKit); виден только за флагом workosAuth. */
const WorkosSsoButton: React.FC = () => {
  const [redirecting, setRedirecting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const startSso = async () => {
    setRedirecting(true);
    setError(null);
    try {
      const { authApi } = await import("../../api/authApi");
      const url = await authApi.workosAuthorizeUrl();
      window.location.assign(url);
    } catch {
      setError("SSO недоступен, войдите по паролю");
      setRedirecting(false);
    }
  };

  return (
    <div style={{ marginTop: 8 }}>
      <Button
        block
        icon={<LoginOutlined />}
        loading={redirecting}
        onClick={startSso}
        style={{ height: 40 }}
      >
        Войти через SSO
      </Button>
      {error && (
        <Text type="danger" style={{ display: "block", marginTop: 8, textAlign: "center" }}>
          {error}
        </Text>
      )}
    </div>
  );
};
