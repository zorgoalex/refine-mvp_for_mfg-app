import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Table } from '../../../ui/tooltipDelay';
import { Alert, Button, Card, Input, InputNumber, Select, Space, Switch, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useList } from '@refinedev/core';
import { ApiError } from '../../../api/apiError';
import {
  productionTechSettingsApi,
  type HdfMillingSettingsDto,
  type HdfProductionTechSettingsDto,
  type MillingExtraResourceDto,
  type UpdateMillingExtraResourceRequest,
} from '../../../api/productionTechSettingsApi';
import { can } from '../../../utils/permissions';

const { Text } = Typography;

interface SheetMaterialOption {
  sheet_material_type_id: number;
  name: string;
  is_active?: boolean;
  sort_order?: number | null;
}

interface UnitOption {
  unit_id: number;
  unit_code: string;
  unit_name?: string | null;
  unit_symbol?: string | null;
  sort_order?: number | null;
}

interface MillingResourceDraft {
  clientKey: string;
  id?: number;
  version?: number;
  resourceKind: string;
  resourceRefType: string | null;
  resourceRefId: number | null;
  resourceName: string;
  unitId: number | null;
  accountingMethod: string;
  parameterName: string;
  parameterMm: number | null;
  hdfAutoEnabled: boolean;
  comment: string;
  isActive: boolean;
  sortOrder: number;
}

interface MillingDraft {
  extraResources: MillingResourceDraft[];
}

const RESOURCE_KIND_OPTIONS = [
  { label: 'Листовой материал', value: 'sheet_material' },
  { label: 'Шпон', value: 'veneer' },
  { label: 'Краска', value: 'paint' },
  { label: 'Замазка', value: 'putty' },
  { label: 'Другое', value: 'other' },
];

const DEFAULT_HDF_PARAMETER_NAME = 'Параметр';
const DEFAULT_HDF_ACCOUNTING_METHOD = 'Автоматический расчет ХДФ-детали';

export function ProductionThresholdsConfigTab() {
  const canManage = can('settings.manage');
  const canViewSheetMaterials = can('sheet_materials.view');
  const canViewUnits = can('references.view') || canManage;
  const [settings, setSettings] = useState<HdfProductionTechSettingsDto | null>(null);
  const [thresholdDraft, setThresholdDraft] = useState<number | null>(null);
  const [materialDraft, setMaterialDraft] = useState<number | null>(null);
  const [millingDrafts, setMillingDrafts] = useState<Record<number, MillingDraft>>({});
  const [loading, setLoading] = useState(true);
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [savingMillingId, setSavingMillingId] = useState<number | null>(null);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const next = await productionTechSettingsApi.getHdf();
      setSettings(next);
      setThresholdDraft(next.minSideThresholdMm);
      setMaterialDraft(next.sheetMaterialTypeId);
      setMillingDrafts(Object.fromEntries(next.millingTypes.map((milling) => [
        milling.millingTypeId,
        makeMillingDraft(milling),
      ])));
    } catch (error) {
      message.error(apiErrorMessage(error, 'Не удалось загрузить настройки ХДФ'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const { data: sheetMaterialsData, isLoading: sheetMaterialsLoading } = useList<SheetMaterialOption>({
    resource: 'sheet_material_types',
    pagination: { mode: 'off' },
    filters: [{ field: 'is_active', operator: 'in', value: [true, false] }],
    sorters: [
      { field: 'sort_order', order: 'asc' },
      { field: 'name', order: 'asc' },
      { field: 'sheet_material_type_id', order: 'asc' },
    ],
    meta: { fields: ['sheet_material_type_id', 'name', 'is_active', 'sort_order'] },
    queryOptions: { enabled: canViewSheetMaterials },
  });

  const { data: unitsData, isLoading: unitsLoading } = useList<UnitOption>({
    resource: 'units',
    pagination: { mode: 'off' },
    sorters: [
      { field: 'sort_order', order: 'asc' },
      { field: 'unit_name', order: 'asc' },
      { field: 'unit_id', order: 'asc' },
    ],
    meta: { fields: ['unit_id', 'unit_code', 'unit_name', 'unit_symbol', 'sort_order'] },
    queryOptions: { enabled: canViewUnits },
  });

  const sheetMaterialOptions = useMemo(
    () => (sheetMaterialsData?.data ?? []).map((item) => ({
      label: item.is_active === false ? `${item.name} (неактивный)` : item.name,
      value: item.sheet_material_type_id,
      disabled: item.is_active === false && item.sheet_material_type_id !== settings?.sheetMaterialTypeId,
    })),
    [settings?.sheetMaterialTypeId, sheetMaterialsData?.data],
  );

  const unitOptions = useMemo(
    () => (unitsData?.data ?? []).map((item) => ({
      label: item.unit_symbol || item.unit_name || item.unit_code,
      value: item.unit_id,
    })),
    [unitsData?.data],
  );

  const handleSaveGlobal = async () => {
    if (!settings) return;
    const normalizedThreshold = thresholdDraft == null ? null : Number(thresholdDraft);
    if (normalizedThreshold == null || !Number.isFinite(normalizedThreshold) || normalizedThreshold <= 0) {
      message.error('Укажите минимальный порог ХДФ больше 0');
      return;
    }
    const body: {
      minSideThresholdMm?: number;
      minSideThresholdVersion?: number;
      sheetMaterialTypeId?: number | null;
      sheetMaterialVersion?: number;
    } = {};
    if (normalizedThreshold !== settings.minSideThresholdMm) {
      body.minSideThresholdMm = normalizedThreshold;
      if (settings.minSideThresholdVersion != null) body.minSideThresholdVersion = settings.minSideThresholdVersion;
    }
    if ((materialDraft ?? null) !== (settings.sheetMaterialTypeId ?? null)) {
      body.sheetMaterialTypeId = materialDraft ?? null;
      if (settings.sheetMaterialVersion != null) body.sheetMaterialVersion = settings.sheetMaterialVersion;
    }
    if (Object.keys(body).length === 0) {
      message.info('Изменений нет');
      return;
    }
    setSavingGlobal(true);
    try {
      const next = await productionTechSettingsApi.updateHdf(body);
      setSettings(next);
      setThresholdDraft(next.minSideThresholdMm);
      setMaterialDraft(next.sheetMaterialTypeId);
      message.success('Настройки ХДФ сохранены');
    } catch (error) {
      message.error(apiErrorMessage(error, 'Не удалось сохранить настройки ХДФ'));
    } finally {
      setSavingGlobal(false);
    }
  };

  const handleSaveMilling = async (row: HdfMillingSettingsDto) => {
    const draft = millingDrafts[row.millingTypeId];
    if (!draft) return;
    const normalized = normalizeDraftResources(draft.extraResources);
    if (normalized.error) {
      message.error(normalized.error);
      return;
    }
    const resources = normalized.resources;
    const hdfResource = resources.find((resource) => resource.isActive !== false && resource.hdfAutoEnabled === true) ?? null;
    if (hdfResource && (hdfResource.parameterMm == null || hdfResource.parameterMm <= 0)) {
      message.error('Для авто ХДФ укажите параметр больше 0');
      return;
    }
    setSavingMillingId(row.millingTypeId);
    try {
      await productionTechSettingsApi.updateHdfMilling(row.millingTypeId, {
        hdfEnabled: hdfResource !== null,
        hdfEdgeMm: hdfResource?.parameterMm ?? null,
        hdfParameterName: hdfResource?.parameterName ?? null,
        extraResources: resources,
        expectedVersion: row.version,
      });
      await loadSettings();
      message.success('Фрезеровка сохранена');
    } catch (error) {
      message.error(apiErrorMessage(error, 'Не удалось сохранить фрезеровку'));
    } finally {
      setSavingMillingId(null);
    }
  };

  const updateResourceDraft = (
    millingTypeId: number,
    clientKey: string,
    patch: Partial<MillingResourceDraft>,
  ) => {
    setMillingDrafts((current) => {
      const currentDraft = current[millingTypeId] ?? { extraResources: [] };
      const nextResources = currentDraft.extraResources.map((resource) => {
        if (resource.clientKey !== clientKey) {
          return patch.hdfAutoEnabled === true ? { ...resource, hdfAutoEnabled: false } : resource;
        }
        const next = { ...resource, ...patch };
        if (patch.hdfAutoEnabled === true) {
          return {
            ...next,
            resourceKind: next.resourceKind || 'sheet_material',
            resourceName: next.resourceName || 'ХДФ',
            accountingMethod: next.accountingMethod || DEFAULT_HDF_ACCOUNTING_METHOD,
            parameterName: next.parameterName || DEFAULT_HDF_PARAMETER_NAME,
            isActive: true,
          };
        }
        return next;
      });
      return { ...current, [millingTypeId]: { extraResources: nextResources } };
    });
  };

  const addResourceDraft = (millingTypeId: number) => {
    setMillingDrafts((current) => {
      const currentDraft = current[millingTypeId] ?? { extraResources: [] };
      const maxSortOrder = Math.max(90, ...currentDraft.extraResources.map((resource) => resource.sortOrder));
      return {
        ...current,
        [millingTypeId]: {
          extraResources: [
            ...currentDraft.extraResources,
            createEmptyResourceDraft(millingTypeId, maxSortOrder + 10),
          ],
        },
      };
    });
  };

  const removeResourceDraft = (millingTypeId: number, clientKey: string) => {
    setMillingDrafts((current) => {
      const currentDraft = current[millingTypeId] ?? { extraResources: [] };
      return {
        ...current,
        [millingTypeId]: {
          extraResources: currentDraft.extraResources
            .map((resource) => (resource.clientKey === clientKey && resource.id ? { ...resource, isActive: false } : resource))
            .filter((resource) => resource.clientKey !== clientKey || resource.id),
        },
      };
    });
  };

  const renderResourcesEditor = (row: HdfMillingSettingsDto) => {
    const draft = millingDrafts[row.millingTypeId] ?? makeMillingDraft(row);
    return (
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {draft.extraResources.length === 0 ? (
          <Text type="secondary">Доп. ресурсы не заданы</Text>
        ) : null}
        {draft.extraResources.map((resource) => (
          <div
            key={resource.clientKey}
            style={{
              display: 'grid',
              gridTemplateColumns: '150px minmax(170px, 1fr) 110px minmax(180px, 1fr) 150px 110px 104px 104px 84px',
              gap: 8,
              alignItems: 'center',
              padding: '8px 0',
              borderBottom: '1px solid #f0f0f0',
            }}
          >
            <Select
              size="small"
              options={RESOURCE_KIND_OPTIONS}
              value={resource.resourceKind}
              disabled={!canManage}
              onChange={(value) => updateResourceDraft(row.millingTypeId, resource.clientKey, { resourceKind: value })}
            />
            <Input
              size="small"
              placeholder="Ресурс / название"
              value={resource.resourceName}
              disabled={!canManage}
              onChange={(event) => updateResourceDraft(row.millingTypeId, resource.clientKey, { resourceName: event.target.value })}
            />
            <Select
              allowClear
              size="small"
              placeholder="Ед."
              options={unitOptions}
              value={resource.unitId ?? undefined}
              disabled={!canManage || !canViewUnits}
              loading={unitsLoading}
              onChange={(value) => updateResourceDraft(row.millingTypeId, resource.clientKey, { unitId: value ?? null })}
            />
            <Input
              size="small"
              placeholder="Метод учета"
              value={resource.accountingMethod}
              disabled={!canManage}
              onChange={(event) => updateResourceDraft(row.millingTypeId, resource.clientKey, { accountingMethod: event.target.value })}
            />
            <Input
              size="small"
              placeholder="Название параметра"
              value={resource.parameterName}
              disabled={!canManage}
              onChange={(event) => updateResourceDraft(row.millingTypeId, resource.clientKey, { parameterName: event.target.value })}
            />
            <InputNumber
              size="small"
              min={0.1}
              step={0.5}
              precision={1}
              placeholder="Парам., мм"
              value={resource.parameterMm}
              disabled={!canManage}
              style={{ width: '100%' }}
              onChange={(value) => updateResourceDraft(row.millingTypeId, resource.clientKey, { parameterMm: value == null ? null : Number(value) })}
            />
            <Space size={6}>
              <Switch
                size="small"
                checked={resource.hdfAutoEnabled}
                disabled={!canManage}
                onChange={(checked) => updateResourceDraft(row.millingTypeId, resource.clientKey, { hdfAutoEnabled: checked })}
              />
              <Text>Авто ХДФ</Text>
            </Space>
            <Space size={6}>
              <Switch
                size="small"
                checked={resource.isActive}
                disabled={!canManage}
                onChange={(checked) => updateResourceDraft(row.millingTypeId, resource.clientKey, { isActive: checked })}
              />
              <Text>Активно</Text>
            </Space>
            <Button
              size="small"
              disabled={!canManage}
              onClick={() => removeResourceDraft(row.millingTypeId, resource.clientKey)}
            >
              Убрать
            </Button>
            <Input
              size="small"
              placeholder="Комментарий"
              value={resource.comment}
              disabled={!canManage}
              style={{ gridColumn: '1 / -1' }}
              onChange={(event) => updateResourceDraft(row.millingTypeId, resource.clientKey, { comment: event.target.value })}
            />
          </div>
        ))}
        <Button size="small" disabled={!canManage} onClick={() => addResourceDraft(row.millingTypeId)}>
          Добавить ресурс
        </Button>
      </Space>
    );
  };

  const columns: ColumnsType<HdfMillingSettingsDto> = [
    {
      title: 'Фрезеровка',
      dataIndex: 'name',
      key: 'name',
      width: 240,
      render: (value: string, row: HdfMillingSettingsDto) => (
        <Space direction="vertical" size={4}>
          <Text>{value}</Text>
          <Space size={6} wrap>
            {row.isActive ? null : <Tag>Неактивна</Tag>}
            {row.hdfEnabled ? <Tag color="blue">ХДФ {row.hdfEdgeMm ?? '—'} мм</Tag> : null}
          </Space>
        </Space>
      ),
    },
    {
      title: 'Доп. ресурсы',
      key: 'extraResources',
      render: (_: unknown, row: HdfMillingSettingsDto) => renderResourcesEditor(row),
    },
    {
      title: '',
      key: 'actions',
      width: 120,
      render: (_: unknown, row: HdfMillingSettingsDto) => (
        <Button
          size="small"
          type="primary"
          disabled={!canManage || !isMillingChanged(row, millingDrafts[row.millingTypeId])}
          loading={savingMillingId === row.millingTypeId}
          onClick={() => void handleSaveMilling(row)}
        >
          Сохранить
        </Button>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%', padding: '16px 0' }}>
      <Alert
        type="info"
        showIcon
        message="Пороги техпроцессов производства"
        description="ХДФ рассчитывается автоматически через активный доп. ресурс с флагом авто ХДФ. Минимальная сторона остаётся общей настройкой техпроцесса."
      />

      <Card size="small" title="ХДФ">
        <Space wrap size="middle" align="end">
          <div>
            <Text strong>Минимальная сторона, мм</Text>
            <InputNumber
              min={0.1}
              step={0.5}
              precision={1}
              value={thresholdDraft}
              disabled={!canManage}
              style={{ display: 'block', width: 180, marginTop: 8 }}
              onChange={(value) => setThresholdDraft(value == null ? null : Number(value))}
            />
          </div>
          <div>
            <Text strong>Листовой материал ХДФ</Text>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder={canViewSheetMaterials ? 'Выберите материал' : 'Нет доступа к материалам'}
              value={materialDraft ?? undefined}
              options={sheetMaterialOptions}
              disabled={!canManage || !canViewSheetMaterials}
              loading={loading || sheetMaterialsLoading}
              style={{ display: 'block', width: 320, marginTop: 8 }}
              onChange={(value) => setMaterialDraft(value ?? null)}
            />
          </div>
          <Button
            type="primary"
            onClick={() => void handleSaveGlobal()}
            loading={savingGlobal}
            disabled={!canManage || loading}
          >
            Сохранить
          </Button>
          {settings ? <Text type="secondary">Ревизия: {settings.configRevision}</Text> : null}
        </Space>
      </Card>

      <Card size="small" title="Доп. ресурсы фрезеровок">
        <Table<HdfMillingSettingsDto>
          rowKey="millingTypeId"
          loading={loading}
          dataSource={settings?.millingTypes ?? []}
          columns={columns}
          pagination={false}
          size="small"
          scroll={{ x: 1280 }}
        />
      </Card>
    </Space>
  );
}

function makeMillingDraft(row: HdfMillingSettingsDto): MillingDraft {
  const resources = row.extraResources?.length
    ? row.extraResources.map(resourceDtoToDraft)
    : row.hdfEnabled
      ? [createLegacyHdfResourceDraft(row)]
      : [];
  return { extraResources: resources };
}

function resourceDtoToDraft(resource: MillingExtraResourceDto): MillingResourceDraft {
  return {
    clientKey: `id:${resource.id}`,
    id: resource.id,
    version: resource.version,
    resourceKind: resource.resourceKind || 'other',
    resourceRefType: resource.resourceRefType,
    resourceRefId: resource.resourceRefId,
    resourceName: resource.resourceName,
    unitId: resource.unitId,
    accountingMethod: resource.accountingMethod,
    parameterName: resource.parameterName,
    parameterMm: resource.parameterMm,
    hdfAutoEnabled: resource.hdfAutoEnabled,
    comment: resource.comment,
    isActive: resource.isActive,
    sortOrder: resource.sortOrder,
  };
}

function createLegacyHdfResourceDraft(row: HdfMillingSettingsDto): MillingResourceDraft {
  return {
    clientKey: `legacy-hdf:${row.millingTypeId}`,
    resourceKind: 'sheet_material',
    resourceRefType: null,
    resourceRefId: null,
    resourceName: 'ХДФ',
    unitId: null,
    accountingMethod: DEFAULT_HDF_ACCOUNTING_METHOD,
    parameterName: row.hdfParameterName || DEFAULT_HDF_PARAMETER_NAME,
    parameterMm: row.hdfEdgeMm,
    hdfAutoEnabled: true,
    comment: '',
    isActive: true,
    sortOrder: 100,
  };
}

function createEmptyResourceDraft(millingTypeId: number, sortOrder: number): MillingResourceDraft {
  return {
    clientKey: `new:${millingTypeId}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
    resourceKind: 'other',
    resourceRefType: null,
    resourceRefId: null,
    resourceName: '',
    unitId: null,
    accountingMethod: '',
    parameterName: '',
    parameterMm: null,
    hdfAutoEnabled: false,
    comment: '',
    isActive: true,
    sortOrder,
  };
}

function normalizeDraftResources(resources: MillingResourceDraft[]): { resources: UpdateMillingExtraResourceRequest[]; error?: string } {
  const normalized: UpdateMillingExtraResourceRequest[] = [];
  for (const [index, resource] of resources.entries()) {
    const resourceName = textOrEmpty(resource.resourceName);
    const hasContent = Boolean(resource.id || resourceName || resource.hdfAutoEnabled || resource.accountingMethod || resource.parameterName || resource.comment);
    if (!hasContent) continue;
    const resourceKind = textOrEmpty(resource.resourceKind);
    if (!resourceKind) return { resources: [], error: `Ресурс ${index + 1}: укажите тип ресурса` };
    if (!resourceName) return { resources: [], error: `Ресурс ${index + 1}: укажите название` };
    const parameterMm = resource.parameterMm == null ? null : Number(resource.parameterMm);
    if (parameterMm !== null && (!Number.isFinite(parameterMm) || parameterMm <= 0)) {
      return { resources: [], error: `Ресурс ${index + 1}: параметр должен быть больше 0` };
    }
    if (resource.isActive !== false && resource.hdfAutoEnabled && parameterMm === null) {
      return { resources: [], error: `Ресурс ${index + 1}: для авто ХДФ укажите параметр` };
    }
    normalized.push({
      ...(resource.id ? { id: resource.id } : {}),
      ...(resource.version ? { version: resource.version } : {}),
      resourceKind,
      resourceRefType: resource.resourceRefType ?? null,
      resourceRefId: resource.resourceRefId ?? null,
      resourceName,
      unitId: resource.unitId ?? null,
      accountingMethod: textOrEmpty(resource.accountingMethod),
      parameterName: textOrEmpty(resource.parameterName),
      parameterMm,
      hdfAutoEnabled: resource.hdfAutoEnabled,
      comment: textOrEmpty(resource.comment),
      isActive: resource.isActive,
      sortOrder: Number.isFinite(resource.sortOrder) ? resource.sortOrder : 100 + index,
    });
  }
  return { resources: normalized };
}

function isMillingChanged(row: HdfMillingSettingsDto, draft: MillingDraft | undefined): boolean {
  if (!draft) return false;
  return JSON.stringify(compareDraft(draft)) !== JSON.stringify(compareDraft(makeMillingDraft(row)));
}

function compareDraft(draft: MillingDraft) {
  return draft.extraResources.map((resource, index) => ({
    id: resource.id ?? null,
    resourceKind: textOrEmpty(resource.resourceKind),
    resourceRefType: resource.resourceRefType ?? null,
    resourceRefId: resource.resourceRefId ?? null,
    resourceName: textOrEmpty(resource.resourceName),
    unitId: resource.unitId ?? null,
    accountingMethod: textOrEmpty(resource.accountingMethod),
    parameterName: textOrEmpty(resource.parameterName),
    parameterMm: resource.parameterMm ?? null,
    hdfAutoEnabled: resource.hdfAutoEnabled,
    comment: textOrEmpty(resource.comment),
    isActive: resource.isActive,
    sortOrder: Number.isFinite(resource.sortOrder) ? resource.sortOrder : 100 + index,
  }));
}

function textOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return `${error.message}. Обновите данные и повторите сохранение.`;
    return error.message;
  }
  return fallback;
}
