import { Table } from '../../ui/tooltipDelay';
import React from "react";
import { DateField } from "@refinedev/antd";
import { Alert, Button, Card, Input, Modal, Space, Typography } from "antd";
import { DisconnectOutlined, LinkOutlined } from "@ant-design/icons";
import { DISPLAY_DATE_TIME_SECONDS_FORMAT } from "../../utils/dateFormat";
import { authApi, type WorkosLinkItem } from "../../api/authApi";
import { ApiError } from "../../api/httpClient";
import { markWorkosLinkIntent } from "../login/WorkosCallback";

/**
 * Профильный блок привязки входа через SSO (WorkOS AuthKit).
 * Рендерится только за флагом workosAuth (проверяет родитель).
 */
export const WorkosLinkCard: React.FC = () => {
  const [links, setLinks] = React.useState<WorkosLinkItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [unlinkError, setUnlinkError] = React.useState<string | null>(null);
  const [unlinkOpen, setUnlinkOpen] = React.useState(false);
  const [password, setPassword] = React.useState("");
  const [selectedLink, setSelectedLink] = React.useState<WorkosLinkItem | null>(null);
  const justLinked = React.useMemo(
    () => new URLSearchParams(window.location.search).get("sso") === "linked",
    [],
  );

  React.useEffect(() => {
    let active = true;

    authApi
      .workosListLinks()
      .then((response) => {
        if (!active) {
          return;
        }

        setLinks(response.links);
      })
      .catch(() => {
        if (!active) {
          return;
        }

        setError("Не удалось загрузить привязанные SSO-входы.");
        setLinks([]);
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
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

  const openUnlinkModal = (link: WorkosLinkItem) => {
    setSelectedLink(link);
    setPassword("");
    setUnlinkError(null);
    setUnlinkOpen(true);
  };

  const closeUnlinkModal = () => {
    setUnlinkOpen(false);
    setPassword("");
    setUnlinkError(null);
    setSelectedLink(null);
  };

  const confirmUnlink = async () => {
    if (!selectedLink) {
      return;
    }

    setBusy(true);
    setError(null);
    setUnlinkError(null);
    try {
      // Fresh access token up front: the unlink call itself never
      // refresh-replays (a wrong-password 401 must stay a single attempt).
      await authApi.refresh().catch(() => undefined);
      await authApi.workosUnlinkOne(selectedLink.identityId, password);
      setLinks((currentLinks) =>
        currentLinks.filter((link) => link.identityId !== selectedLink.identityId),
      );
      closeUnlinkModal();
    } catch (unlinkErrorValue) {
      setUnlinkError(describeError(unlinkErrorValue));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Вход через SSO"
      extra={
        <Button type="primary" icon={<LinkOutlined />} loading={busy} onClick={startLink}>
          Привязать ещё
        </Button>
      }
    >
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        {justLinked && <Alert type="success" message="SSO привязан к вашей учётной записи" showIcon />}
        {error && <Alert type="error" message={error} showIcon />}
        <Typography.Text>
          Привяжите внешний вход (пароль SSO / Google), чтобы входить без локального пароля.
        </Typography.Text>
        <Table<WorkosLinkItem>
          dataSource={links}
          rowKey="identityId"
          loading={loading}
          pagination={false}
          locale={{ emptyText: "Нет привязанных SSO-входов" }}
        >
          <Table.Column<WorkosLinkItem>
            dataIndex="authMethod"
            title="Тип входа"
            render={(authMethod: WorkosLinkItem["authMethod"]) => authMethod ?? "неизвестно"}
          />
          <Table.Column<WorkosLinkItem> dataIndex="emailAtLink" title="Email" />
          <Table.Column<WorkosLinkItem>
            dataIndex="linkedAt"
            title="Привязан"
            render={(value: string) => (
              <DateField value={value} format={DISPLAY_DATE_TIME_SECONDS_FORMAT} />
            )}
          />
          <Table.Column<WorkosLinkItem>
            dataIndex="lastLoginAt"
            title="Последний вход"
            render={(value: string | null) =>
              value ? <DateField value={value} format={DISPLAY_DATE_TIME_SECONDS_FORMAT} /> : "—"
            }
          />
          <Table.Column<WorkosLinkItem>
            key="actions"
            title=""
            render={(_, link) => (
              <Button
                danger
                icon={<DisconnectOutlined />}
                onClick={() => openUnlinkModal(link)}
              >
                Отвязать
              </Button>
            )}
          />
        </Table>
      </Space>

      <Modal
        title="Отвязать вход через SSO"
        open={unlinkOpen}
        onOk={confirmUnlink}
        onCancel={closeUnlinkModal}
        okText="Отвязать"
        cancelText="Отмена"
        okButtonProps={{ danger: true, loading: busy, disabled: password.length === 0 }}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Typography.Text>
            После отвязки вход будет возможен только по паролю. Подтвердите действие паролем.
          </Typography.Text>
          {selectedLink && (
            <Typography.Text type="secondary">{selectedLink.emailAtLink}</Typography.Text>
          )}
          {unlinkError && <Alert type="error" message={unlinkError} showIcon />}
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
