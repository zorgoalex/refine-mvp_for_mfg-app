import React from 'react';

export type EvolutionStatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface EvolutionStatusBadgeProps {
  label: string;
  tone?: EvolutionStatusTone;
  className?: string;
}

export const EvolutionStatusBadge: React.FC<EvolutionStatusBadgeProps> = ({
  label,
  tone = 'neutral',
  className,
}) => (
  <span className={['evolution-status-badge', `evolution-status-badge--${tone}`, className].filter(Boolean).join(' ')}>
    <span aria-hidden="true" className="evolution-status-badge__dot" />
    <span>{label}</span>
  </span>
);
