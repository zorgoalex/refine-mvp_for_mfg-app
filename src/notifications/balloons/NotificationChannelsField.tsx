import React from 'react';
import { Checkbox, Radio, Space, Typography } from 'antd';
import type { BalloonMode, NotificationChannel } from '../../api/types/notificationRulesApi.types';
import { BALLOON_MODE_LABELS, normalizeChannels } from './notificationChannels';

export interface NotificationChannelsFieldProps {
  channels: NotificationChannel[];
  balloonMode: BalloonMode;
  onChange: (next: { channels: NotificationChannel[]; balloonMode: BalloonMode }) => void;
  /** Telegram недоступен (например, у событий закупа). */
  telegramDisabled?: boolean;
  /** Пояснение под балуном (например, условие для дедлайнов). */
  balloonHint?: string;
}

/**
 * Единый выбор каналов уведомления и свойства исчезновения балуна (план 2026-10-03 §2.2) — используется всеми
 * настройками уведомлений.
 */
export const NotificationChannelsField: React.FC<NotificationChannelsFieldProps> = ({
  channels, balloonMode, onChange, telegramDisabled, balloonHint,
}) => {
  const hasBalloon = channels.includes('balloon');
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Checkbox.Group
        value={channels}
        onChange={(values) => onChange({ channels: normalizeChannels(values as NotificationChannel[], channels), balloonMode })}
        style={{ width: '100%' }}
      >
        <Space direction="vertical" size={8}>
          <Checkbox value="in_app">В приложении</Checkbox>
          <Checkbox value="balloon">Всплывающее окно (балун)</Checkbox>
          <Checkbox value="telegram" disabled={telegramDisabled}>Telegram</Checkbox>
        </Space>
      </Checkbox.Group>
      {hasBalloon && (
        <div style={{ paddingLeft: 24 }}>
          <Typography.Text type="secondary">Исчезновение балуна</Typography.Text>
          <Radio.Group
            value={balloonMode}
            onChange={(event) => onChange({ channels, balloonMode: event.target.value as BalloonMode })}
            style={{ display: 'block', marginTop: 4 }}
          >
            <Space direction="vertical" size={4}>
              <Radio value="auto">{BALLOON_MODE_LABELS.auto}</Radio>
              <Radio value="persistent">{BALLOON_MODE_LABELS.persistent}</Radio>
            </Space>
          </Radio.Group>
          {balloonHint && <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0 0' }}>{balloonHint}</Typography.Paragraph>}
        </div>
      )}
    </Space>
  );
};
