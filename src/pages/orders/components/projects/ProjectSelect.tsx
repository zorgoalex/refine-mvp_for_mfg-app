import React, { useEffect, useMemo, useState } from 'react';
import { Select } from 'antd';
import type { SelectProps } from 'antd';
import { projectsApi } from '../../../../api/projectsApi';
import type { ProjectLookupItem } from '../../../../api/types/projectApi.types';

interface ProjectSelectProps extends Omit<SelectProps<string | string[]>, 'options' | 'onSearch'> {
  mode?: 'multiple';
}

export const ProjectSelect: React.FC<ProjectSelectProps> = ({ value, mode, ...props }) => {
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<ProjectLookupItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    void projectsApi.lookupProjects({ search, limit: 20 }).then((response) => {
      if (!cancelled) setItems(response.data);
    }).catch(() => {
      if (!cancelled) setItems([]);
    });
    return () => {
      cancelled = true;
    };
  }, [search]);

  const options = useMemo(() => items.map((project) => ({
    value: project.id,
    label: `${project.code} · ${project.name}`,
  })), [items]);

  return (
    <Select
      {...props}
      mode={mode}
      value={value}
      options={options}
      allowClear
      showSearch
      filterOption={false}
      onSearch={setSearch}
      placeholder={props.placeholder ?? 'Проект'}
    />
  );
};
