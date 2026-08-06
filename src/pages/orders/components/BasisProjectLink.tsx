import React, { type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

export function basisProjectPath(value: unknown): string | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? `/bazis/projects/${id}` : null;
}

interface BasisProjectLinkProps {
  value: unknown;
  bazisProjectId: unknown;
  enabled: boolean;
  fallback?: ReactNode;
  style?: CSSProperties;
}

export function BasisProjectLink({
  value,
  bazisProjectId,
  enabled,
  fallback = '',
  style,
}: BasisProjectLinkProps) {
  const label = typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';
  if (!label) return <>{fallback}</>;

  const content = (
    <span style={{ fontVariantNumeric: 'tabular-nums', ...style }}>
      {label}
    </span>
  );
  const path = enabled ? basisProjectPath(bazisProjectId) : null;
  if (!path) return content;

  const stopRowNavigation = (event: MouseEvent<HTMLAnchorElement>) => event.stopPropagation();
  return (
    <Link
      to={path}
      aria-label={`Открыть Базис-проект ${label}`}
      title={`Открыть Базис-проект ${label}`}
      onMouseDown={stopRowNavigation}
      onClick={stopRowNavigation}
      onDoubleClick={stopRowNavigation}
      style={{ textDecoration: 'underline', textUnderlineOffset: 2 }}
    >
      {content}
    </Link>
  );
}
