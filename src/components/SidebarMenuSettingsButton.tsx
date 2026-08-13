import { Tooltip } from '../ui/tooltipDelay';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Modal, Space, Typography, message } from 'antd';
import type { ButtonProps } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, HolderOutlined, SettingOutlined } from '@ant-design/icons';
import type { SidebarMenuOrderPreference } from '../api/types/profileApi.types';
import {
  normalizeSidebarMenuOrderPreference,
  type SidebarMenuOrderDefaults,
  type SiderMenuItem,
  type SiderMenuOrderItem,
} from '../utils/siderMenuItems';

export interface SidebarMenuSettingsButtonProps {
  topItems: SiderMenuOrderItem[];
  categorizedResources: Record<string, SiderMenuItem[]>;
  categoryLabels?: Partial<Record<string, string>>;
  defaults: SidebarMenuOrderDefaults;
  settings: SidebarMenuOrderPreference;
  onChange: (settings: SidebarMenuOrderPreference) => Promise<void> | void;
  buttonProps?: Omit<ButtonProps, 'aria-label' | 'icon' | 'onClick'>;
  tooltipPlacement?: 'top' | 'right' | 'bottom' | 'left';
}

interface SettingsSection {
  key: string;
  title: string;
  definitions: SiderMenuOrderItem[];
}

interface DragState {
  sectionKey: string;
  itemKey: string;
}

const RESOURCE_SECTION_PREFIX = 'resources:';

export const SidebarMenuSettingsButton: React.FC<SidebarMenuSettingsButtonProps> = ({
  topItems,
  categorizedResources,
  categoryLabels,
  defaults,
  settings,
  onChange,
  buttonProps,
  tooltipPlacement = 'right',
}) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [dragOverState, setDragOverState] = useState<DragState | null>(null);

  useEffect(() => {
    if (!open) setDraft(settings);
  }, [open, settings]);

  const sections = useMemo<SettingsSection[]>(() => {
    const categoryDefinitions = defaults.categories.map((category) => ({
      key: category,
      label: categoryLabels?.[category] ?? category,
    }));
    const nextSections: SettingsSection[] = [
      {
        key: 'top',
        title: 'Верхние пункты',
        definitions: topItems,
      },
      {
        key: 'categories',
        title: 'Разделы',
        definitions: categoryDefinitions,
      },
    ].filter((section) => section.definitions.length > 0);

    for (const category of draft.categories) {
      const definitions = (categorizedResources[category] ?? []).map((item) => ({
        key: item.name,
        label: item.label,
      }));
      if (definitions.length === 0) continue;
      nextSections.push({
        key: `${RESOURCE_SECTION_PREFIX}${category}`,
        title: categoryLabels?.[category] ?? category,
        definitions,
      });
    }

    return nextSections;
  }, [categorizedResources, categoryLabels, defaults.categories, draft.categories, topItems]);

  const saveDraft = useCallback(async (next: SidebarMenuOrderPreference) => {
    setSaving(true);
    setSaveError(false);
    try {
      await onChange(next);
    } catch {
      setSaveError(true);
      message.error('Не удалось сохранить порядок меню');
    } finally {
      setSaving(false);
    }
  }, [onChange]);

  const updateDraft = useCallback((next: SidebarMenuOrderPreference) => {
    const normalized = normalizeSidebarMenuOrderPreference(defaults, next);
    setDraft(normalized);
    void saveDraft(normalized);
  }, [defaults, saveDraft]);

  const getSectionOrder = useCallback((sectionKey: string): string[] => {
    if (sectionKey === 'top') return draft.top;
    if (sectionKey === 'categories') return draft.categories;
    if (sectionKey.startsWith(RESOURCE_SECTION_PREFIX)) {
      const category = sectionKey.slice(RESOURCE_SECTION_PREFIX.length);
      return draft.resources[category] ?? [];
    }
    return [];
  }, [draft]);

  const updateSectionOrder = useCallback((sectionKey: string, order: string[]) => {
    if (sectionKey === 'top') {
      updateDraft({ ...draft, top: order });
      return;
    }
    if (sectionKey === 'categories') {
      updateDraft({ ...draft, categories: order });
      return;
    }
    if (sectionKey.startsWith(RESOURCE_SECTION_PREFIX)) {
      const category = sectionKey.slice(RESOURCE_SECTION_PREFIX.length);
      updateDraft({
        ...draft,
        resources: {
          ...draft.resources,
          [category]: order,
        },
      });
    }
  }, [draft, updateDraft]);

  const move = (sectionKey: string, itemKey: string, direction: -1 | 1) => {
    const order = getSectionOrder(sectionKey);
    const index = order.indexOf(itemKey);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return;
    const nextOrder = [...order];
    [nextOrder[index], nextOrder[nextIndex]] = [nextOrder[nextIndex], nextOrder[index]];
    updateSectionOrder(sectionKey, nextOrder);
  };

  const moveTo = (sectionKey: string, fromKey: string, toKey: string) => {
    if (fromKey === toKey) return;
    const order = getSectionOrder(sectionKey);
    const fromIndex = order.indexOf(fromKey);
    const toIndex = order.indexOf(toKey);
    if (fromIndex < 0 || toIndex < 0) return;

    const nextOrder = [...order];
    const [moved] = nextOrder.splice(fromIndex, 1);
    nextOrder.splice(toIndex, 0, moved);
    updateSectionOrder(sectionKey, nextOrder);
  };

  const reset = () => {
    setDragState(null);
    setDragOverState(null);
    updateDraft(normalizeSidebarMenuOrderPreference(defaults));
  };

  return (
    <>
      <Tooltip title="Настроить порядок меню" placement={tooltipPlacement}>
        <Button
          {...buttonProps}
          aria-label="Настроить порядок меню"
          icon={<SettingOutlined />}
          onClick={() => setOpen(true)}
        />
      </Tooltip>
      <Modal
        title="Настройка порядка меню"
        open={open}
        onCancel={() => setOpen(false)}
        afterClose={() => {
          setDragState(null);
          setDragOverState(null);
        }}
        width={520}
        footer={() => (
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Button onClick={reset}>Сбросить по умолчанию</Button>
            <Space>
              <span style={{ color: saveError ? '#ff4d4f' : 'var(--app-text-muted)', fontSize: 12 }}>
                {saveError ? 'Ошибка сохранения' : saving ? 'Сохранение...' : 'Сохраняется автоматически'}
              </span>
              <Button onClick={() => setOpen(false)}>Закрыть</Button>
            </Space>
          </Space>
        )}
      >
        <div style={{ display: 'grid', gap: 14 }}>
          {sections.map((section) => {
            const definitionByKey = new Map(section.definitions.map((definition) => [definition.key, definition]));
            const rows = getSectionOrder(section.key)
              .map((key) => definitionByKey.get(key))
              .filter(Boolean) as SiderMenuOrderItem[];

            return (
              <section key={section.key} style={{ display: 'grid', gap: 6 }}>
                <Typography.Text strong style={{ fontSize: 13 }}>
                  {section.title}
                </Typography.Text>
                <div style={{ display: 'grid', gap: 6 }}>
                  {rows.map((definition, index) => {
                    const draggable = rows.length > 1;
                    const isDragOver = dragOverState?.sectionKey === section.key
                      && dragOverState.itemKey === definition.key;
                    const isDragging = dragState?.sectionKey === section.key
                      && dragState.itemKey === definition.key;

                    return (
                      <div
                        key={definition.key}
                        draggable={draggable}
                        onDragStart={(event) => {
                          if (!draggable) return;
                          setDragState({ sectionKey: section.key, itemKey: definition.key });
                          event.dataTransfer.effectAllowed = 'move';
                          event.dataTransfer.setData('text/plain', definition.key);
                        }}
                        onDragEnter={(event) => {
                          event.preventDefault();
                          if (dragState?.sectionKey === section.key && dragState.itemKey !== definition.key) {
                            setDragOverState({ sectionKey: section.key, itemKey: definition.key });
                          }
                        }}
                        onDragOver={(event) => {
                          event.preventDefault();
                          event.dataTransfer.dropEffect = 'move';
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          const fromKey = dragState?.sectionKey === section.key ? dragState.itemKey : null;
                          if (fromKey) moveTo(section.key, fromKey, definition.key);
                          setDragState(null);
                          setDragOverState(null);
                        }}
                        onDragEnd={() => {
                          setDragState(null);
                          setDragOverState(null);
                        }}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '24px minmax(0, 1fr) auto',
                          alignItems: 'center',
                          gap: 8,
                          padding: '6px 8px',
                          border: isDragOver ? '1px solid #1677ff' : '1px solid var(--app-border)',
                          borderRadius: 6,
                          background: 'var(--app-surface)',
                          cursor: draggable ? 'grab' : 'default',
                          opacity: isDragging ? 0.45 : 1,
                        }}
                      >
                        <Tooltip title="Перетащить пункт выше или ниже">
                          <HolderOutlined
                            aria-label="Перетащить пункт меню"
                            style={{ color: 'var(--app-text-muted)', cursor: draggable ? 'grab' : 'default' }}
                          />
                        </Tooltip>
                        <Typography.Text ellipsis={{ tooltip: definition.label }} style={{ minWidth: 0 }}>
                          {definition.label}
                        </Typography.Text>
                        <Space size={4}>
                          <Button
                            size="small"
                            icon={<ArrowUpOutlined />}
                            disabled={index === 0}
                            onClick={() => move(section.key, definition.key, -1)}
                          />
                          <Button
                            size="small"
                            icon={<ArrowDownOutlined />}
                            disabled={index === rows.length - 1}
                            onClick={() => move(section.key, definition.key, 1)}
                          />
                        </Space>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </Modal>
    </>
  );
};
