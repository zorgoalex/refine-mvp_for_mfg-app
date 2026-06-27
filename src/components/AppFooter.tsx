import React from "react";
import { Button, Drawer, Layout, List, Space, Tag, Tooltip, Typography } from "antd";
import { NotificationOutlined } from "@ant-design/icons";
import { authStorage } from "../utils/auth";
import { releaseNotes, REPOSITORY_LABELS, SERVICE_LABELS } from "../releaseNotes";
import { APP_VERSION } from "../version";

const decodeJwtPayload = (token: string): Record<string, any> | null => {
  try {
    const base64Url = token.split(".")[1];
    if (!base64Url) return null;
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64Url.length / 4) * 4, "=");
    const json = atob(base64);
    return JSON.parse(json);
  } catch (error) {
    console.warn("Не удалось разобрать JWT payload", error);
    return null;
  }
};

const formatSession = (minutes: number) => {
  if (minutes <= 0) return "<1 мин";
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours} ч` : `${hours} ч ${restMinutes} мин`;
};

export const AppFooter: React.FC = () => {
  const [isReleaseNotesOpen, setIsReleaseNotesOpen] = React.useState(false);
  const formattedDate = new Date().toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  const loginStartedAt = React.useMemo(() => {
    const token = authStorage.getAccessToken();
    if (!token) return null;
    const payload = decodeJwtPayload(token);
    return payload?.iat ? payload.iat * 1000 : null;
  }, []);

  const calcElapsed = React.useCallback(
    () => (loginStartedAt ? Math.max(0, Math.floor((Date.now() - loginStartedAt) / 60000)) : 0),
    [loginStartedAt]
  );

  const [elapsedMinutes, setElapsedMinutes] = React.useState<number>(calcElapsed);

  React.useEffect(() => {
    if (!loginStartedAt) return;
    setElapsedMinutes(calcElapsed());
    const interval = window.setInterval(() => {
      setElapsedMinutes(calcElapsed());
    }, 60_000);

    return () => window.clearInterval(interval);
  }, [calcElapsed, loginStartedAt]);

  const sessionLabel = loginStartedAt ? formatSession(elapsedMinutes) : "—";

  return (
    <Layout.Footer
      style={{
        background: "var(--app-surface)",
        borderTop: "1px solid var(--app-border-soft)",
        padding: "8px 16px",
        position: "sticky",
        bottom: 0,
        zIndex: 5,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <Typography.Text type="secondary">Сегодня: {formattedDate}</Typography.Text>
        <Space size={12} wrap style={{ marginLeft: "auto" }}>
          <Typography.Text type="secondary">Сессия: {sessionLabel}</Typography.Text>
          <Typography.Text type="secondary">v{APP_VERSION}</Typography.Text>
          <Tooltip title="Журнал изменений">
            <Button
              aria-label="Открыть журнал изменений"
              icon={<NotificationOutlined />}
              shape="circle"
              size="small"
              onClick={() => setIsReleaseNotesOpen(true)}
            />
          </Tooltip>
        </Space>
      </div>
      <Drawer
        title={`Журнал изменений v${APP_VERSION}`}
        placement="right"
        width={520}
        open={isReleaseNotesOpen}
        onClose={() => setIsReleaseNotesOpen(false)}
      >
        <List
          dataSource={releaseNotes}
          renderItem={(entry) => (
            <List.Item>
              <Space direction="vertical" size={10} style={{ width: "100%" }}>
                <Space align="baseline" wrap>
                  <Typography.Title level={5} style={{ margin: 0 }}>
                    v{entry.version} — {entry.title}
                  </Typography.Title>
                  <Typography.Text type="secondary">{entry.date}</Typography.Text>
                </Space>
                <Space size={[4, 4]} wrap>
                  {entry.services.map((service) => (
                    <Tag key={service}>{SERVICE_LABELS[service]}</Tag>
                  ))}
                </Space>
                {entry.repositories?.length ? (
                  <Space size={[4, 4]} wrap>
                    {entry.repositories.map((repository) => (
                      <Tag key={repository} color="blue">
                        {REPOSITORY_LABELS[repository]}
                      </Tag>
                    ))}
                  </Space>
                ) : null}
                {entry.added?.length ? <ReleaseNoteSection title="Добавлено" items={entry.added} /> : null}
                {entry.changed?.length ? <ReleaseNoteSection title="Изменено" items={entry.changed} /> : null}
                {entry.fixed?.length ? <ReleaseNoteSection title="Исправлено" items={entry.fixed} /> : null}
              </Space>
            </List.Item>
          )}
        />
      </Drawer>
    </Layout.Footer>
  );
};

const ReleaseNoteSection: React.FC<{ title: string; items: string[] }> = ({ title, items }) => (
  <div>
    <Typography.Text strong>{title}</Typography.Text>
    <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
      {items.map((item) => (
        <li key={item}>
          <Typography.Text>{item}</Typography.Text>
        </li>
      ))}
    </ul>
  </div>
);

export default AppFooter;
