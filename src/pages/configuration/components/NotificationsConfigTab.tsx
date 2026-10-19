import React, { useState } from 'react';
import { Tabs } from 'antd';
import { NotificationRulesConfig } from './NotificationRulesConfig';
import { OnecAlertNotificationsConfig } from './OnecAlertNotificationsConfig';
import { WhatsAppNotificationChannelConfig } from './WhatsAppNotificationChannelConfig';

export const NOTIFICATIONS_SUBSECTION_STORAGE_KEY = 'configuration:notifications:sub';

export interface NotificationsSubsectionsVisibility {
  rules: boolean;
  onecAlerts: boolean;
  whatsappChannel: boolean;
}

export interface NotificationsSubsection {
  key: 'rules' | 'onec-alerts' | 'whatsapp-channel';
  label: string;
}

/** Пункты подменю «Уведомления», которые видит пользователь; раздел показывается, если есть хотя бы один. */
export function notificationsSubsections(visible: NotificationsSubsectionsVisibility): NotificationsSubsection[] {
  return [
    ...(visible.rules ? [{ key: 'rules' as const, label: 'Правила' }] : []),
    ...(visible.onecAlerts ? [{ key: 'onec-alerts' as const, label: 'Оповещения 1С' }] : []),
    ...(visible.whatsappChannel ? [{ key: 'whatsapp-channel' as const, label: 'Канал WhatsApp' }] : []),
  ];
}

const readStored = (): string | null => {
  try {
    return window.sessionStorage.getItem(NOTIFICATIONS_SUBSECTION_STORAGE_KEY);
  } catch {
    return null;
  }
};

/** «Конфигурация» → «Уведомления»: подменю по видам уведомлений и каналам. */
export const NotificationsConfigTab: React.FC<{ visible: NotificationsSubsectionsVisibility; active: boolean }> = ({ visible, active }) => {
  const panels: Record<NotificationsSubsection['key'], React.ReactNode> = {
    rules: <NotificationRulesConfig />,
    'onec-alerts': <OnecAlertNotificationsConfig />,
    // The outer configuration tabs keep inactive sections mounted: the journal polls only while «Уведомления» is open.
    'whatsapp-channel': <WhatsAppNotificationChannelConfig active={active} />,
  };
  const items = notificationsSubsections(visible);
  const [stored, setStored] = useState(readStored);
  const activeKey = items.some((item) => item.key === stored) ? (stored as string) : items[0]?.key;
  const change = (key: string) => {
    setStored(key);
    try {
      window.sessionStorage.setItem(NOTIFICATIONS_SUBSECTION_STORAGE_KEY, key);
    } catch {
      // выбор просто не запомнится
    }
  };
  return (
    <Tabs
      className="configuration-notifications-tabs"
      activeKey={activeKey}
      onChange={change}
      destroyInactiveTabPane
      items={items.map((item) => ({ key: item.key, label: item.label, children: panels[item.key] }))}
    />
  );
};
