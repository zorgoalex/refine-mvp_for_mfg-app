/**
 * «NewLine»: личный кабинет — слева оглавление разделов, справа панели «Профиль», «Вход и безопасность»,
 * «Уведомления», «Интерфейс». Те же данные и настройки, что в обычном виде; меняется только раскладка.
 */
import React from "react";
import { Switch } from "antd";
import {
  BellOutlined,
  CheckOutlined,
  ControlOutlined,
  LockOutlined,
  MoonOutlined,
  SunOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { useGetIdentity } from "@refinedev/core";
import type { UserIdentity } from "../../types/auth";
import { useAppTheme } from "../../theme/ThemeProvider";
import type { ThemeMode, UiSize } from "../../theme/themeTypes";
import { featureFlags } from "../../config/featureFlags";
import { useUiVariantPreference } from "../../ui-variant/useUiVariantPreference";
import { isModernUiVariant, type UiVariant } from "../../ui-variant/uiVariant";
import { Segmented } from "../../ui/Segmented";
import { WorkosLinkCard } from "./WorkosLinkCard";
import { TelegramNotificationsCard } from "./TelegramNotificationsCard";
import { profileInitials, profileRoleName, uiVariantCards } from "./profileOptions";
import { useTabletModeToggle } from "./useTabletModeToggle";

type SectionKey = "me" | "security" | "notifications" | "ui";

const densityCards: Array<{ value: UiSize; title: string; caption: string; rows: number }> = [
  { value: "default", title: "Стандартная", caption: "Обычные строки и кнопки", rows: 4 },
  { value: "small", title: "Компактная", caption: "Уменьшенные элементы — больше строк на экране", rows: 6 },
];

export const ProfileWorkbench: React.FC = () => {
  const { data: identity } = useGetIdentity<UserIdentity>();
  const { mode, setMode, uiSize, setUiSize } = useAppTheme();
  const { tabletMode, isTabletModeSaving, toggleTabletMode } = useTabletModeToggle();
  const { variant, modernUiAvailable, isSaving: isVariantSaving, setVariant } = useUiVariantPreference();
  const roleName = profileRoleName(identity?.role);

  const sections = React.useMemo(
    () =>
      [
        { key: "me" as const, label: "Профиль", icon: <UserOutlined /> },
        ...(featureFlags.workosAuth
          ? [{ key: "security" as const, label: "Вход и безопасность", icon: <LockOutlined /> }]
          : []),
        { key: "notifications" as const, label: "Уведомления", icon: <BellOutlined /> },
        { key: "ui" as const, label: "Интерфейс", icon: <ControlOutlined /> },
      ],
    [],
  );
  const [current, setCurrent] = React.useState<SectionKey>("me");
  const sectionRefs = React.useRef<Partial<Record<SectionKey, HTMLElement | null>>>({});

  // Подсветка текущего раздела в оглавлении по прокрутке.
  React.useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const key = visible[0]?.target.getAttribute("data-section") as SectionKey | null;
        if (key) setCurrent(key);
      },
      { rootMargin: "-90px 0px -55% 0px" },
    );
    Object.values(sectionRefs.current).forEach((element) => element && observer.observe(element));
    return () => observer.disconnect();
  }, [sections]);

  const jumpTo = (key: SectionKey) => {
    setCurrent(key);
    sectionRefs.current[key]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const section = (key: SectionKey, title: string, sub: string, body: React.ReactNode) => (
    <section
      className="wb-profile__panel"
      data-section={key}
      aria-labelledby={`wb-profile-${key}`}
      ref={(element) => {
        sectionRefs.current[key] = element;
      }}
    >
      <header className="wb-profile__panel-head">
        <h2 id={`wb-profile-${key}`}>{title}</h2>
        <span>{sub}</span>
      </header>
      <div className="wb-profile__panel-body">{body}</div>
    </section>
  );

  return (
    <div className="wb-profile">
      <header className="wb-profile__head">
        <h1>Профиль и настройки</h1>
        <p>
          <span>{identity?.username ?? "—"}</span>
          <span className="wb-profile__dot">{roleName}</span>
        </p>
      </header>

      <div className="wb-profile__layout">
        <nav className="wb-profile__toc" aria-label="Разделы профиля">
          {sections.map((item) => (
            <a
              key={item.key}
              href={`#wb-profile-${item.key}`}
              aria-current={current === item.key ? "true" : undefined}
              onClick={(event) => {
                event.preventDefault();
                jumpTo(item.key);
              }}
            >
              {item.icon}
              {item.label}
            </a>
          ))}
        </nav>

        <div className="wb-profile__sections">
          {section(
            "me",
            "Профиль",
            "Так вас видят коллеги в заказах и журналах",
            <div className="wb-profile__who">
              <span className="wb-avatar wb-profile__avatar" aria-hidden="true">
                {profileInitials(identity?.username)}
              </span>
              <div className="wb-profile__who-text">
                <h3>{identity?.username ?? "—"}</h3>
                <div className="wb-profile__who-meta">
                  <span className="wb-pill" data-tone="active">
                    {roleName}
                  </span>
                  <span className="wb-list__muted">Роль и права назначает администратор</span>
                </div>
              </div>
            </div>,
          )}

          {featureFlags.workosAuth &&
            section(
              "security",
              "Вход и безопасность",
              "Привязанные входы через SSO и Google",
              <div className="wb-profile__embed">
                <WorkosLinkCard />
              </div>,
            )}

          {section(
            "notifications",
            "Уведомления",
            "Личный Telegram для уведомлений по правилам",
            <div className="wb-profile__embed">
              <TelegramNotificationsCard />
            </div>,
          )}

          {section(
            "ui",
            "Интерфейс",
            "Сохраняется в вашем профиле и действует на всех устройствах",
            <>
              <div className="wb-profile__block">
                <h3 className="wb-profile__sub" id="wb-profile-variant">
                  Вариант оформления
                </h3>
                <div className="wb-profile__opts wb-profile__opts--variant" role="radiogroup" aria-labelledby="wb-profile-variant">
                  {uiVariantCards.map((card) => {
                    const disabled = isVariantSaving || (isModernUiVariant(card.value) && !modernUiAvailable);
                    return (
                      <label key={card.value} className="wb-profile__opt" data-disabled={disabled || undefined}>
                        <input
                          type="radio"
                          name="wb-profile-variant"
                          value={card.value}
                          checked={variant === card.value}
                          disabled={disabled}
                          onChange={() => void setVariant(card.value as UiVariant)}
                        />
                        <span className="wb-profile__opt-box">
                          <VariantThumb variant={card.value} />
                          <span className="wb-profile__opt-title">
                            {card.title}
                            {card.fresh ? <span className="wb-profile__badge">Новый</span> : null}
                            <span className="wb-profile__check" aria-hidden="true">
                              <CheckOutlined />
                            </span>
                          </span>
                          <span className="wb-profile__opt-caption">{card.caption}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                <p className="wb-profile__hint">
                  {modernUiAvailable
                    ? "После выбора страница перезагрузится в новом оформлении. На планшете всегда используется планшетный вид."
                    : "Новые варианты оформления временно отключены администратором."}
                </p>
              </div>

              <div className="wb-profile__block">
                <h3 className="wb-profile__sub" id="wb-profile-theme">
                  Тема
                </h3>
                <Segmented
                  aria-labelledby="wb-profile-theme"
                  value={mode}
                  options={[
                    { value: "light", label: <span className="wb-profile__seg"><SunOutlined />Светлая</span> },
                    { value: "dark", label: <span className="wb-profile__seg"><MoonOutlined />Тёмная</span> },
                  ]}
                  onChange={(value) => void setMode(value as ThemeMode)}
                />
              </div>

              <div className="wb-profile__block">
                <h3 className="wb-profile__sub" id="wb-profile-density">
                  Плотность
                </h3>
                <div className="wb-profile__opts wb-profile__opts--density" role="radiogroup" aria-labelledby="wb-profile-density">
                  {densityCards.map((card) => (
                    <label key={card.value} className="wb-profile__opt">
                      <input
                        type="radio"
                        name="wb-profile-density"
                        value={card.value}
                        checked={uiSize === card.value}
                        onChange={() => void setUiSize(card.value)}
                      />
                      <span className="wb-profile__opt-box">
                        <span className="wb-profile__dprev" data-rows={card.rows} aria-hidden="true">
                          {Array.from({ length: card.rows }, (_, index) => (
                            <i key={index} />
                          ))}
                        </span>
                        <span className="wb-profile__opt-title">
                          {card.title}
                          <span className="wb-profile__check" aria-hidden="true">
                            <CheckOutlined />
                          </span>
                        </span>
                        <span className="wb-profile__opt-caption">{card.caption}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="wb-profile__block">
                <div className="wb-profile__switch-row">
                  <div>
                    <label className="wb-profile__sub" htmlFor="wb-profile-tablet">
                      Планшетный вид
                    </label>
                    <p className="wb-profile__hint">
                      {tabletMode
                        ? "Принудительно включён для вашей учётной записи на любых устройствах и экранах."
                        : "Автоматически определяется по устройству. Включите, чтобы всегда использовать планшетный интерфейс."}
                    </p>
                  </div>
                  <Switch
                    id="wb-profile-tablet"
                    checked={tabletMode}
                    loading={isTabletModeSaving}
                    onChange={() => void toggleTabletMode()}
                  />
                </div>
              </div>
            </>,
          )}
        </div>
      </div>
    </div>
  );
};

/** Схематичная миниатюра варианта: боковая панель, шапка и строки. */
const VariantThumb: React.FC<{ variant: UiVariant }> = ({ variant }) => (
  <span className="wb-profile__thumb" data-variant={variant} aria-hidden="true">
    <span className="wb-profile__thumb-side">
      <i />
      <i className="on" />
      <i />
      <i />
      <i />
    </span>
    <span className="wb-profile__thumb-main">
      <span className="wb-profile__thumb-head">
        <i className="on" />
        <i />
        <i />
      </span>
      <span className="wb-profile__thumb-panel">
        <i className="hl" />
        <i />
        <i />
        <i />
        <i />
      </span>
    </span>
  </span>
);
