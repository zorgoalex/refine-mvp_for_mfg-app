import React, { useState } from 'react';
import { Button, Popconfirm, Typography, message } from 'antd';
import { WhatsAppOutlined } from '@ant-design/icons';
import { ApiError } from '../../api/apiError';
import type { MyWhatsAppSend } from '../../api/myWhatsAppSendsApi';
import { orderSendApi } from '../../api/orderSendApi';
import { estimateText } from './myWhatsAppSendsModel';

const { Text } = Typography;

/**
 * «WhatsApp: ожидают отправки» under the bell: the user's own pending sends with the estimated time;
 * a waiting order card send can be cancelled by its author (the server decides — `cancellable`).
 */
export const MyWhatsAppSendsBlock: React.FC<{ items: readonly MyWhatsAppSend[]; onChanged?: () => void }> = ({ items, onChanged }) => {
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(() => new Set());
  const pending = items.filter((item) => item.active);
  if (!pending.length) return null;
  const cancel = async (item: MyWhatsAppSend) => {
    setCancelling((ids) => new Set(ids).add(item.id));
    try {
      const result = await orderSendApi.cancel(item.id);
      if (result.send.state === 'cancelled') message.success('Отправка отменена');
      else message.info('Отправка уже завершилась');
    } catch (error) {
      message.error(error instanceof ApiError && error.code === 'ORDER_SEND_NOT_CANCELLABLE'
        ? 'Отправка уже уходит в WhatsApp — отменить нельзя' : 'Не удалось отменить отправку');
    } finally {
      setCancelling((ids) => { const next = new Set(ids); next.delete(item.id); return next; });
      onChanged?.();
    }
  };
  return (
    <div data-testid="my-whatsapp-sends" style={{ width: 315, padding: '10px 16px', borderBottom: '1px solid var(--app-border-soft)',
      backgroundColor: 'var(--app-surface)' }}>
      <Text strong><WhatsAppOutlined style={{ color: '#25D366', marginRight: 6 }} />WhatsApp: ожидают отправки</Text>
      {pending.map((item) => (
        <div key={item.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 6 }}>
          <Text style={{ minWidth: 0, flex: 1 }} ellipsis={{ tooltip: item.title }}>{item.title}</Text>
          <Text type="secondary" style={{ whiteSpace: 'nowrap' }}>{estimateText(item.estimatedAt) || 'время уточняется'}</Text>
          {item.cancellable && item.kind === 'order_send' && (
            // Inside the dropdown: a confirmation rendered in <body> would count as a click outside and close it.
            <Popconfirm title="Отменить эту отправку?" okText="Отменить отправку" cancelText="Нет" onConfirm={() => void cancel(item)}
              getPopupContainer={(trigger) => trigger.parentElement ?? document.body}>
              <Button size="small" type="link" danger style={{ padding: 0 }} loading={cancelling.has(item.id)}>Отменить</Button>
            </Popconfirm>
          )}
        </div>
      ))}
    </div>
  );
};
