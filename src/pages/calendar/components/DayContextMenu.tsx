import React from 'react';
import { Menu } from 'antd';
import { SendOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { formatDayTitle } from '../../configuration/components/broadcasts/calendarSendModel';

const OPENING_CLICK_GUARD_MS = 350;

export interface DayContextMenuProps {
  /** Day the menu was opened for, `YYYY-MM-DD`. */
  date: string;
  visible: boolean;
  x: number;
  y: number;
  compact?: boolean;
  /** Send item text, e.g. «Отправить в чат «ЧПУ»». */
  sendLabel?: string;
  onClose: () => void;
  onSendToChat: (date: string) => void;
}

/** Context menu of a day column header (right click / double tap). */
export const DayContextMenu: React.FC<DayContextMenuProps> = ({
  date,
  visible,
  x,
  y,
  compact = false,
  sendLabel = 'Отправить в чат',
  onClose,
  onSendToChat,
}) => {
  React.useEffect(() => {
    if (!visible) return undefined;
    // The click that opened the menu is still propagating to the document: it must not close it.
    const openedAt = Date.now();
    const handleClickOutside = () => {
      if (Date.now() - openedAt > OPENING_CLICK_GUARD_MS) onClose();
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('click', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('click', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [visible, date, x, y, onClose]);

  if (!visible) return null;

  const items: MenuProps['items'] = [
    {
      key: 'day_info',
      label: formatDayTitle(date),
      disabled: true,
      style: { fontWeight: 600, color: '#1890ff', cursor: 'default' },
    },
    { type: 'divider' },
    {
      key: 'send_to_chat',
      label: sendLabel,
      icon: <SendOutlined />,
      onClick: () => {
        onClose();
        onSendToChat(date);
      },
    },
  ];

  return (
    <div
      className={['calendar-context-menu', compact ? 'calendar-context-menu--compact' : ''].filter(Boolean).join(' ')}
      style={{ position: 'fixed', top: y, left: x, zIndex: 9999 }}
      onClick={(e) => e.stopPropagation()}
    >
      <Menu
        mode="vertical"
        items={items}
        style={{
          minWidth: compact ? 0 : 220,
          width: compact ? '100%' : undefined,
          border: 'none',
          boxShadow: '0 3px 6px -4px rgba(0,0,0,.12), 0 6px 16px 0 rgba(0,0,0,0.08)',
        }}
      />
    </div>
  );
};

export default DayContextMenu;
