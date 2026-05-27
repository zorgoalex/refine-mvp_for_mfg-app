import React from 'react';
import { Space, Select } from 'antd';
import { ProjectSelect } from './ProjectSelect';

interface ProjectFilterProps {
  value?: string[];
  onChange?: (projectIds: string[]) => void;
  projectIds?: string[];
  projectMode?: 'any' | 'all' | 'primary' | 'none';
  onProjectIdsChange?: (projectIds: string[]) => void;
  onProjectModeChange?: (mode: 'any' | 'all' | 'primary' | 'none') => void;
}

export const ProjectFilter: React.FC<ProjectFilterProps> = ({
  projectIds,
  value,
  onChange,
  projectMode = 'any',
  onProjectIdsChange,
  onProjectModeChange,
}) => (
  <Space.Compact style={{ width: '100%' }}>
    <ProjectSelect
      mode="multiple"
      value={value ?? projectIds}
      onChange={(next) => {
        const normalized = (next as string[]) ?? [];
        onChange?.(normalized);
        onProjectIdsChange?.(normalized);
      }}
      disabled={projectMode === 'none'}
      style={{ width: '70%' }}
      placeholder="Проекты"
    />
    <Select
      value={projectMode}
      onChange={onProjectModeChange}
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
