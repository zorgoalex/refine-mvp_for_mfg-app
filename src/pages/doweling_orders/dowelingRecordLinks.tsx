// The order and the client of a Bazis project card open their cards; the card's back arrow returns here (to the list
// or the Bazis project card the link was clicked in). Without the read right the value stays plain text.
import React from 'react';
import { featureFlags } from '../../config/featureFlags';
import { useOpenWithOrigin } from '../../utils/backToOrigin';
import { can } from '../../utils/permissions';

const canRead = (permission: string) => !featureFlags.useBackendPermissions || can(permission);

interface RecordLinkProps {
  to: string | null;
  label: React.ReactNode;
  title: string;
  fromLabel: string;
  style?: React.CSSProperties;
}

function RecordLink({ to, label, title, fromLabel, style }: RecordLinkProps) {
  const openWithOrigin = useOpenWithOrigin(fromLabel);
  if (!to) return <span style={style}>{label}</span>;
  return (
    <a
      href={to}
      title={title}
      style={style}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openWithOrigin(to);
      }}
      // the list row opens the Bazis project card on a double click — a click on the link is not that
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {label}
    </a>
  );
}

export function DowelingOrderLink({ orderId, orderName, fromLabel, style }: {
  orderId?: number | string | null;
  orderName?: string | null;
  fromLabel: string;
  style?: React.CSSProperties;
}) {
  const to = orderId && orderName && canRead('orders.view') ? `/orders/show/${orderId}` : null;
  return <RecordLink to={to} label={orderName || '—'} title="Открыть заказ" fromLabel={fromLabel} style={style} />;
}

export function DowelingClientLink({ clientId, clientName, fromLabel, style }: {
  clientId?: number | string | null;
  clientName?: string | null;
  fromLabel: string;
  style?: React.CSSProperties;
}) {
  const to = clientId && clientName && canRead('clients.view') ? `/clients/show/${clientId}` : null;
  return <RecordLink to={to} label={clientName || '—'} title="Открыть карточку клиента" fromLabel={fromLabel} style={style} />;
}
