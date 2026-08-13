import { Tooltip } from '../../../ui/tooltipDelay';
// src/pages/orders/components/DetailGroupingControls.tsx
import React, { useMemo } from 'react';
import { Dropdown, Button, Checkbox, Space } from 'antd';
import { ApartmentOutlined, DownOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import type { GroupField } from '../detailGrouping';
import { GROUP_FIELDS } from '../detailGrouping';
import type { DetailGroupingState } from '../useDetailGrouping';
import { OrderToolbarLabel } from './OrderDetailsToolbar';

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
  hiddenFields?: GroupField[];
}

export const DetailGroupingControls: React.FC<DetailGroupingControlsProps> = ({
  state,
  onFieldChange,
  onToggleSeparation,
  size = 'small',
  hiddenFields = [],
}) => {
  const menu: MenuProps = useMemo(
    () => ({
      selectable: true,
      selectedKeys: [state.field ?? 'none'],
      items: [
        { key: 'none', label: 'Без группировки' },
        { type: 'divider' as const },
        ...GROUP_FIELDS
          .filter((field) => !hiddenFields.includes(field.field))
          .map(f => ({ key: f.field, label: f.label })),
      ],
      onClick: ({ key }) => onFieldChange(key === 'none' ? null : (key as GroupField)),
    }),
    [hiddenFields, state.field, onFieldChange],
  );

  return (
    <Space size="small">
      <Dropdown menu={menu} trigger={['click']}>
        <Button size={size} icon={<ApartmentOutlined />} aria-label={groupingButtonLabel(state.field)}>
          <OrderToolbarLabel>{groupingButtonLabel(state.field)}</OrderToolbarLabel> <DownOutlined />
        </Button>
      </Dropdown>
      {state.field !== null && (
        <Tooltip title="Разделение на группы">
          <Checkbox
            checked={state.showSeparation}
            onChange={e => onToggleSeparation(e.target.checked)}
            aria-label="Разделение на группы"
          >
            <OrderToolbarLabel>Разделение на группы</OrderToolbarLabel>
          </Checkbox>
        </Tooltip>
      )}
    </Space>
  );
};
