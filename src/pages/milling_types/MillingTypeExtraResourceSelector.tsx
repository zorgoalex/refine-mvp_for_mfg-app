import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Input, InputNumber, Select, Space, Switch, Typography, message } from 'antd';
import { ApiError } from '../../api/apiError';
import {
  productionTechSettingsApi,
  type ExtraResourceDto,
  type HdfMillingSettingsDto,
  type MillingExtraResourceDto,
} from '../../api/productionTechSettingsApi';
import { can } from '../../utils/permissions';

const { Text } = Typography;

interface MillingTypeExtraResourceSelectorProps {
  millingTypeId?: number | null;
  readOnly?: boolean;
}

export function MillingTypeExtraResourceSelector({
  millingTypeId,
  readOnly = false,
}: MillingTypeExtraResourceSelectorProps) {
  const canManage = !readOnly && can('settings.manage');
  const canView = can('settings.view') || can('settings.manage');
  const [milling, setMilling] = useState<HdfMillingSettingsDto | null>(null);
  const [resources, setResources] = useState<ExtraResourceDto[]>([]);
  const [selectedResourceId, setSelectedResourceId] = useState<number | null>(null);
  const [parameterName, setParameterName] = useState('');
  const [parameterMm, setParameterMm] = useState<number | null>(null);
  const [hdfAutoEnabled, setHdfAutoEnabled] = useState(false);
  const [currentLink, setCurrentLink] = useState<MillingExtraResourceDto | null>(null);
  const [loading, setLoading] = useState(canView);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!canView || !millingTypeId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const settings = await productionTechSettingsApi.getHdf();
      const nextMilling = settings.millingTypes.find((item) => item.millingTypeId === millingTypeId) ?? null;
      const link = nextMilling?.extraResources.find((resource) => resource.isActive) ?? null;
      setMilling(nextMilling);
      setResources(settings.extraResources ?? []);
      setCurrentLink(link);
      setSelectedResourceId(link?.extraResourceId ?? null);
      setParameterName(link?.parameterName ?? '');
      setParameterMm(link?.parameterMm ?? null);
      setHdfAutoEnabled(link?.hdfAutoEnabled ?? false);
    } catch (error) {
      message.error(apiErrorMessage(error, 'Не удалось загрузить доп. ресурс фрезеровки'));
    } finally {
      setLoading(false);
    }
  }, [canView, millingTypeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const resourceOptions = useMemo(
    () => resources
      .filter((resource) => resource.isActive || resource.id === selectedResourceId)
      .map((resource) => ({
        label: resource.isActive ? resource.resourceName : `${resource.resourceName} (неактивный)`,
        value: resource.id,
        disabled: !resource.isActive && resource.id !== selectedResourceId,
      })),
    [resources, selectedResourceId],
  );

  const selectedResource = resources.find((resource) => resource.id === selectedResourceId) ?? null;

  const handleSelectResource = (value: number | undefined) => {
    const resource = resources.find((item) => item.id === value) ?? null;
    setSelectedResourceId(resource?.id ?? null);
    setParameterName(resource?.defaultParameterName ?? '');
    setParameterMm(resource?.defaultParameterMm ?? null);
    setHdfAutoEnabled(resource?.hdfAutoDefault ?? false);
  };

  const save = async () => {
    if (!milling || !millingTypeId) return;
    if (selectedResourceId && hdfAutoEnabled && (parameterMm == null || parameterMm <= 0)) {
      message.error('Для авто ХДФ укажите параметр больше 0');
      return;
    }
    const selected = resources.find((resource) => resource.id === selectedResourceId) ?? null;
    setSaving(true);
    try {
      await productionTechSettingsApi.updateHdfMilling(millingTypeId, {
        hdfEnabled: Boolean(selected && hdfAutoEnabled),
        hdfEdgeMm: selected && hdfAutoEnabled ? parameterMm : null,
        hdfParameterName: selected && hdfAutoEnabled ? parameterName : null,
        extraResources: selected ? [{
          ...(currentLink?.id ? { id: currentLink.id, version: currentLink.version } : {}),
          extraResourceId: selected.id,
          resourceKind: selected.resourceKind,
          resourceRefType: selected.resourceRefType,
          resourceRefId: selected.resourceRefId,
          resourceName: selected.resourceName,
          unitId: selected.unitId,
          accountingMethod: selected.accountingMethod,
          parameterName,
          parameterMm,
          hdfAutoEnabled,
          comment: currentLink?.comment ?? '',
          isActive: true,
          sortOrder: currentLink?.sortOrder ?? 100,
        }] : [],
        expectedVersion: milling.version,
      });
      await load();
      message.success('Доп. ресурс фрезеровки сохранен');
    } catch (error) {
      message.error(apiErrorMessage(error, 'Не удалось сохранить доп. ресурс фрезеровки'));
    } finally {
      setSaving(false);
    }
  };

  const changed = milling ? (
    (currentLink?.extraResourceId ?? null) !== selectedResourceId
    || (currentLink?.parameterName ?? '') !== parameterName.trim()
    || (currentLink?.parameterMm ?? null) !== parameterMm
    || (currentLink?.hdfAutoEnabled ?? false) !== hdfAutoEnabled
  ) : false;

  if (!canView) return null;
  if (!loading && !milling) {
    return <Alert type="warning" showIcon message="Тип фрезеровки не найден" />;
  }

  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Space wrap align="end">
        <div>
          <Text strong>Дополнительный ресурс</Text>
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="Выберите доп. ресурс"
            value={selectedResourceId ?? undefined}
            options={resourceOptions}
            disabled={!canManage || loading}
            loading={loading}
            style={{ display: 'block', width: 320, marginTop: 8 }}
            onChange={handleSelectResource}
          />
        </div>
        <div>
          <Text strong>Параметр</Text>
          <Input
            value={parameterName}
            disabled={!canManage || !selectedResourceId}
            style={{ display: 'block', width: 180, marginTop: 8 }}
            onChange={(event) => setParameterName(event.target.value)}
          />
        </div>
        <div>
          <Text strong>Значение, мм</Text>
          <InputNumber
            min={0.1}
            step={0.5}
            precision={1}
            value={parameterMm}
            disabled={!canManage || !selectedResourceId}
            style={{ display: 'block', width: 130, marginTop: 8 }}
            onChange={(value) => setParameterMm(value == null ? null : Number(value))}
          />
        </div>
        <Space size={6} style={{ paddingBottom: 4 }}>
          <Switch
            checked={hdfAutoEnabled}
            disabled={!canManage || !selectedResourceId}
            onChange={setHdfAutoEnabled}
          />
          <Text>Авто ХДФ</Text>
        </Space>
        {!readOnly ? (
          <Button
            type="primary"
            disabled={!canManage || loading || !changed}
            loading={saving}
            onClick={() => void save()}
          >
            Сохранить
          </Button>
        ) : null}
      </Space>
      {selectedResource ? (
        <Text type="secondary">
          {selectedResource.accountingMethod || 'Метод учета не задан'}
        </Text>
      ) : null}
    </Space>
  );
}

function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return `${error.message}. Обновите данные и повторите сохранение.`;
    return error.message;
  }
  return fallback;
}
