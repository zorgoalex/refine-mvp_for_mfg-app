import React from 'react';
import { Alert, Button, Empty, Spin, Typography } from 'antd';

export type EvolutionStateKind = 'loading' | 'empty' | 'error' | 'forbidden';

export interface EvolutionStatePanelProps {
  kind: EvolutionStateKind;
  title?: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}

const defaults: Record<EvolutionStateKind, { title: string; description: string }> = {
  loading: { title: 'Загрузка', description: 'Получаем актуальные данные…' },
  empty: { title: 'Пока нет данных', description: 'Здесь появятся записи после первого добавления.' },
  error: { title: 'Не удалось загрузить данные', description: 'Повторите попытку или обратитесь к администратору.' },
  forbidden: { title: 'Недостаточно прав', description: 'Этот раздел недоступен для вашей роли.' },
};

export const EvolutionStatePanel: React.FC<EvolutionStatePanelProps> = ({
  kind,
  title = defaults[kind].title,
  description = defaults[kind].description,
  actionLabel,
  onAction,
}) => {
  if (kind === 'loading') {
    return (
      <div aria-live="polite" className="evolution-state-panel" role="status">
        <Spin size="large" />
        <Typography.Text strong>{title}</Typography.Text>
        <Typography.Text type="secondary">{description}</Typography.Text>
      </div>
    );
  }

  if (kind === 'error') {
    return (
      <Alert
        action={actionLabel && onAction ? <Button onClick={onAction}>{actionLabel}</Button> : undefined}
        className="evolution-state-panel evolution-state-panel--alert"
        description={description}
        message={title}
        showIcon
        type="error"
      />
    );
  }

  return (
    <div className="evolution-state-panel" role={kind === 'forbidden' ? 'alert' : 'status'}>
      <Empty description={<><strong>{title}</strong><span>{description}</span></>} image={Empty.PRESENTED_IMAGE_SIMPLE}>
        {actionLabel && onAction ? <Button onClick={onAction}>{actionLabel}</Button> : null}
      </Empty>
    </div>
  );
};
