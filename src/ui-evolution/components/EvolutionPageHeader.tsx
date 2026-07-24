import React from 'react';
import { Typography } from 'antd';

export const EvolutionPageHeader: React.FC<
  React.PropsWithChildren<{ title: string; subtitle?: string; actions?: React.ReactNode }>
> = ({ title, subtitle, actions, children }) => (
  <header className="evolution-page-header">
    <div className="evolution-page-header__copy">
      <Typography.Title level={1}>{title}</Typography.Title>
      {subtitle ? <Typography.Paragraph>{subtitle}</Typography.Paragraph> : null}
    </div>
    {actions ? <div className="evolution-page-header__actions">{actions}</div> : null}
    {children}
  </header>
);

export const EvolutionFormSection: React.FC<
  React.PropsWithChildren<{ title: string; description?: string }>
> = ({ title, description, children }) => (
  <section className="evolution-form-section">
    <div className="evolution-form-section__heading">
      <Typography.Title level={3}>{title}</Typography.Title>
      {description ? <Typography.Paragraph>{description}</Typography.Paragraph> : null}
    </div>
    <div className="evolution-form-section__body">{children}</div>
  </section>
);
