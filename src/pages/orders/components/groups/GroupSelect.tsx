import React, { useEffect, useMemo, useState } from 'react';
import { Select } from 'antd';
import type { SelectProps } from 'antd';
import { groupsApi } from '../../../../api/groupsApi';
import type { GroupLookupItem, GroupRef } from '../../../../api/types/groupApi.types';

interface GroupSelectProps extends Omit<SelectProps<string | string[]>, 'options' | 'onSearch'> {
  mode?: 'multiple';
  selectedGroups?: GroupRef[];
}

export const GroupSelect: React.FC<GroupSelectProps> = ({ value, mode, selectedGroups = [], ...props }) => {
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<GroupLookupItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    void groupsApi.lookupGroups({ search, limit: 20 }).then((response) => {
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
    for (const group of selectedGroups) {
      merged.set(group.id, { value: group.id, label: `${group.code} · ${group.name}` });
    }
    for (const group of items) {
      merged.set(group.id, { value: group.id, label: `${group.code} · ${group.name}` });
    }
    return [...merged.values()];
  }, [items, selectedGroups]);

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
      placeholder={props.placeholder ?? 'Группа'}
    />
  );
};
