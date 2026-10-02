import React from 'react';
import { Typography } from 'antd';
import { WhatsAppOutlined } from '@ant-design/icons';
import type { MyWhatsAppSend } from '../../api/myWhatsAppSendsApi';
import { estimateText } from './myWhatsAppSendsModel';

const { Text } = Typography;

/** «WhatsApp: ожидают отправки» under the bell: the user's own pending sends with the estimated time. */
export const MyWhatsAppSendsBlock: React.FC<{ items: readonly MyWhatsAppSend[] }> = ({ items }) => {
  const pending = items.filter((item) => item.active);
  if (!pending.length) return null;
  return (
    <div data-testid="my-whatsapp-sends" style={{ width: 315, padding: '10px 16px', borderBottom: '1px solid var(--app-border-soft)',
      backgroundColor: 'var(--app-surface)' }}>
      <Text strong><WhatsAppOutlined style={{ color: '#25D366', marginRight: 6 }} />WhatsApp: ожидают отправки</Text>
      {pending.map((item) => (
        <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 6 }}>
          <Text style={{ minWidth: 0 }} ellipsis={{ tooltip: item.title }}>{item.title}</Text>
          <Text type="secondary" style={{ whiteSpace: 'nowrap' }}>{estimateText(item.estimatedAt) || 'время уточняется'}</Text>
        </div>
      ))}
    </div>
  );
};
