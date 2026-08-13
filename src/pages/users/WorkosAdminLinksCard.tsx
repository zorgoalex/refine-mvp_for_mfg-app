import { Table } from '../../ui/tooltipDelay';
import React from "react";
import { DateField } from "@refinedev/antd";
import { Alert, Button, Card, Input, Modal, Space, Typography } from "antd";
import { DisconnectOutlined } from "@ant-design/icons";
import { DISPLAY_DATE_TIME_SECONDS_FORMAT } from "../../utils/dateFormat";
import { authApi, type WorkosLinkItem } from "../../api/authApi";
import { ApiError } from "../../api/httpClient";

interface WorkosAdminLinksCardProps {
  userId: string;
}

export const WorkosAdminLinksCard: React.FC<WorkosAdminLinksCardProps> = ({ userId }) => {
  const [links, setLinks] = React.useState<WorkosLinkItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [unlinkError, setUnlinkError] = React.useState<string | null>(null);
  const [unlinkOpen, setUnlinkOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [selectedLink, setSelectedLink] = React.useState<WorkosLinkItem | null>(null);

  React.useEffect(() => {
    let active = true;

    setLoading(true);
    setError(null);
    authApi
      .workosAdminListLinks(userId)
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

        setError("Не удалось загрузить привязанные SSO-входы пользователя.");
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
  }, [userId]);

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
    <Card title="SSO-связки пользователя">
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {error && <Alert type="error" message={error} showIcon />}
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
            При необходимости оставьте причину отвязки. Поле необязательное.
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
  }

  return "Операция не удалась, попробуйте ещё раз.";
}
