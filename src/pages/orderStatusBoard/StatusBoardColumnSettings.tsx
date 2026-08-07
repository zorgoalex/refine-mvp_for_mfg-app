import React, { useCallback, useMemo, useState } from 'react';
import { Button, Checkbox, Modal, Tooltip, message } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import type { OrderDetailColumnPreference } from '../../api/types/profileApi.types';
import type { OrderDetailColumnDefinition } from '../orders/components/tables/OrderDetailColumnSettings';

interface StatusBoardColumnSettingsButtonProps {
  boardLabel: string;
  definitions: OrderDetailColumnDefinition[];
  settings: OrderDetailColumnPreference;
  onChange: (settings: OrderDetailColumnPreference) => Promise<void>;
  extraContent?: React.ReactNode;
}

export const StatusBoardColumnSettingsButton: React.FC<
  StatusBoardColumnSettingsButtonProps
> = ({ boardLabel, definitions, settings, onChange, extraContent }) => {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const hidden = useMemo(() => new Set(settings.hidden), [settings.hidden]);
  const definitionByKey = useMemo(
    () => new Map(definitions.map((definition) => [definition.key, definition])),
    [definitions],
  );
  const rows = useMemo(
    () =>
      settings.order
        .map((key) => definitionByKey.get(key))
        .filter(Boolean) as OrderDetailColumnDefinition[],
    [definitionByKey, settings.order],
  );
  const hasHiddenColumns = settings.hidden.length > 0;
  const settingsLabel = extraContent
    ? `Настроить доску «${boardLabel}»`
    : `Настроить колонки доски «${boardLabel}»`;

  const save = useCallback(
    async (next: OrderDetailColumnPreference) => {
      setSaving(true);
      setSaveError(false);
      try {
        await onChange(next);
      } catch {
        setSaveError(true);
        message.error(`Не удалось сохранить колонки доски «${boardLabel}»`);
      } finally {
        setSaving(false);
      }
    },
    [boardLabel, onChange],
  );

  const toggleVisible = (key: string, checked: boolean) => {
    const nextHidden = new Set(settings.hidden);
    if (checked) nextHidden.delete(key);
    else nextHidden.add(key);
    void save({ ...settings, hidden: Array.from(nextHidden) });
  };

  const reset = () => {
    void save({ order: definitions.map((definition) => definition.key), hidden: [] });
  };

  return (
    <>
      <Tooltip
        title={
          hasHiddenColumns
            ? `${settingsLabel} — есть скрытые`
            : settingsLabel
        }
      >
        <Button
          className="status-board-toolbar__settings-button"
          aria-label={settingsLabel}
          icon={
            <SettingOutlined
              style={{ color: hasHiddenColumns ? '#1677ff' : undefined }}
            />
          }
          onClick={() => setOpen(true)}
        />
      </Tooltip>
      <Modal
        title={`Настройка доски «${boardLabel}»`}
        open={open}
        width={480}
        onCancel={() => setOpen(false)}
        footer={
          <div className="status-board-settings__footer">
            <Button disabled={saving || !hasHiddenColumns} onClick={reset}>
              Показать все
            </Button>
            <div className="status-board-settings__footer-end">
              <span
                className={saveError ? 'status-board-settings__save-status--error' : ''}
                aria-live="polite"
              >
                {saveError
                  ? 'Ошибка сохранения'
                  : saving
                    ? 'Сохранение…'
                    : 'Сохраняется автоматически'}
              </span>
              <Button onClick={() => setOpen(false)}>Закрыть</Button>
            </div>
          </div>
        }
      >
        <div className="status-board-settings">
          {extraContent}
          <section
            className="status-board-settings__columns"
            aria-label={`Видимость колонок доски «${boardLabel}»`}
          >
            <strong>Колонки</strong>
            <span className="status-board-settings__hint">
              Настройка применяется только для вашей учётной записи.
            </span>
            <div className="status-board-settings__column-list">
              {rows.map((definition) => (
                <Checkbox
                  key={definition.key}
                  checked={!hidden.has(definition.key)}
                  disabled={saving}
                  onChange={(event) =>
                    toggleVisible(definition.key, event.target.checked)
                  }
                >
                  {definition.label}
                </Checkbox>
              ))}
            </div>
          </section>
        </div>
      </Modal>
    </>
  );
};
