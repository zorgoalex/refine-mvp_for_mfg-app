import { Table } from '../../ui/tooltipDelay';
import React from "react";
import { DateField } from "@refinedev/antd";
import {
  Alert,
  Button,
  Card,
  Col,
  Divider,
  Input,
  Modal,
  Radio,
  Row,
  Space,
  Switch,
  Typography,
} from "antd";
import {
  CopyOutlined,
  DisconnectOutlined,
  LinkOutlined,
  SaveOutlined,
} from "@ant-design/icons";
import { DISPLAY_DATE_TIME_SECONDS_FORMAT } from "../../utils/dateFormat";
import {
  authApi,
  type WorkosLinkItem,
  type WorkosUserSettings,
} from "../../api/authApi";
import { ApiError } from "../../api/httpClient";

interface WorkosAdminLinksCardProps {
  userId: string;
}

export const WorkosAdminLinksCard: React.FC<WorkosAdminLinksCardProps> = ({ userId }) => {
  const [links, setLinks] = React.useState<WorkosLinkItem[]>([]);
  const [settings, setSettings] = React.useState<WorkosUserSettings | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [unlinkError, setUnlinkError] = React.useState<string | null>(null);
  const [unlinkOpen, setUnlinkOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [selectedLink, setSelectedLink] = React.useState<WorkosLinkItem | null>(null);
  const [invitation, setInvitation] = React.useState<{
    invitationUrl: string;
    expiresAt: string;
  } | null>(null);
  const [copyStatus, setCopyStatus] = React.useState<string | null>(null);
  const [invitationNotice, setInvitationNotice] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;

    setLoading(true);
    setError(null);
    Promise.all([
      authApi.workosAdminListLinks(userId),
      authApi.workosAdminGetSettings(userId),
    ])
      .then(([response, settingsResponse]) => {
        if (!active) {
          return;
        }

        setLinks(response.links);
        setSettings(settingsResponse);
      })
      .catch(() => {
        if (!active) {
          return;
        }

        setError("Не удалось загрузить привязанные SSO-входы пользователя.");
        setLinks([]);
        setSettings(null);
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [userId]);

  const saveSettings = async () => {
    if (!settings) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await authApi.refresh().catch(() => undefined);
      setSettings(await authApi.workosAdminUpdateSettings(userId, settings));
    } catch (settingsError) {
      setError(describeError(settingsError));
    } finally {
      setBusy(false);
    }
  };

  const createInvitation = async () => {
    setBusy(true);
    setError(null);
    setCopyStatus(null);
    setInvitationNotice(null);
    try {
      await authApi.refresh().catch(() => undefined);
      setInvitation(await authApi.workosAdminCreateInvitation(userId));
    } catch (invitationError) {
      setError(describeError(invitationError));
    } finally {
      setBusy(false);
    }
  };

  const revokeInvitations = async () => {
    setBusy(true);
    setError(null);
    setInvitationNotice(null);
    try {
      await authApi.refresh().catch(() => undefined);
      const result = await authApi.workosAdminRevokeInvitations(userId);
      setInvitation(null);
      setCopyStatus(null);
      setInvitationNotice(
        result.revoked
          ? "Активная ссылка привязки отозвана."
          : "Активных ссылок привязки не было.",
      );
    } catch (revokeError) {
      setError(describeError(revokeError));
    } finally {
      setBusy(false);
    }
  };

  const copyInvitation = async () => {
    if (!invitation) {
      return;
    }
    try {
      await navigator.clipboard.writeText(invitation.invitationUrl);
      setCopyStatus("Ссылка скопирована");
    } catch {
      setCopyStatus("Не удалось скопировать автоматически — скопируйте поле вручную");
    }
  };

  const openUnlinkModal = (link: WorkosLinkItem) => {
    setSelectedLink(link);
    setReason("");
    setUnlinkError(null);
    setUnlinkOpen(true);
  };

  const closeUnlinkModal = () => {
    setUnlinkOpen(false);
    setReason("");
    setUnlinkError(null);
    setSelectedLink(null);
  };

  const confirmUnlink = async () => {
    if (!selectedLink) {
      return;
    }

    setBusy(true);
    setUnlinkError(null);
    try {
      await authApi.refresh().catch(() => undefined);
      await authApi.workosAdminUnlinkOne(
        userId,
        selectedLink.identityId,
        reason.trim() || undefined,
      );
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
    <Card title="SSO-доступ пользователя">
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {error && <Alert type="error" message={error} showIcon />}
        {invitationNotice && <Alert type="success" message={invitationNotice} showIcon />}
        <Typography.Title level={5} style={{ margin: 0 }}>
          Разрешённые способы входа
        </Typography.Title>
        <Typography.Text type="secondary">
          Список ниже — точный набор внешних аккаунтов, которыми разрешён вход этому
          пользователю.
        </Typography.Text>
        <Row gutter={[16, 16]} align="middle">
          <Col xs={24} xl={12} xxl={8}>
            <Radio.Group
              value={settings?.loginPolicy}
              disabled={!settings || loading || busy}
              onChange={(event) =>
                setSettings((current) =>
                  current ? { ...current, loginPolicy: event.target.value } : current,
                )
              }
            >
              <Radio.Button value="both">Пароль и SSO</Radio.Button>
              <Radio.Button value="external">Только SSO</Radio.Button>
              <Radio.Button value="local">Только пароль</Radio.Button>
            </Radio.Group>
          </Col>
          <Col xs={24} md={12} xl={6} xxl={8}>
            <Space align="start">
              <Switch
                checked={settings?.selfLinkEnabled ?? false}
                disabled={!settings || loading || busy}
                onChange={(checked) =>
                  setSettings((current) =>
                    current ? { ...current, selfLinkEnabled: checked } : current,
                  )
                }
              />
              <Typography.Text>Пользователь может сам привязывать новые SSO-входы</Typography.Text>
            </Space>
          </Col>
          <Col xs={24} md={12} xl={6} xxl={8}>
            <Space align="start">
              <Switch
                checked={settings?.selfUnlinkEnabled ?? false}
                disabled={!settings || loading || busy}
                onChange={(checked) =>
                  setSettings((current) =>
                    current ? { ...current, selfUnlinkEnabled: checked } : current,
                  )
                }
              />
              <Typography.Text>Пользователь может сам отвязывать SSO-входы</Typography.Text>
            </Space>
          </Col>
        </Row>
        <Space wrap>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={busy}
            disabled={!settings || loading}
            onClick={saveSettings}
          >
            Сохранить настройки
          </Button>
          <Button
            icon={<LinkOutlined />}
            loading={busy}
            disabled={loading}
            onClick={createInvitation}
          >
            Создать ссылку для привязки
          </Button>
          <Button
            danger
            icon={<DisconnectOutlined />}
            loading={busy}
            disabled={loading}
            onClick={() => {
              Modal.confirm({
                title: "Отозвать активную ссылку привязки?",
                content: "Уже переданная ссылка перестанет работать. Привязанные SSO-входы не изменятся.",
                okText: "Отозвать",
                cancelText: "Отмена",
                okButtonProps: { danger: true },
                onOk: revokeInvitations,
              });
            }}
          >
            Отозвать активную ссылку
          </Button>
        </Space>
        <Alert
          type="info"
          showIcon
          message="Одноразовая ссылка действует 24 часа"
          description="Откройте её в браузере и выберите нужный внешний аккаунт. Новая ссылка отменяет предыдущую неиспользованную ссылку этого пользователя."
        />
        <Typography.Text type="secondary">
          Изменение режима входа завершает активные сессии пользователя.
        </Typography.Text>
        <Divider style={{ margin: "4px 0" }} />
        <Typography.Title level={5} style={{ margin: 0 }}>
          Привязанные SSO-входы
        </Typography.Title>
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
        title="Одноразовая ссылка для привязки SSO"
        open={invitation !== null}
        onCancel={() => {
          setInvitation(null);
          setCopyStatus(null);
        }}
        footer={[
          <Button
            key="close"
            onClick={() => {
              setInvitation(null);
              setCopyStatus(null);
            }}
          >
            Закрыть
          </Button>,
          <Button key="copy" type="primary" icon={<CopyOutlined />} onClick={copyInvitation}>
            Скопировать ссылку
          </Button>,
        ]}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Alert
            type="warning"
            showIcon
            message="Ссылка даёт право привязать один внешний аккаунт к этому пользователю"
            description="Передавайте её только нужному человеку. После успешной привязки ссылка перестанет работать."
          />
          <Input.TextArea
            readOnly
            value={invitation?.invitationUrl ?? ""}
            autoSize={{ minRows: 3, maxRows: 5 }}
            onFocus={(event) => event.currentTarget.select()}
          />
          {invitation && (
            <Typography.Text type="secondary">
              Действует до{" "}
              <DateField
                value={invitation.expiresAt}
                format={DISPLAY_DATE_TIME_SECONDS_FORMAT}
              />
            </Typography.Text>
          )}
          {copyStatus && <Typography.Text>{copyStatus}</Typography.Text>}
        </Space>
      </Modal>

      <Modal
        title="Отвязать SSO-вход пользователя"
        open={unlinkOpen}
        onOk={confirmUnlink}
        onCancel={closeUnlinkModal}
        okText="Отвязать"
        cancelText="Отмена"
        okButtonProps={{ danger: true, loading: busy }}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Typography.Text>
            SSO-вход будет удалён, а все активные сессии пользователя завершены. При
            необходимости оставьте причину отвязки.
          </Typography.Text>
          {selectedLink && (
            <Typography.Text type="secondary">{selectedLink.emailAtLink}</Typography.Text>
          )}
          {unlinkError && <Alert type="error" message={unlinkError} showIcon />}
          <Input.TextArea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Причина отвязки"
            autoSize={{ minRows: 2, maxRows: 4 }}
          />
        </Space>
      </Modal>
    </Card>
  );
};

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return "линк не найден";
    }
    if (error.code === "UNLINK_FORBIDDEN_EXTERNAL_POLICY") {
      return "Нельзя отвязать SSO: вход по паролю для этой учётной записи отключён.";
    }
    if (error.code === "SSO_IDENTITY_REQUIRED") {
      return "Для режима «Только SSO» сначала привяжите хотя бы один внешний аккаунт.";
    }
    if (error.code === "SESSION_INACTIVE") {
      return "Сессия администратора завершена. Войдите заново.";
    }
  }

  return "Операция не удалась, попробуйте ещё раз.";
}
