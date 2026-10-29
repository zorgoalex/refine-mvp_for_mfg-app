import React from 'react';
import { Alert } from 'antd';
import { Link } from 'react-router-dom';
import type { ClientMergeHistory } from '../../api/clientMergesApiTypes';
import { formatDateTime } from '../integrations/duplicatesModel';
import { mergedBanner } from './clientMergesModel';

export function MergedClientBanner({ history, clientId }: { history: ClientMergeHistory | null; clientId: number | null }) {
  const banner = clientId ? mergedBanner(history, clientId) : null;
  if (!banner) return null;
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 16 }}
      message={(
        <span>
          Клиент объединён с «<Link to={`/clients/show/${banner.intoClientId}`}>{banner.intoName}</Link>»
          {banner.mergedAt ? ` · ${formatDateTime(banner.mergedAt)}` : ''}
          {banner.mergedBy ? ` · ${banner.mergedBy}` : ''}
        </span>
      )}
    />
  );
}
