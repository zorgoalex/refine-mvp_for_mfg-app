import React from 'react';
import { message, Modal, Tabs } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import { DraggableModalWrapper } from '../../components/DraggableModalWrapper';
import { computeCloseTargetPath, type WorkspaceTab, useTabStore } from '../../stores/tabStore';

export interface EvolutionTabCloseRequest {
  targetKey: string;
  activeKey: string;
  tabs: WorkspaceTab[];
  closeTab: (key: string, options?: { discard?: boolean }) => boolean;
  navigate: (path: string) => void;
  confirmDiscard: (onConfirm: () => void) => void;
  onBlocked: () => void;
}

export function requestEvolutionTabClose(request: EvolutionTabCloseRequest): void {
  const close = (discard = false) => {
    const closeTargetPath = computeCloseTargetPath(request.tabs, request.targetKey);
    const closed = request.closeTab(
      request.targetKey,
      discard ? { discard: true } : undefined,
    );
    if (closed === false) {
      request.onBlocked?.();
      return;
    }
    if (request.targetKey === request.activeKey) {
      request.navigate(closeTargetPath);
    }
  };
  const tab = request.tabs.find((item) => item.key === request.targetKey);
  if (tab?.dirty) {
    request.confirmDiscard(() => close(true));
    return;
  }
  close();
}

export const EvolutionWorkspaceTabs: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const tabs = useTabStore((state) => state.tabs);
  const closeTab = useTabStore((state) => state.closeTab);
  const activeKey = location.pathname;

  const onEdit = (targetKey: React.Key | React.MouseEvent | React.KeyboardEvent, action: 'add' | 'remove') => {
    if (action !== 'remove' || typeof targetKey !== 'string') return;
    requestEvolutionTabClose({
      targetKey,
      activeKey,
      tabs,
      closeTab,
      navigate,
      onBlocked: () => {
        message.warning('Дождитесь завершения операции перед закрытием вкладки');
      },
      confirmDiscard: (onConfirm) => {
        Modal.confirm({
          title: 'Несохраненные изменения',
          content: 'Закрыть вкладку без сохранения?',
          okText: 'Закрыть',
          cancelText: 'Остаться',
          modalRender: (modal) => React.createElement(DraggableModalWrapper, null, modal),
          onOk: onConfirm,
        });
      },
    });
  };

  if (tabs.length === 0) return null;

  return (
    <Tabs
      activeKey={activeKey}
      aria-label="Открытые страницы"
      className="workspace-tabs evolution-workspace-tabs"
      hideAdd
      items={tabs.map((tab) => ({
        key: tab.key,
        label: (
          <span className="evolution-workspace-tabs__label">
            {tab.dirty ? <span aria-label="Есть несохраненные изменения" className="evolution-workspace-tabs__dirty" /> : null}
            {tab.label}
          </span>
        ),
      }))}
      onChange={(key) => {
        const tab = tabs.find((item) => item.key === key);
        navigate(tab ? tab.path : key);
      }}
      onEdit={onEdit}
      type="editable-card"
    />
  );
};
