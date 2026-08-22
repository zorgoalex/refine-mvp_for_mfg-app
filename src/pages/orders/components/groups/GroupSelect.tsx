import React, { useEffect, useMemo, useState } from 'react';
import { Select } from 'antd';
import type { SelectProps } from 'antd';
import { groupsApi } from '../../../../api/groupsApi';
import type { GroupLookupItem, GroupRef } from '../../../../api/types/groupApi.types';
import { useOrderAsyncReadGuard } from '../../../../query/orderLifecycleQueries';

interface GroupSelectProps extends Omit<SelectProps<string | string[]>, 'options' | 'onSearch'> {
  mode?: 'multiple';
  selectedGroups?: GroupRef[];
}

export const GroupSelect: React.FC<GroupSelectProps> = ({ value, mode, selectedGroups = [], ...props }) => {
  const [search, setSearch] = useState('');
  const readGuard = useOrderAsyncReadGuard(`group-lookup:${search}`);
  const readScopeKey = `${readGuard.authNamespace}|search:${search}`;
  const [itemsState, setItemsState] = useState<{
    scopeKey: string;
    value: GroupLookupItem[];
  } | null>(null);
  const items = itemsState?.scopeKey === readScopeKey ? itemsState.value : [];

  useEffect(() => {
    if (!readGuard.active) return;
    const token = readGuard.capture();
    if (!token) return;
    void groupsApi.lookupGroups({ search, limit: 20 }).then((response) => {
      if (readGuard.isCurrent(token)) {
        setItemsState({ scopeKey: readScopeKey, value: response.data });
      }
    }).catch(() => {
      if (readGuard.isCurrent(token)) {
        setItemsState({ scopeKey: readScopeKey, value: [] });
      }
    });
  }, [readGuard.active, readGuard.capture, readGuard.isCurrent, readScopeKey, search]);

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
