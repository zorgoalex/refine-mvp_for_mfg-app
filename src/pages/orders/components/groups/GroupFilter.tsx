import React from 'react';
import { Space, Select } from 'antd';
import { GroupSelect } from './GroupSelect';

interface GroupFilterProps {
  value?: string[];
  onChange?: (groupIds: string[]) => void;
  groupIds?: string[];
  groupMode?: 'any' | 'all' | 'primary' | 'none';
  onGroupIdsChange?: (groupIds: string[]) => void;
  onGroupModeChange?: (mode: 'any' | 'all' | 'primary' | 'none') => void;
}

export const GroupFilter: React.FC<GroupFilterProps> = ({
  groupIds,
  value,
  onChange,
  groupMode = 'any',
  onGroupIdsChange,
  onGroupModeChange,
}) => (
  <Space.Compact style={{ width: '100%' }}>
    <GroupSelect
      mode="multiple"
      value={value ?? groupIds}
      onChange={(next) => {
        const normalized = (next as string[]) ?? [];
        onChange?.(normalized);
        onGroupIdsChange?.(normalized);
      }}
      disabled={groupMode === 'none'}
      style={{ width: '70%' }}
      placeholder="Группы"
    />
    <Select
      value={groupMode}
      onChange={onGroupModeChange}
      style={{ width: '30%', minWidth: 96 }}
      options={[
        { value: 'any', label: 'Любой' },
        { value: 'all', label: 'Все' },
        { value: 'primary', label: 'Главный' },
        { value: 'none', label: 'Нет' },
      ]}
    />
  </Space.Compact>
);
