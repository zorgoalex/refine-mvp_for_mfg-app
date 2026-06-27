// src/pages/orders/components/DetailGroupingControls.tsx
import React, { useMemo } from 'react';
import { Dropdown, Button, Checkbox, Space } from 'antd';
import { DownOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import type { GroupField } from '../detailGrouping';
import { GROUP_FIELDS } from '../detailGrouping';
import type { DetailGroupingState } from '../useDetailGrouping';

export function groupingButtonLabel(field: GroupField | null): string {
  if (!field) return 'Группировать по…';
  const def = GROUP_FIELDS.find(f => f.field === field);
  return `Группировка: ${def?.label ?? field}`;
}

export interface DetailGroupingControlsProps {
  state: DetailGroupingState;
  onFieldChange: (field: GroupField | null) => void;
  onToggleSeparation: (value: boolean) => void;
  size?: 'small' | 'middle';
}

export const DetailGroupingControls: React.FC<DetailGroupingControlsProps> = ({
  state,
  onFieldChange,
  onToggleSeparation,
  size = 'small',
}) => {
  const menu: MenuProps = useMemo(
    () => ({
      selectable: true,
      selectedKeys: [state.field ?? 'none'],
      items: [
        { key: 'none', label: 'Без группировки' },
        { type: 'divider' as const },
        ...GROUP_FIELDS.map(f => ({ key: f.field, label: f.label })),
      ],
      onClick: ({ key }) => onFieldChange(key === 'none' ? null : (key as GroupField)),
    }),
    [state.field, onFieldChange],
  );

  return (
    <Space size="small">
      <Dropdown menu={menu} trigger={['click']}>
        <Button size={size}>
          {groupingButtonLabel(state.field)} <DownOutlined />
        </Button>
      </Dropdown>
      {state.field !== null && (
        <Checkbox
          checked={state.showSeparation}
          onChange={e => onToggleSeparation(e.target.checked)}
        >
          Разделение на группы
        </Checkbox>
      )}
    </Space>
  );
};
