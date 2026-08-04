import React from 'react';
import { Button, Space, Tooltip } from 'antd';
import type { LabelCutMapStyle } from './labelCutMapStyle';

export function LabelCutMapFlipControls({
  cutMapStyle,
  disabled,
  variant,
  onToggle,
}: {
  cutMapStyle: LabelCutMapStyle;
  disabled: boolean;
  variant: 'icons' | 'words';
  onToggle: (axis: 'horizontal' | 'vertical') => void;
}) {
  const wordButtons = variant === 'words';
  return (
    <Space.Compact block>
      <Tooltip title="Отразить миниатюру по горизонтали">
        <Button
          block={wordButtons}
          aria-label="Отразить миниатюру по горизонтали"
          aria-pressed={cutMapStyle.flipHorizontal}
          data-label-cut-map-flip="horizontal"
          type={cutMapStyle.flipHorizontal ? 'primary' : 'default'}
          disabled={disabled}
          style={{ minWidth: 40, minHeight: 40 }}
          onClick={() => onToggle('horizontal')}
        >
          {wordButtons ? 'По горизонтали' : <span aria-hidden>↔</span>}
        </Button>
      </Tooltip>
      <Tooltip title="Отразить миниатюру по вертикали">
        <Button
          block={wordButtons}
          aria-label="Отразить миниатюру по вертикали"
          aria-pressed={cutMapStyle.flipVertical}
          data-label-cut-map-flip="vertical"
          type={cutMapStyle.flipVertical ? 'primary' : 'default'}
          disabled={disabled}
          style={{ minWidth: 40, minHeight: 40 }}
          onClick={() => onToggle('vertical')}
        >
          {wordButtons ? 'По вертикали' : <span aria-hidden>↕</span>}
        </Button>
      </Tooltip>
    </Space.Compact>
  );
}
