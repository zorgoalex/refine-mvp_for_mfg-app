import React from "react";
import { SwapOutlined } from "@ant-design/icons";
import { Button, Card, Spin, Typography } from "antd";
import { useNavigate, useSearchParams } from "react-router-dom";
import { authApi } from "../../api/authApi";
import { ApiError } from "../../api/httpClient";

// Module-level guard: the AuthKit code is single-use, and React StrictMode in
// dev double-mounts this page, so a ref inside the component is not enough.
// 'pending' — an exchange is in flight (StrictMode re-run stays silent);
// 'settled' — the code is burned (SPA back/revisit shows an explicit error
// instead of a dead spinner).
const consumedCodes = new Map<string, "pending" | "settled">();

const LINK_INTENT_KEY = "erp_workos_link_intent";
const INVITATION_INTENT_KEY = "erp_workos_invitation_intent";

type WorkosCallbackError = {
  message: string;
  canSelectAnotherAccount: boolean;
};

// Backend errors raised BEFORE the state/code were consumed (throttle, origin
// check, feature off, validation, expired bearer on the link path): the code
// and the state cookie are still valid, so the same callback URL may retry.
const PRE_EXCHANGE_ERROR_CODES = new Set([
  "RATE_LIMIT_EXCEEDED",
  "RATE_LIMIT_UNAVAILABLE",
  "ORIGIN_NOT_ALLOWED",
  "SERVICE_UNAVAILABLE",
  "VALIDATION_ERROR",
  "AUTH_REQUIRED",
]);

/**
 * Binds the link intent to the EXACT state of the started flow: a stale flag
 * from an aborted link attempt must not misroute the next normal SSO login
 * into the link callback (state values never match across flows).
 */
export function markWorkosLinkIntent(state: string): void {
  sessionStorage.setItem(LINK_INTENT_KEY, state);
}

export function markWorkosInvitationIntent(state: string): void {
  sessionStorage.setItem(INVITATION_INTENT_KEY, state);
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
  const [error, setError] = React.useState<WorkosCallbackError | null>(null);
  const [selectingAccount, setSelectingAccount] = React.useState(false);
  const [accountSelectionError, setAccountSelectionError] = React.useState<string | null>(null);

  const selectAnotherAccount = async () => {
    setSelectingAccount(true);
    setAccountSelectionError(null);
    try {
      const url = await authApi.workosAuthorizeUrl({ selectAccount: true });
      window.location.assign(url);
    } catch {
      setAccountSelectionError("Не удалось открыть выбор SSO-аккаунта. Попробуйте ещё раз.");
      setSelectingAccount(false);
    }
  };

  React.useEffect(() => {
    const code = searchParams.get("code");
    const state = searchParams.get("state");

    if (!code || !state) {
      setError({
        message: "Не получены параметры от провайдера входа",
        canSelectAnotherAccount: false,
      });
      return;
    }
    const consumed = consumedCodes.get(code);
    if (consumed === "pending") {
      // StrictMode double-run while the first exchange is in flight.
      return;
    }
    if (consumed === "settled") {
      setError({
        message: "Ссылка входа уже использована. Войдите заново.",
        canSelectAnotherAccount: false,
      });
      return;
    }
    consumedCodes.set(code, "pending");

    // Link mode only when the stored intent matches THIS flow's state; a
    // stale flag from an aborted link attempt is discarded, not trusted.
    const isLink = sessionStorage.getItem(LINK_INTENT_KEY) === state;
    const isInvitation = sessionStorage.getItem(INVITATION_INTENT_KEY) === state;
    if (!isLink) {
      // Mismatched (dead) intent from some earlier aborted flow.
      sessionStorage.removeItem(LINK_INTENT_KEY);
    }
    if (!isInvitation) {
      sessionStorage.removeItem(INVITATION_INTENT_KEY);
    }

    // The code is promoted to 'settled' (and the link intent cleared) ONLY
    // once a backend response was observed — an ApiError means the backend
    // consumed the code; a transport-level failure (offline, abort, DNS)
    // means the code and the state cookie are still valid, so the same
    // callback URL must stay retryable and a link retry must stay a link.
    let exchangeStarted = false;

    const settleAfterBackendResponse = (error?: unknown) => {
      const consumed =
        error === undefined ||
        (error instanceof ApiError && !PRE_EXCHANGE_ERROR_CODES.has(error.code));

      if (consumed) {
        consumedCodes.set(code, "settled");
        if (isLink) {
          sessionStorage.removeItem(LINK_INTENT_KEY);
        }
        if (isInvitation) {
          sessionStorage.removeItem(INVITATION_INTENT_KEY);
        }
        return;
      }
      // Transport fault or a pre-exchange backend denial: nothing consumed
      // the state/code — release the entry so the URL stays retryable.
      consumedCodes.delete(code);
    };

    const exchange = async (call: () => Promise<unknown>) => {
      exchangeStarted = true;
      try {
        await call();
      } catch (error) {
        settleAfterBackendResponse(error);
        throw error;
      }
      settleAfterBackendResponse();
    };

    const run = async () => {
      if (isInvitation) {
        await exchange(() => authApi.workosInvitationCallback(code, state));
        navigate("/login?sso=invitation-linked", { replace: true });
        return;
      }

      if (isLink) {
        await authApi.refresh();
        await exchange(() => authApi.workosLinkCallback(code, state));
        navigate("/profile?sso=linked", { replace: true });
        return;
      }

      // Never reload the consumed callback URL. A new document at `/` restores
      // the cookie-backed session and resolves the per-user UI shell before
      // the first authenticated paint.
      await exchange(() => authApi.workosCallback(code, state));
      window.location.replace("/");
    };

    run().catch((exchangeError: unknown) => {
      if (!exchangeStarted) {
        // Pre-exchange failure (link-mode refresh): the code was never sent.
        consumedCodes.delete(code);
      }
      // A failed external retry may restore this page from browser history
      // with the previous button state. Never leave the account-switch action
      // spinning after the backend has already returned a definitive error.
      setSelectingAccount(false);
      setError({
        message: describeError(exchangeError),
        canSelectAnotherAccount:
          !isLink &&
          !isInvitation &&
          exchangeError instanceof ApiError &&
          exchangeError.code === "IDENTITY_NOT_LINKED",
      });
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
            <Typography.Text type="danger">{error.message}</Typography.Text>
            <div style={{ display: "grid", gap: 8, marginTop: 20 }}>
              {error.canSelectAnotherAccount && (
                <Button
                  type="primary"
                  block
                  icon={<SwapOutlined />}
                  loading={selectingAccount}
                  onClick={selectAnotherAccount}
                  style={{ height: 40 }}
                >
                  Войти другим SSO-аккаунтом
                </Button>
              )}
              {accountSelectionError && (
                <Typography.Text type="danger">{accountSelectionError}</Typography.Text>
              )}
              <Button type="link" href="/login" style={{ minHeight: 40 }}>
                Вернуться на страницу входа
              </Button>
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
