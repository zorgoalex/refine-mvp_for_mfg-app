import React, { useEffect, useMemo, useState } from 'react';
import { Select } from 'antd';
import type { SelectProps } from 'antd';
import { projectsApi } from '../../../../api/projectsApi';
import type { ProjectLookupItem, ProjectRef } from '../../../../api/types/projectApi.types';

interface ProjectSelectProps extends Omit<SelectProps<string | string[]>, 'options' | 'onSearch'> {
  mode?: 'multiple';
  selectedProjects?: ProjectRef[];
}

export const ProjectSelect: React.FC<ProjectSelectProps> = ({ value, mode, selectedProjects = [], ...props }) => {
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

  const options = useMemo(() => {
    const merged = new Map<string, { value: string; label: string }>();
    for (const project of selectedProjects) {
      merged.set(project.id, { value: project.id, label: `${project.code} · ${project.name}` });
    }
    for (const project of items) {
      merged.set(project.id, { value: project.id, label: `${project.code} · ${project.name}` });
    }
    return [...merged.values()];
  }, [items, selectedProjects]);

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
