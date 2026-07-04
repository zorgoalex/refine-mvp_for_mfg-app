import React from "react";
import { Alert, Button, Card, Input, Modal, Space, Typography } from "antd";
import { LinkOutlined, DisconnectOutlined } from "@ant-design/icons";
import { authApi } from "../../api/authApi";
import { ApiError } from "../../api/httpClient";
import { markWorkosLinkIntent } from "../login/WorkosCallback";

/**
 * Профильный блок привязки входа через SSO (WorkOS AuthKit).
 * Рендерится только за флагом workosAuth (проверяет родитель).
 */
export const WorkosLinkCard: React.FC = () => {
  const [linked, setLinked] = React.useState<boolean | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [unlinkOpen, setUnlinkOpen] = React.useState(false);
  const [password, setPassword] = React.useState("");
  const justLinked = React.useMemo(
    () => new URLSearchParams(window.location.search).get("sso") === "linked",
    [],
  );

  React.useEffect(() => {
    authApi
      .workosLinkStatus()
      .then((status) => setLinked(status.linked))
      .catch(() => setLinked(null));
  }, []);

  const startLink = async () => {
    setBusy(true);
    setError(null);
    try {
      const url = await authApi.workosLinkStartUrl();
      // Bind the intent to this flow's exact state (from the authorize URL):
      // a stale intent must not misroute a later normal SSO login.
      const state = new URL(url).searchParams.get("state") ?? "";
      markWorkosLinkIntent(state);
      window.location.assign(url);
    } catch (linkError) {
      setError(describeError(linkError));
      setBusy(false);
    }
  };

  const confirmUnlink = async () => {
    setBusy(true);
    setError(null);
    try {
      await authApi.workosUnlink(password);
      setLinked(false);
      setUnlinkOpen(false);
      setPassword("");
    } catch (unlinkError) {
      setError(describeError(unlinkError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Вход через SSO">
      <Space direction="vertical" style={{ width: "100%" }}>
        {justLinked && <Alert type="success" message="SSO привязан к вашей учётной записи" showIcon />}
        {error && <Alert type="error" message={error} showIcon />}
        {linked === null && <Typography.Text type="secondary">Статус привязки недоступен</Typography.Text>}
        {linked === false && (
          <>
            <Typography.Text>
              Привяжите внешний вход (пароль SSO / Google), чтобы входить без локального пароля.
            </Typography.Text>
            <Button type="primary" icon={<LinkOutlined />} loading={busy} onClick={startLink}>
              Привязать вход через SSO
            </Button>
          </>
        )}
        {linked === true && (
          <>
            <Typography.Text>Вход через SSO привязан.</Typography.Text>
            <Button danger icon={<DisconnectOutlined />} onClick={() => setUnlinkOpen(true)}>
              Отвязать
            </Button>
          </>
        )}
      </Space>

      <Modal
        title="Отвязать вход через SSO"
        open={unlinkOpen}
        onOk={confirmUnlink}
        onCancel={() => {
          setUnlinkOpen(false);
          setPassword("");
        }}
        okText="Отвязать"
        cancelText="Отмена"
        okButtonProps={{ danger: true, loading: busy, disabled: password.length === 0 }}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Typography.Text>
            После отвязки вход будет возможен только по паролю. Подтвердите действие паролем.
          </Typography.Text>
          <Input.Password
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Пароль"
            autoComplete="current-password"
          />
        </Space>
      </Modal>
    </Card>
  );
};

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "UNLINK_FORBIDDEN_EXTERNAL_POLICY") {
      return "Нельзя отвязать SSO: вход по паролю для вашей учётной записи отключён.";
    }
    if (error.code === "INVALID_CREDENTIALS") {
      return "Неверный пароль.";
    }
    if (error.code === "IDENTITY_CONFLICT") {
      return "Этот внешний аккаунт уже привязан к другому пользователю.";
    }
  }

  return "Операция не удалась, попробуйте ещё раз.";
}
