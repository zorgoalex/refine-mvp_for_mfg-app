import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AutoComplete, Space, Typography } from 'antd';
import { whatsappApi } from '../../../api/whatsappApi';
import type { WhatsAppGroupDto } from '../../../api/types/whatsappApi.types';
import {
  filterGroups,
  findGroupById,
  groupDisplayName,
  groupWarnings,
  groupsErrorText,
} from './whatsappGroupsView';

const { Text } = Typography;

export interface WhatsAppGroupSelectProps {
  value?: string | null;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * Effect body for a "still mounted" ref. The flag is set in setup (not only in the
 * initial ref value) because StrictMode runs setup → cleanup → setup on mount.
 */
export function trackMounted(ref: { current: boolean }): () => void {
  ref.current = true;
  return () => { ref.current = false; };
}

/**
 * Picker WhatsApp-групп для Form.Item. Список грузится лениво при первом
 * фокусе/открытии и никогда не опрашивается автоматически. Ручной ввод ID
 * остаётся доступным (fallback, если WAHA недоступен).
 */
export const WhatsAppGroupSelect: React.FC<WhatsAppGroupSelectProps> = ({
  value,
  onChange,
  placeholder = '120…@g.us',
  disabled,
}) => {
  const [groups, setGroups] = useState<WhatsAppGroupDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const mounted = useRef(false);
  useEffect(() => trackMounted(mounted), []);
  // 'idle' → first focus loads; 'failed' → the next focus/open retries (the backend
  // keeps its own 10-second cooldown, so retries never hammer WAHA).
  const loadState = useRef<'idle' | 'loading' | 'loaded' | 'failed'>('idle');

  const ensureLoaded = useCallback(async () => {
    if (loadState.current === 'loading' || loadState.current === 'loaded') return;
    loadState.current = 'loading';
    setLoading(true);
    setLoadError(null);
    try {
      const response = await whatsappApi.groups();
      loadState.current = 'loaded';
      if (mounted.current) setGroups(response.groups);
    } catch (error) {
      loadState.current = 'failed';
      if (mounted.current) setLoadError(groupsErrorText(error));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  const text = value ?? '';
  const options = useMemo(
    () =>
      filterGroups(groups, search).map((group) => ({
        value: group.id,
        label: (
          <Space size={6} style={{ justifyContent: 'space-between', width: '100%' }}>
            <span>{groupDisplayName(group)}</span>
            {group.participantCount !== null ? (
              <Text type="secondary">{group.participantCount} уч.</Text>
            ) : null}
          </Space>
        ),
      })),
    [groups, search],
  );
  const selected = findGroupById(groups, text);
  const warnings = selected ? groupWarnings(selected) : [];

  return (
    <div>
      <AutoComplete
        value={text}
        options={options}
        disabled={disabled}
        placeholder={placeholder}
        style={{ width: '100%' }}
        notFoundContent={loading ? 'Загрузка групп…' : null}
        filterOption={false}
        onFocus={() => void ensureLoaded()}
        onDropdownVisibleChange={(open: boolean) => { if (open) void ensureLoaded(); }}
        onSearch={setSearch}
        onChange={(next: string) => {
          setSearch(next ?? '');
          onChange?.(next ?? '');
        }}
        onSelect={() => setSearch('')}
      />
      {selected ? (
        <div style={{ marginTop: 4 }}>
          <Text type="secondary">Группа: {groupDisplayName(selected)}</Text>
          {warnings.map((warning) => (
            <div key={warning.key}>
              <Text type="warning">{warning.text}</Text>
            </div>
          ))}
        </div>
      ) : null}
      {loadError ? (
        <div style={{ marginTop: 4 }}>
          <Text type="secondary">Список групп недоступен: {loadError}. Введите ID вручную или откройте список ещё раз, чтобы повторить.</Text>
        </div>
      ) : null}
    </div>
  );
};
