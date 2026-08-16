import React from 'react';
import { Tabs, Modal, message } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTabStore, computeNeighborPath } from '../../stores/tabStore';
import { DraggableModalWrapper } from '../DraggableModalWrapper';

export const WorkspaceTabs: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const tabs = useTabStore((s) => s.tabs);
  const closeTab = useTabStore((s) => s.closeTab);
  const activeKey = location.pathname;

  const onEdit = (targetKey: any, action: 'add' | 'remove') => {
    if (action !== 'remove') return;
    const tab = tabs.find((t) => t.key === targetKey);
    const close = (discard?: boolean) => {
      const closed = closeTab(String(targetKey), discard ? { discard: true } : undefined);
      if (!closed) {
        message.warning('Дождитесь завершения операции перед закрытием вкладки');
        return;
      }
      if (targetKey === activeKey) navigate(computeNeighborPath(tabs, String(targetKey)));
    };
    if (tab?.dirty) {
      Modal.confirm({
        title: 'Несохраненные изменения',
        content: 'Закрыть вкладку без сохранения?',
        okText: 'Закрыть',
        cancelText: 'Остаться',
        modalRender: (m) => React.createElement(DraggableModalWrapper, null, m),
        onOk: () => close(true),
      });
    } else {
      close(false);
    }
  };

  if (tabs.length === 0) return null;
  return (
    <Tabs
      className="workspace-tabs"
      type="editable-card"
      hideAdd
      activeKey={activeKey}
      onChange={(key) => {
        const t = tabs.find((x) => x.key === key);
        navigate(t ? t.path : key);
      }}
      onEdit={onEdit}
      items={tabs.map((t) => ({ key: t.key, label: t.dirty ? `● ${t.label}` : t.label }))}
      style={{ padding: '4px 8px 0' }}
    />
  );
};
