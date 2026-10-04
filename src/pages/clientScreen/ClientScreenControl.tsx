import React, { useEffect, useRef } from 'react';
import { Button, Popconfirm, Space, Tag, Tooltip, message } from 'antd';
import { DesktopOutlined, EyeInvisibleOutlined, PoweroffOutlined } from '@ant-design/icons';
import { getClientScreenPresenter, useClientScreenView } from './clientScreenInstance';
import type { ClientScreenOrderProvider } from './clientScreenPresenter';
import type { PublisherLoss } from './clientScreenPublisherCore';

/**
 * Customer screen controls in the order header: present this order, hide, and the emergency
 * switch-off of the whole workstation. Renders nothing when the feature is off for the deployment.
 */
const LOSS_TEXT: Partial<Record<PublisherLoss, { type: 'info' | 'warning' | 'error'; text: string }>> = {
  taken: { type: 'info', text: 'Показ клиенту перехвачен в другой вкладке' },
  'no-answer': { type: 'warning', text: 'Окно клиента не отвечает. Разрешите всплывающие окна для сайта и нажмите «Показать клиенту» ещё раз' },
  policy: { type: 'warning', text: 'Экран клиента выключен в настройках организации' },
  error: { type: 'error', text: 'Экран клиента отключён из-за ошибки. Покажите клиенту свой экран: Win+P → «Повторяющийся»' },
};

const compact: React.CSSProperties = { height: '27px', fontSize: '13px', padding: '0 12px' };

export const ClientScreenControl: React.FC<{ orderKey: string; provider: ClientScreenOrderProvider }> = ({ orderKey, provider }) => {
  const view = useClientScreenView();
  const announced = useRef<PublisherLoss | null>(null);

  useEffect(() => {
    if (view.lost === announced.current) return;
    announced.current = view.lost;
    const note = view.lost ? LOSS_TEXT[view.lost] : undefined;
    if (note) void message[note.type](note.text, note.type === 'info' ? 4 : 8);
  }, [view.lost]);

  if (!view.available) return null;
  const presenter = getClientScreenPresenter();
  if (!presenter) return null;

  if (view.workstationDisabled) {
    return (
      <Space size={6}>
        <Tag>Экран клиента отключён</Tag>
        <Button style={compact} onClick={() => void presenter.enableWorkstation().catch(() => undefined)}>Включить</Button>
      </Space>
    );
  }

  const emergency = (
    <Popconfirm
      title={(
        <div style={{ maxWidth: 320 }}>
          <div>Отключить экран клиента на этом рабочем месте?</div>
          <div style={{ fontWeight: 400 }}>Показ прекратится во всех вкладках. Клиенту можно показать свой экран: Win+P → «Повторяющийся».</div>
        </div>
      )}
      okText="Отключить"
      cancelText="Отмена"
      onConfirm={() => void presenter.disableWorkstation().catch(() => undefined)}
    >
      <Tooltip title="Аварийно отключить экран клиента">
        <Button style={{ ...compact, padding: '0 8px' }} danger icon={<PoweroffOutlined />} aria-label="Отключить экран клиента" />
      </Tooltip>
    </Popconfirm>
  );

  if (view.presentedOrderKey === orderKey) {
    const waiting = view.phase !== 'owner' || view.policyStale;
    return (
      <Space size={6}>
        <Tag color={waiting ? 'default' : 'green'}>{waiting ? 'Открываем экран клиента…' : 'Клиент видит этот заказ'}</Tag>
        <Button style={compact} icon={<EyeInvisibleOutlined />} onClick={() => presenter.hide(orderKey)}>Скрыть от клиента</Button>
        {emergency}
      </Space>
    );
  }

  const other = view.presentedOrderKey !== null;
  return (
    <Space size={6}>
      <Tooltip title={other ? 'Сейчас клиенту показан другой заказ. Нажмите, чтобы показать этот' : 'Показать этот заказ на экране клиента'}>
        <Button style={compact} icon={<DesktopOutlined />} onClick={() => presenter.present(orderKey, provider)}>
          {other ? 'Показать этот заказ' : 'Показать клиенту'}
        </Button>
      </Tooltip>
      {other ? emergency : null}
    </Space>
  );
};
