import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Modal, Space, Tooltip, message } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, HolderOutlined, SettingOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { profileApi } from '../../../../api/profileApi';
import type { OrderDetailColumnPreference } from '../../../../api/types/profileApi.types';

export interface OrderDetailColumnDefinition {
  key: string;
  label: string;
  lockVisible?: boolean;
}

export interface OrderDetailColumnSettingsButtonProps {
  tableKey: string;
  definitions: OrderDetailColumnDefinition[];
  defaultOrder: string[];
  settings: OrderDetailColumnPreference;
  onChange: (settings: OrderDetailColumnPreference) => void;
}

export function normalizeOrderDetailColumnSettings(
  defaultOrder: string[],
  definitions: OrderDetailColumnDefinition[],
  value?: Partial<OrderDetailColumnPreference> | null,
): OrderDetailColumnPreference {
  const allowed = new Set(definitions.map((definition) => definition.key));
  const locked = new Set(definitions.filter((definition) => definition.lockVisible).map((definition) => definition.key));
  const order = uniqueKnownKeys([...(value?.order ?? []), ...defaultOrder], allowed);
  const hidden = uniqueKnownKeys(value?.hidden ?? [], allowed).filter((key) => !locked.has(key));

  return { order, hidden };
}

export function applyOrderDetailColumnSettings<T>(
  columns: ColumnsType<T>,
  settings: OrderDetailColumnPreference,
): ColumnsType<T> {
  const columnsByKey = new Map<string, ColumnsType<T>[number]>();
  const unknownColumns: ColumnsType<T> = [];

  for (const column of columns) {
    const key = String(column.key ?? '');
    if (!key) {
      unknownColumns.push(column);
      continue;
    }
    columnsByKey.set(key, column);
  }

  const hidden = new Set(settings.hidden);
  const ordered: ColumnsType<T> = [];
  for (const key of settings.order) {
    const column = columnsByKey.get(key);
    if (!column || hidden.has(key)) continue;
    ordered.push(column);
    columnsByKey.delete(key);
  }

  for (const [key, column] of columnsByKey.entries()) {
    if (!hidden.has(key)) ordered.push(column);
  }

  return [...ordered, ...unknownColumns];
}

export function useOrderDetailColumnPreferences(tableKey: string, defaultOrder: string[], definitions: OrderDetailColumnDefinition[]) {
  const [allPreferences, setAllPreferences] = useState<Record<string, OrderDetailColumnPreference>>({});
  const [settings, setSettings] = useState(() => normalizeOrderDetailColumnSettings(defaultOrder, definitions));

  useEffect(() => {
    let alive = true;
    profileApi.getPreferences()
      .then((response) => {
        if (!alive) return;
        const nextAll = response.preferences.orderDetailColumns ?? {};
        setAllPreferences(nextAll);
        setSettings(normalizeOrderDetailColumnSettings(defaultOrder, definitions, nextAll[tableKey]));
      })
      .catch(() => {
        if (alive) {
          setSettings(normalizeOrderDetailColumnSettings(defaultOrder, definitions));
        }
      });
    return () => {
      alive = false;
    };
  }, [defaultOrder, definitions, tableKey]);

  const saveSettings = useCallback(async (next: OrderDetailColumnPreference) => {
    const normalized = normalizeOrderDetailColumnSettings(defaultOrder, definitions, next);
    const nextAll = { ...allPreferences, [tableKey]: normalized };
    setSettings(normalized);
    setAllPreferences(nextAll);

    const response = await profileApi.updatePreferences({ orderDetailColumns: nextAll });
    const savedAll = response.preferences.orderDetailColumns ?? nextAll;
    setAllPreferences(savedAll);
    setSettings(normalizeOrderDetailColumnSettings(defaultOrder, definitions, savedAll[tableKey]));
  }, [allPreferences, defaultOrder, definitions, tableKey]);

  return { settings, saveSettings };
}

export const OrderDetailColumnSettingsButton: React.FC<OrderDetailColumnSettingsButtonProps> = ({
  defaultOrder,
  definitions,
  settings,
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const hasHiddenColumns = settings.hidden.length > 0;

  const definitionByKey = useMemo(
    () => new Map(definitions.map((definition) => [definition.key, definition])),
    [definitions],
  );

  useEffect(() => {
    if (!open) {
      setDraft(settings);
    }
  }, [open, settings]);

  const rows = useMemo(
    () => draft.order.map((key) => definitionByKey.get(key)).filter(Boolean) as OrderDetailColumnDefinition[],
    [definitionByKey, draft.order],
  );

  const hidden = useMemo(() => new Set(draft.hidden), [draft.hidden]);

  const move = (key: string, direction: -1 | 1) => {
    const index = draft.order.indexOf(key);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= draft.order.length) return;
    const nextOrder = [...draft.order];
    [nextOrder[index], nextOrder[nextIndex]] = [nextOrder[nextIndex], nextOrder[index]];
    setDraft({ ...draft, order: nextOrder });
  };

  const moveTo = (fromKey: string, toKey: string) => {
    if (fromKey === toKey) return;
    const fromIndex = draft.order.indexOf(fromKey);
    const toIndex = draft.order.indexOf(toKey);
    if (fromIndex < 0 || toIndex < 0) return;

    const nextOrder = [...draft.order];
    const [moved] = nextOrder.splice(fromIndex, 1);
    nextOrder.splice(toIndex, 0, moved);
    setDraft({ ...draft, order: nextOrder });
  };

  const toggleVisible = (key: string, checked: boolean) => {
    const definition = definitionByKey.get(key);
    if (definition?.lockVisible) return;

    const nextHidden = new Set(draft.hidden);
    if (checked) nextHidden.delete(key);
    else nextHidden.add(key);
    setDraft({ ...draft, hidden: Array.from(nextHidden) });
  };

  const reset = () => {
    setDragKey(null);
    setDragOverKey(null);
    setDraft(normalizeOrderDetailColumnSettings(defaultOrder, definitions));
  };

  const save = async () => {
    setSaving(true);
    try {
      await onChange(draft);
      setOpen(false);
    } catch {
      message.error('Не удалось сохранить настройки колонок');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Tooltip
        title={
          hasHiddenColumns
            ? 'Есть скрытые колонки. Нажмите, чтобы настроить видимость и порядок колонок'
            : 'Настроить вид списка: показать или скрыть колонки и изменить их порядок для вашего пользователя'
        }
      >
        <Button
          aria-label="Настроить колонки деталей"
          size="small"
          icon={<SettingOutlined style={{ color: hasHiddenColumns ? '#ff4d4f' : undefined }} />}
          onClick={() => setOpen(true)}
        />
      </Tooltip>
      <Modal
        title="Настройка колонок деталей"
        open={open}
        onCancel={() => setOpen(false)}
        afterClose={() => {
          setDragKey(null);
          setDragOverKey(null);
        }}
        onOk={save}
        okText="Сохранить"
        cancelText="Отмена"
        confirmLoading={saving}
        width={520}
        footer={(_, { OkBtn, CancelBtn }) => (
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Button onClick={reset}>Сбросить по умолчанию</Button>
            <Space>
              <CancelBtn />
              <OkBtn />
            </Space>
          </Space>
        )}
      >
        <div style={{ display: 'grid', gap: 6 }}>
          {rows.map((definition, index) => (
            <div
              key={definition.key}
              draggable
              onDragStart={(event) => {
                setDragKey(definition.key);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', definition.key);
              }}
              onDragEnter={(event) => {
                event.preventDefault();
                if (dragKey && dragKey !== definition.key) {
                  setDragOverKey(definition.key);
                }
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => {
                event.preventDefault();
                const fromKey = event.dataTransfer.getData('text/plain') || dragKey;
                if (fromKey) {
                  moveTo(fromKey, definition.key);
                }
                setDragKey(null);
                setDragOverKey(null);
              }}
              onDragEnd={() => {
                setDragKey(null);
                setDragOverKey(null);
              }}
              style={{
                display: 'grid',
                gridTemplateColumns: '24px 1fr auto',
                alignItems: 'center',
                gap: 8,
                padding: '6px 8px',
                border: dragOverKey === definition.key
                  ? '1px solid #1677ff'
                  : '1px solid var(--app-border)',
                borderRadius: 6,
                background: hidden.has(definition.key) ? 'var(--app-surface-muted)' : 'var(--app-surface)',
                cursor: 'grab',
                opacity: dragKey === definition.key ? 0.45 : 1,
              }}
            >
              <Tooltip title="Зажмите левую кнопку мыши и перетащите строку выше или ниже, чтобы изменить порядок колонок">
                <HolderOutlined
                  aria-label="Перетащить колонку"
                  style={{ color: 'var(--app-text-muted)', cursor: 'grab' }}
                />
              </Tooltip>
              <Checkbox
                checked={!hidden.has(definition.key)}
                disabled={definition.lockVisible}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => toggleVisible(definition.key, event.target.checked)}
              >
                {definition.label}
              </Checkbox>
              <Space size={4}>
                <Button
                  size="small"
                  icon={<ArrowUpOutlined />}
                  disabled={index === 0}
                  onClick={() => move(definition.key, -1)}
                />
                <Button
                  size="small"
                  icon={<ArrowDownOutlined />}
                  disabled={index === rows.length - 1}
                  onClick={() => move(definition.key, 1)}
                />
              </Space>
            </div>
          ))}
        </div>
      </Modal>
    </>
  );
};

function uniqueKnownKeys(keys: string[], allowed: Set<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const key of keys) {
    if (!allowed.has(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}
