import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Checkbox, Space, Spin, Switch, Typography, message } from 'antd';
import { clientScreenSettingsApi, type ClientScreenSettings } from '../../../api/clientScreenSettingsApi';
import { ApiError } from '../../../api/apiError';
import { can } from '../../../utils/permissions';
import { CLIENT_SCREEN_ALWAYS_WITH_TAB, CLIENT_SCREEN_GROUPS } from '../../clientScreen/clientScreenRegistry';
import {
  extractConflictSettings,
  formFromSettings,
  isDirty,
  setDefaults,
  setEnabled,
  showAll,
  toPayload,
  toggleCode,
  type ClientScreenFormState,
} from './clientScreenSettingsForm';

const { Title, Paragraph, Text } = Typography;

/**
 * /configuration «Экран клиента» tab — organisation-wide switch and the set of order
 * tabs/fields a customer may see on the customer screen. Backend-owned
 * (`/api/v1/client-screen/settings`): GET needs orders.view or settings.manage, PUT needs
 * settings.manage. A 409 CLIENT_SCREEN_SETTINGS_VERSION_CONFLICT carries the current
 * settings in `error.details.settings`.
 */
export const ClientScreenSettingsTab: React.FC = () => {
  const canManage = can('settings.manage');

  const [settings, setSettings] = useState<ClientScreenSettings | null>(null);
  const [form, setForm] = useState<ClientScreenFormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const next = await clientScreenSettingsApi.get();
      setSettings(next);
      setForm(formFromSettings(next));
    } catch (error) {
      setLoadError(apiErrorMessage(error, 'Не удалось загрузить настройки экрана клиента'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async () => {
    if (!settings || !form || !canManage) return;
    setSaving(true);
    try {
      const { changed: _changed, ...updated } = await clientScreenSettingsApi.update(toPayload(form, settings.version));
      setSettings(updated);
      setForm(formFromSettings(updated));
      message.success('Настройки экрана клиента сохранены');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CLIENT_SCREEN_SETTINGS_VERSION_CONFLICT') {
        const conflict = extractConflictSettings(error.details);
        if (conflict) {
          setSettings(conflict);
          setForm(formFromSettings(conflict));
        }
        message.warning('Настройки уже изменил другой пользователь. Показаны актуальные');
      } else {
        message.error(apiErrorMessage(error, 'Не удалось сохранить настройки экрана клиента'));
      }
    } finally {
      setSaving(false);
    }
  };

  if (loadError && !loading) {
    return (
      <Alert
        type="error"
        showIcon
        message={loadError}
        action={
          <Button size="small" onClick={() => void load()}>
            Повторить
          </Button>
        }
      />
    );
  }
  if (loading || !form || !settings) {
    return <Spin />;
  }

  const readOnly = !canManage;
  const dirty = isDirty(form, settings);
  const selected = new Set<string>(form.codes);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%', padding: '16px 0' }}>
      <Title level={4}>Экран клиента</Title>

      {readOnly && (
        <Alert
          type="info"
          showIcon
          message="Только просмотр: для изменения нужно право «Управление настройками» (settings.manage)"
        />
      )}

      <Card size="small">
        <Space align="center">
          <Switch
            checked={form.enabled}
            onChange={(checked) => setForm((prev) => (prev ? setEnabled(prev, checked) : prev))}
            disabled={readOnly || saving}
          />
          <Text strong>Экран клиента включён</Text>
        </Space>
        <Paragraph type="secondary" style={{ margin: '8px 0 0' }}>
          Выключатель действует на всю организацию: идущие показы гаснут в течение минуты
        </Paragraph>
      </Card>

      {CLIENT_SCREEN_GROUPS.map((group) => {
        const tabOn = group.tabCode ? selected.has(group.tabCode) : true;
        const ticked = group.fields.filter((field) => selected.has(field.code)).length;
        return (
          <Card
            key={group.key}
            size="small"
            title={
              group.tabCode ? (
                <Checkbox
                  checked={tabOn}
                  disabled={readOnly || saving}
                  onChange={(event) =>
                    setForm((prev) => (prev && group.tabCode ? toggleCode(prev, group.tabCode, event.target.checked) : prev))
                  }
                >
                  Вкладка «{group.label}»
                </Checkbox>
              ) : (
                group.label
              )
            }
            extra={group.whole ? null : <Text type="secondary">{ticked} из {group.fields.length}</Text>}
          >
            {group.whole ? (
              <Text type="secondary">
                Вкладка показывается клиенту целиком, как у менеджера: всё, что на ней видно, включая суммы и имена. Отдельных галочек для полей нет
              </Text>
            ) : null}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                gap: '8px 16px',
                opacity: tabOn ? 1 : 0.5,
              }}
            >
              {group.fields.map((field) => (
                <Checkbox
                  key={field.code}
                  checked={CLIENT_SCREEN_ALWAYS_WITH_TAB.has(field.code) ? tabOn : selected.has(field.code)}
                  disabled={readOnly || saving || !tabOn || CLIENT_SCREEN_ALWAYS_WITH_TAB.has(field.code)}
                  onChange={(event) => setForm((prev) => (prev ? toggleCode(prev, field.code, event.target.checked) : prev))}
                >
                  {field.label}{CLIENT_SCREEN_ALWAYS_WITH_TAB.has(field.code) ? ' (показывается всегда)' : ''}
                </Checkbox>
              ))}
            </div>
          </Card>
        );
      })}

      {!readOnly && (
        <Space wrap>
          <Button type="primary" loading={saving} disabled={!dirty || saving} onClick={() => void handleSave()}>
            Сохранить
          </Button>
          <Button disabled={saving} onClick={() => setForm((prev) => (prev ? setDefaults(prev) : prev))}>
            Вернуть по умолчанию
          </Button>
          <Button disabled={saving} onClick={() => setForm((prev) => (prev ? showAll(prev) : prev))}>
            Показать всё
          </Button>
        </Space>
      )}
    </Space>
  );
};

function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return fallback;
}

export default ClientScreenSettingsTab;
