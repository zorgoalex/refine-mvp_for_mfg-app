import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AutoComplete, Space, Typography } from 'antd';
import './WhatsAppGroupSelect.css';
import type { WhatsAppGroupDto } from '../../../api/types/whatsappApi.types';
import {
  filterGroups,
  findGroupById,
  groupDisplayName,
  groupWarnings,
  groupsErrorText,
} from './whatsappGroupsView';
import { loadWhatsAppGroups } from './whatsappGroupsCache';

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
 * Picker WhatsApp-групп для Form.Item. Список грузится один раз: сразу, если ID
 * уже выбран (чтобы рядом показать название группы), иначе при первом
 * фокусе/открытии; периодически не опрашивается. Ручной ввод ID остаётся
 * доступным (fallback, если WAHA недоступен).
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
      const list = await loadWhatsAppGroups();
      loadState.current = 'loaded';
      if (mounted.current) setGroups(list);
    } catch (error) {
      loadState.current = 'failed';
      if (mounted.current) setLoadError(groupsErrorText(error));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  const text = value ?? '';
  const hasValue = text.trim() !== '';
  // A saved group is shown by name right away; an empty field still waits for the user.
  useEffect(() => {
    if (hasValue && loadState.current === 'idle') void ensureLoaded();
  }, [hasValue, ensureLoaded]);
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
  const missing = /@g\.us$/.test(text.trim()) && !selected && !loading && loadState.current === 'loaded';

  return (
    <div>
      <div className="whatsapp-group-select-row">
        <AutoComplete
          value={text}
          options={options}
          disabled={disabled}
          placeholder={placeholder}
          className="whatsapp-group-select-input"
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
          <Text strong className="whatsapp-group-select-name" title={groupDisplayName(selected)}>
            {groupDisplayName(selected)}
          </Text>
        ) : null}
        {missing ? (
          <Text type="warning" className="whatsapp-group-select-name">Нет в списке групп аккаунта</Text>
        ) : null}
      </div>
      {warnings.length > 0 ? (
        <div style={{ marginTop: 4 }}>
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
