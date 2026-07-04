import React from "react";
import { Card, Spin, Typography } from "antd";
import { useNavigate, useSearchParams } from "react-router-dom";
import { authApi } from "../../api/authApi";
import { ApiError } from "../../api/httpClient";

// Module-level guard: the AuthKit code is single-use, and React StrictMode in
// dev double-mounts this page, so a ref inside the component is not enough.
const consumedCodes = new Set<string>();

const LINK_INTENT_KEY = "erp_workos_link_intent";

/**
 * Binds the link intent to the EXACT state of the started flow: a stale flag
 * from an aborted link attempt must not misroute the next normal SSO login
 * into the link callback (state values never match across flows).
 */
export function markWorkosLinkIntent(state: string): void {
  sessionStorage.setItem(LINK_INTENT_KEY, state);
}

/**
 * Callback of the hosted AuthKit flow, shared by both modes:
 * - login: exchanges code+state for a regular ERP session;
 * - link (marked before redirect via markWorkosLinkIntent): restores the ERP
 *   session from the refresh cookie first (the in-memory access token does
 *   not survive the redirect), then finishes linking with a bearer token.
 */
export const WorkosCallbackPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const code = searchParams.get("code");
    const state = searchParams.get("state");

    if (!code || !state) {
      setError("Не получены параметры от провайдера входа");
      return;
    }
    if (consumedCodes.has(code)) {
      return;
    }
    consumedCodes.add(code);

    // Link mode only when the stored intent matches THIS flow's state; a
    // stale flag from an aborted link attempt is discarded, not trusted.
    const isLink = sessionStorage.getItem(LINK_INTENT_KEY) === state;
    sessionStorage.removeItem(LINK_INTENT_KEY);

    // Set once the single-use code has actually been sent to the backend:
    // failures BEFORE that (e.g. the link-mode refresh) have not burned the
    // code, so the same callback URL may retry in place.
    let exchangeStarted = false;

    const run = async () => {
      if (isLink) {
        await authApi.refresh();
        exchangeStarted = true;
        await authApi.workosLinkCallback(code, state);
        navigate("/profile?sso=linked", { replace: true });
        return;
      }

      // SPA navigation, no full reload: the exchanged access token lives
      // in-memory only and a reload would discard it, forcing an extra
      // /auth/refresh round-trip (POC race #5). me() rehydrates the user
      // before entering the app.
      exchangeStarted = true;
      await authApi.workosCallback(code, state);
      await authApi.me().catch(() => undefined);
      navigate("/", { replace: true });
    };

    run().catch((exchangeError: unknown) => {
      if (!exchangeStarted) {
        consumedCodes.delete(code);
      }
      setError(describeError(exchangeError));
    });
  }, [searchParams, navigate]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
      }}
    >
      <Card style={{ width: 420, textAlign: "center" }}>
        {error ? (
          <>
            <Typography.Title level={4}>Ошибка входа через SSO</Typography.Title>
            <Typography.Text type="danger">{error}</Typography.Text>
            <div style={{ marginTop: 16 }}>
              <a href="/login">Вернуться на страницу входа</a>
            </div>
          </>
        ) : (
          <>
            <Spin size="large" />
            <div style={{ marginTop: 16 }}>
              <Typography.Text>Завершаем вход…</Typography.Text>
            </div>
          </>
        )}
      </Card>
    </div>
  );
};

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "IDENTITY_NOT_LINKED") {
      return "Вход через SSO не привязан. Войдите паролем и привяжите SSO в профиле, либо обратитесь к администратору.";
    }
    if (error.code === "LOGIN_METHOD_NOT_ALLOWED") {
      return "Этот способ входа недоступен для вашей учётной записи.";
    }
    if (error.code === "IDENTITY_CONFLICT") {
      return "Этот внешний аккаунт уже привязан к другому пользователю.";
    }
    if (error.code === "WORKOS_STATE_MISMATCH" || error.code === "WORKOS_CODE_INVALID") {
      return "Сессия входа устарела. Попробуйте ещё раз.";
    }
  }

  return error instanceof Error ? error.message : "Вход через SSO не удался";
}
