import React from "react";
import { Layout, Typography } from "antd";
import { authStorage } from "../utils/auth";

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
        background: "#fff",
        borderTop: "1px solid #f0f0f0",
        padding: "8px 16px",
        position: "sticky",
        bottom: 0,
        zIndex: 5,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <Typography.Text type="secondary">Сегодня: {formattedDate}</Typography.Text>
        <Typography.Text type="secondary">Сессия: {sessionLabel}</Typography.Text>
      </div>
    </Layout.Footer>
  );
};

export default AppFooter;
