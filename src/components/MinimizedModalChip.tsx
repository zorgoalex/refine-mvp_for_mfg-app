// Плавающий бейдж свёрнутой модалки: рендерится через portal в body,
// поэтому виден на любой вкладке/странице. Клик — разворачивает модалку
// (вызывающая сторона при необходимости сначала возвращается на свой роут).

import React from 'react';
import { createPortal } from 'react-dom';
import { CloseOutlined, ExpandAltOutlined } from '@ant-design/icons';
import { Button, Space, Typography } from 'antd';

const { Text } = Typography;

interface MinimizedModalChipProps {
  title: string;
  onRestore: () => void;
  onClose?: () => void;
  /** Слот снизу (0 — самый нижний), чтобы несколько чипов не перекрывались */
  slot?: number;
}

export const MinimizedModalChip: React.FC<MinimizedModalChipProps> = ({
  title,
  onRestore,
  onClose,
  slot = 0,
}) => {
  return createPortal(
    <div
      style={{
        position: 'fixed',
        right: 24,
        bottom: 24 + slot * 52,
        zIndex: 1050,
        background: 'var(--ant-color-bg-elevated, #fff)',
        border: '1px solid #d9d9d9',
        borderRadius: 8,
        boxShadow: '0 6px 16px rgba(0, 0, 0, 0.18)',
        padding: '8px 12px',
        maxWidth: 360,
      }}
    >
      <Space size={8}>
        <Button
          type="text"
          size="small"
          icon={<ExpandAltOutlined />}
          onClick={onRestore}
          title="Развернуть"
        />
        <Text
          style={{ cursor: 'pointer', maxWidth: 240 }}
          ellipsis={{ tooltip: title }}
          onClick={onRestore}
        >
          {title}
        </Text>
        {onClose ? (
          <Button type="text" size="small" icon={<CloseOutlined />} onClick={onClose} title="Закрыть" />
        ) : null}
      </Space>
    </div>,
    document.body,
  );
};
