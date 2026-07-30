import React from 'react';
import { Typography } from 'antd';
import type { ReactNode } from 'react';
import { useOptionalUiVariant } from '../ui-variant/UiVariantProvider';

export function useOperationalUi(): boolean {
  const variantContext = useOptionalUiVariant();
  return variantContext?.variant === 'line' || variantContext?.variant === 'air';
}

interface OperationalPageHeaderProps {
  breadcrumbs?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
}

export const OperationalPageHeader: React.FC<OperationalPageHeaderProps> = ({
  breadcrumbs,
  title,
  description,
  actions,
  compact = false,
}) => (
  <header className={`operational-page-head${compact ? ' operational-page-head--compact' : ''}`}>
    <div className="operational-page-head__title">
      {breadcrumbs ? <div className="operational-breadcrumbs">{breadcrumbs}</div> : null}
      <Typography.Title level={1}>{title}</Typography.Title>
      {description ? <Typography.Paragraph>{description}</Typography.Paragraph> : null}
    </div>
    {actions ? <div className="operational-page-head__actions">{actions}</div> : null}
  </header>
);

interface OperationalKpiProps {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
}

export const OperationalKpi: React.FC<OperationalKpiProps> = ({
  label,
  value,
  hint,
  tone = 'neutral',
}) => (
  <div className={`operational-kpi operational-kpi--${tone}`}>
    <span className="operational-kpi__label">{label}</span>
    <strong className="operational-kpi__value">{value}</strong>
    {hint ? <span className="operational-kpi__hint">{hint}</span> : null}
  </div>
);

export const OperationalKpiGrid: React.FC<React.PropsWithChildren<{ columns?: number }>> = ({
  children,
  columns = 5,
}) => (
  <div
    className="operational-kpi-grid"
    style={{ '--operational-kpi-columns': columns } as React.CSSProperties}
  >
    {children}
  </div>
);

export const OperationalPanel: React.FC<
  React.PropsWithChildren<{
    title?: ReactNode;
    description?: ReactNode;
    actions?: ReactNode;
    className?: string;
  }>
> = ({ title, description, actions, className, children }) => (
  <section className={['operational-panel', className].filter(Boolean).join(' ')}>
    {title || description || actions ? (
      <header className="operational-panel__head">
        <div className="operational-panel__title">
          {title ? <Typography.Title level={2}>{title}</Typography.Title> : null}
          {description ? <Typography.Paragraph>{description}</Typography.Paragraph> : null}
        </div>
        {actions ? <div className="operational-panel__actions">{actions}</div> : null}
      </header>
    ) : null}
    <div className="operational-panel__body">{children}</div>
  </section>
);
