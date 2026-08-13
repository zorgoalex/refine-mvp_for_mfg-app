import React from "react";
import { Alert, Card, Spin, Typography } from "antd";
import { authApi } from "../../api/authApi";
import { ApiError } from "../../api/httpClient";
import { markWorkosInvitationIntent } from "./WorkosCallback";

const startedTokens = new Set<string>();

export const WorkosInvitationPage: React.FC = () => {
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
    if (!token) {
      setError("В ссылке отсутствует токен привязки.");
      return;
    }
    if (startedTokens.has(token)) {
      return;
    }
    startedTokens.add(token);

    authApi
      .workosInvitationStartUrl(token)
      .then((url) => {
        const state = new URL(url).searchParams.get("state") ?? "";
        markWorkosInvitationIntent(state);
        window.location.assign(url);
      })
      .catch((startError: unknown) => {
        startedTokens.delete(token);
        setError(describeError(startError));
      });
  }, []);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
      }}
    >
      <Card style={{ width: 440, textAlign: "center" }}>
        {error ? (
          <>
            <Typography.Title level={4}>Не удалось начать привязку SSO</Typography.Title>
            <Alert type="error" showIcon message={error} />
            <div style={{ marginTop: 16 }}>
              <a href="/login">Вернуться на страницу входа</a>
            </div>
          </>
        ) : (
          <>
            <Spin size="large" />
            <div style={{ marginTop: 16 }}>
              <Typography.Text>Открываем безопасную привязку SSO…</Typography.Text>
            </div>
          </>
        )}
      </Card>
    </div>
  );
};

function describeError(error: unknown): string {
  if (error instanceof ApiError && error.code === "SSO_INVITATION_INVALID") {
    return "Ссылка недействительна, истекла или уже использована. Запросите новую у администратора.";
  }
  return "Привязка SSO сейчас недоступна. Запросите новую ссылку у администратора.";
}
