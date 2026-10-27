import React from "react";
import { Button, Form, Input } from "antd";
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  MoonOutlined,
  SafetyOutlined,
  SunOutlined,
} from "@ant-design/icons";
import { featureFlags } from "../../config/featureFlags";
import { Tooltip } from "../../ui/tooltipDelay";
import { useAppTheme } from "../../theme/ThemeProvider";
import { APP_VERSION } from "../../version";
import { useWorkosSso } from "./useWorkosSso";
import "../../ui-evolution/styles/evolution.css";
import "../../ui-evolution/styles/workbench.css";
import "../../ui-evolution/styles/workbench-login.css";

export interface LoginWorkbenchProps {
  onFinish: (values: { username: string; password: string }) => void;
  isLoading: boolean;
  loginError: string | null;
  ssoLogoutWarning: boolean;
  invitationLinked: boolean;
}

/**
 * Страница входа NewLine (мокап 21): бренд-панель со схемой раскроя слева,
 * форма справа. Логика входа целиком у LoginPage — здесь только вид.
 */
const LoginWorkbench: React.FC<LoginWorkbenchProps> = ({
  onFinish,
  isLoading,
  loginError,
  ssoLogoutWarning,
  invitationLinked,
}) => {
  const { mode, toggleMode } = useAppTheme();
  const isDark = mode === "dark";

  return (
    <div className="wb-login">
      <aside className="wb-login__brand" aria-label="О системе">
        <div className="wb-login__logo">
          <span className="wb-login__mark" aria-hidden="true">Ж</span>
          <b>Жиһаз ERP</b>
        </div>
        <div className="wb-login__slogan">
          <p>От заказа до выдачи — в одном месте</p>
          <small>
            Заказы, раскрой, МДФ-цех, склад плёнки и оплаты. Каждая деталь видна на своём этапе.
          </small>
        </div>
        <LoginSheetArt />
      </aside>

      <div className="wb-login__side">
        <Tooltip title={isDark ? "Светлая тема" : "Тёмная тема"} placement="left">
          <button
            type="button"
            className="wb-login__theme"
            aria-label={isDark ? "Светлая тема" : "Тёмная тема"}
            onClick={() => void toggleMode()}
          >
            {isDark ? <SunOutlined /> : <MoonOutlined />}
          </button>
        </Tooltip>
        <main className="wb-login__card">
          <div>
            <h1>Вход в систему</h1>
            <p className="wb-login__lead">Рабочее место Жиһаз ERP</p>
          </div>

          {ssoLogoutWarning && (
            <div className="wb-login__notice" data-tone="warn" role="status">
              <ExclamationCircleOutlined />
              <div>
                <b>Сессия SSO-провайдера может быть ещё активна.</b> Не удалось завершить
                сессию провайдера входа. На общем компьютере завершите её вручную (выход из
                аккаунта провайдера).
              </div>
            </div>
          )}
          {invitationLinked && (
            <div className="wb-login__notice" data-tone="ok" role="status">
              <CheckCircleOutlined />
              <div>
                <b>SSO-вход привязан.</b> Теперь можно войти через SSO выбранной внешней
                учётной записью.
              </div>
            </div>
          )}
          {loginError && (
            <div className="wb-login__notice" data-tone="bad" role="alert">
              <ExclamationCircleOutlined />
              <div><b>{loginError}</b></div>
            </div>
          )}

          {featureFlags.workosAuth && (
            <>
              <WorkosSsoBlock />
              <div className="wb-login__or" role="separator"><span>или</span></div>
            </>
          )}

          <Form
            name="login"
            className="wb-login__form"
            onFinish={onFinish}
            layout="vertical"
            requiredMark={false}
          >
            <Form.Item
              label="Логин"
              name="username"
              rules={[{ required: true, message: "Введите логин" }]}
            >
              <Input id="username" autoComplete="username" placeholder="Например, ivan.p" />
            </Form.Item>
            <Form.Item
              label="Пароль"
              name="password"
              rules={[{ required: true, message: "Введите пароль" }]}
              validateStatus={loginError ? "error" : undefined}
              help={loginError ? "Проверьте пароль и раскладку клавиатуры" : undefined}
            >
              <Input.Password id="password" autoComplete="current-password" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={isLoading} className="wb-login__submit">
              Войти
            </Button>
          </Form>

          <p className="wb-login__foot">
            Нет доступа? Попросите администратора создать учётную запись.
            <br />
            Жиһаз ERP · версия {APP_VERSION}
          </p>
        </main>
      </div>
    </div>
  );
};

const WorkosSsoBlock: React.FC = () => {
  const { redirecting, error, startSso } = useWorkosSso();
  return (
    <div className="wb-login__sso">
      <Button block icon={<SafetyOutlined />} loading={redirecting} onClick={startSso}>
        Войти через SSO
      </Button>
      {error && <div className="wb-login__sso-error">{error}</div>}
    </div>
  );
};

/** Схема раскроя листа: условные тона плёнок, без подписей. */
const ART_TONES = [
  "#F3F2EE", "#ECE4D6", "#E6D3B0", "#9DAA9B", "#B9B6B0", "#CDBFAB",
  "#8B8177", "#404246", "#2F4A7A", "#FAFAF6", "#8E8A84", "#D8CEC2",
];
const ART_PARTS: Array<[number, number, number, number, number]> = [
  [8, 8, 150, 170, 1], [162, 8, 120, 170, 0], [286, 8, 200, 170, 2], [490, 8, 62, 170, 3],
  [8, 182, 210, 120, 4], [222, 182, 130, 120, 5], [356, 182, 90, 120, 6], [450, 182, 102, 120, 7],
  [8, 306, 100, 106, 8], [112, 306, 170, 106, 9], [286, 306, 120, 50, 10], [286, 360, 120, 52, 11],
];
const ART_CUTS =
  "M8 180H552M8 304H552M160 8V178M284 8V178M488 8V178M220 182V302M354 182V302M448 182V302M110 306V412M284 306V412M408 306V412M286 358H406";

const LoginSheetArt: React.FC = () => (
  <div className="wb-login__art" aria-hidden="true">
    <svg viewBox="0 0 560 420" preserveAspectRatio="xMidYMax meet" focusable="false">
      <defs>
        <pattern id="wb-login-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="8" height="8" className="wb-login__hatch-bg" />
          <line x1="0" y1="0" x2="0" y2="8" className="wb-login__hatch-line" strokeWidth="3" />
        </pattern>
      </defs>
      <rect className="wb-login__sheet" x="1" y="1" width="558" height="418" rx="6" />
      {ART_PARTS.map(([x, y, w, h, tone]) => (
        <rect key={`${x}-${y}`} className="wb-login__part" x={x} y={y} width={w} height={h} rx="2" fill={ART_TONES[tone]} />
      ))}
      <rect className="wb-login__offcut" x="410" y="306" width="142" height="106" rx="2" fill="url(#wb-login-hatch)" />
      <path className="wb-login__cut" d={ART_CUTS} />
    </svg>
  </div>
);

export default LoginWorkbench;
