import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Form, InputNumber, Space, Spin, TimePicker, Typography, message } from 'antd';
import dayjs from 'dayjs';
import { procurementWorkspaceApi } from '../../../api/procurementWorkspaceApi';
import type { ProcurementSettings } from '../../../api/types/procurementWorkspaceApi.types';
import { ApiError } from '../../../api/apiError';
import { can } from '../../../utils/permissions';
import {
  buildProcurementSettingsUpdate,
  extractProcurementConflictSettings,
  formValuesMatchSettings,
  formatProcurementSettingsUpdatedMeta,
  hasProcurementSettingsFormErrors,
  settingsToFormValues,
  validateProcurementSettingsForm,
  type ProcurementSettingsFormValues,
} from './procurementSettingsForm';

const { Title, Paragraph } = Typography;

const LEAD_DAYS_HELP = 'Срок «нужно к» в рабочем списке снабженца = плановая дата завершения заказа минус столько рабочих дней (пн–пт).';
const WASTE_PERCENT_HELP = 'Добавляется к потребности без готового раскроя при подборе заказов и в заявках.';

/**
 * /configuration «Закупки» tab — procurement workspace settings (worklist
 * lead/critical/soon thresholds, waste% buffer, morning digest time,
 * unallocated-receipt reminder). Backend-owned via procurementWorkspaceApi
 * (`/api/v1/procurement/settings`) — GET needs procurement.view or
 * settings.manage, PUT needs settings.manage. Optimistic-concurrency
 * conflicts (409 PROCUREMENT_SETTINGS_VERSION_CONFLICT) load the current
 * settings from `error.details.settings` into the form.
 */
export const ProcurementSettingsTab: React.FC = () => {
  const canManage = can('settings.manage');
  const canView = canManage || can('procurement.view');

  const [settings, setSettings] = useState<ProcurementSettings | null>(null);
  const [values, setValues] = useState<ProcurementSettingsFormValues | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');

  const load = useCallback(async () => {
    if (!canView) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError('');
    try {
      const next = await procurementWorkspaceApi.settings();
      setSettings(next);
      setValues(settingsToFormValues(next));
    } catch (error) {
      setLoadError(apiErrorMessage(error, 'Не удалось загрузить настройки снабжения'));
    } finally {
      setLoading(false);
    }
  }, [canView]);

  useEffect(() => {
    void load();
  }, [load]);

  const setField = <K extends keyof ProcurementSettingsFormValues>(
    key: K,
    value: ProcurementSettingsFormValues[K],
  ) => {
    setValues((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const handleCancel = () => {
    if (settings) setValues(settingsToFormValues(settings));
  };

  const handleSave = async () => {
    if (!settings || !values || !canManage) return;
    const errors = validateProcurementSettingsForm(values);
    if (hasProcurementSettingsFormErrors(errors)) {
      message.error('Исправьте ошибки в форме');
      return;
    }
    setSaving(true);
    try {
      const payload = buildProcurementSettingsUpdate(values, settings.version);
      const { changed, ...updated } = await procurementWorkspaceApi.updateSettings(payload);
      setSettings(updated);
      setValues(settingsToFormValues(updated));
      message.success(changed ? 'Настройки снабжения сохранены' : 'Изменений нет');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'PROCUREMENT_SETTINGS_VERSION_CONFLICT') {
        const conflict = extractProcurementConflictSettings(error.details);
        if (conflict) {
          setSettings(conflict);
          setValues(settingsToFormValues(conflict));
        }
        message.error('Настройки уже изменил другой пользователь — показаны актуальные');
      } else {
        message.error(apiErrorMessage(error, 'Не удалось сохранить настройки снабжения'));
      }
    } finally {
      setSaving(false);
    }
  };

  if (!canView) {
    return <Alert type="error" showIcon message="Недостаточно прав для настроек снабжения" />;
  }
  // Ошибка загрузки показывается раньше спиннера: иначе при values=null она не видна (CR1-4).
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
  if (loading || !values) {
    return <Spin />;
  }

  const errors = validateProcurementSettingsForm(values);
  const dirty = Boolean(settings && !formValuesMatchSettings(values, settings));
  const readOnly = !canManage;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%', padding: '16px 0' }}>
      <Title level={4}>Закупки</Title>

      {readOnly && (
        <Alert
          type="info"
          showIcon
          message="Только просмотр: для изменения нужно право «Управление настройками» (settings.manage)"
        />
      )}

      <Card size="small" title="Рабочий список снабженца">
        <Form layout="vertical">
          <Form.Item
            label="Плановая дата наличия на складе: за сколько рабочих дней до плановой даты заказа"
            validateStatus={errors.leadDays ? 'error' : ''}
            help={errors.leadDays ?? LEAD_DAYS_HELP}
          >
            <InputNumber
              min={0}
              max={60}
              precision={0}
              value={values.leadDays}
              onChange={(v) => setField('leadDays', v == null ? null : Number(v))}
              disabled={readOnly}
              style={{ width: 220 }}
            />
          </Form.Item>

          <Space size="large" wrap align="start">
            <Form.Item
              label="Срочно: не позже чем через, дней"
              validateStatus={errors.criticalDays ? 'error' : ''}
              help={errors.criticalDays}
            >
              <InputNumber
                min={0}
                max={60}
                precision={0}
                value={values.criticalDays}
                onChange={(v) => setField('criticalDays', v == null ? null : Number(v))}
                disabled={readOnly}
                style={{ width: 220 }}
              />
            </Form.Item>

            <Form.Item
              label="Скоро: не позже чем через, дней"
              validateStatus={errors.soonDays ? 'error' : ''}
              help={errors.soonDays}
            >
              <InputNumber
                min={0}
                max={60}
                precision={0}
                value={values.soonDays}
                onChange={(v) => setField('soonDays', v == null ? null : Number(v))}
                disabled={readOnly}
                style={{ width: 220 }}
              />
            </Form.Item>
          </Space>

          <Form.Item
            label="Запас на обрезки, %"
            validateStatus={errors.wastePercent ? 'error' : ''}
            help={errors.wastePercent ?? WASTE_PERCENT_HELP}
          >
            <InputNumber
              min={0}
              max={50}
              step={0.5}
              precision={2}
              value={values.wastePercent}
              onChange={(v) => setField('wastePercent', v == null ? null : Number(v))}
              disabled={readOnly}
              style={{ width: 220 }}
              addonAfter="%"
            />
          </Form.Item>

          <Form.Item
            label="Время утренней сводки"
            validateStatus={errors.digestTime ? 'error' : ''}
            help={errors.digestTime}
          >
            <TimePicker
              format="HH:mm"
              minuteStep={5}
              value={values.digestTime && /^\d{2}:\d{2}$/.test(values.digestTime) ? dayjs(values.digestTime, 'HH:mm') : null}
              onChange={(value) => setField('digestTime', value ? value.format('HH:mm') : '')}
              disabled={readOnly}
              style={{ width: 220 }}
              allowClear={false}
            />
          </Form.Item>

          <Form.Item
            label="Приход не распределён — напомнить через, дней"
            validateStatus={errors.unallocatedAlertDays ? 'error' : ''}
            help={errors.unallocatedAlertDays}
          >
            <InputNumber
              min={1}
              max={30}
              precision={0}
              value={values.unallocatedAlertDays}
              onChange={(v) => setField('unallocatedAlertDays', v == null ? null : Number(v))}
              disabled={readOnly}
              style={{ width: 220 }}
            />
          </Form.Item>

          <Form.Item
            label="Рабочий список: просроченные заказы не старше, дней"
            validateStatus={errors.overdueWindowDays ? 'error' : ''}
            help={errors.overdueWindowDays ?? 'Более старые незакрытые заказы находятся поиском или фильтром «Наличие на складе: с».'}
          >
            <InputNumber
              min={1}
              max={365}
              precision={0}
              value={values.overdueWindowDays}
              onChange={(v) => setField('overdueWindowDays', v == null ? null : Number(v))}
              disabled={readOnly}
              style={{ width: 220 }}
            />
          </Form.Item>

          {settings && (
            <Paragraph type="secondary" style={{ marginBottom: 16 }}>
              {formatProcurementSettingsUpdatedMeta(settings)}
            </Paragraph>
          )}

          {!readOnly && (
            <Space>
              <Button
                type="primary"
                loading={saving}
                disabled={!dirty || saving || hasProcurementSettingsFormErrors(errors)}
                onClick={() => void handleSave()}
              >
                Сохранить
              </Button>
              <Button disabled={!dirty || saving} onClick={handleCancel}>
                Отменить изменения
              </Button>
            </Space>
          )}
        </Form>
      </Card>
      <Alert type="info" showIcon message="Шаблоны текста поставщику — в экране снабжения: заявка поставщику → «Текст для поставщика» → «Мои шаблоны…». У каждого пользователя свои шаблоны." />
    </Space>
  );
};

function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return fallback;
}

export default ProcurementSettingsTab;
