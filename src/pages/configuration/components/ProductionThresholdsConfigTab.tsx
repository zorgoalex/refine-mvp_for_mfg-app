import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Table } from '../../../ui/tooltipDelay';
import { Alert, Button, Card, InputNumber, Select, Space, Switch, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useList } from '@refinedev/core';
import { ApiError } from '../../../api/apiError';
import {
  productionTechSettingsApi,
  type HdfMillingSettingsDto,
  type HdfProductionTechSettingsDto,
} from '../../../api/productionTechSettingsApi';
import { can } from '../../../utils/permissions';

const { Text } = Typography;

interface SheetMaterialOption {
  sheet_material_type_id: number;
  name: string;
  is_active?: boolean;
  sort_order?: number | null;
}

interface MillingDraft {
  hdfEnabled: boolean;
  hdfEdgeMm: number | null;
}

export function ProductionThresholdsConfigTab() {
  const canManage = can('settings.manage');
  const canViewSheetMaterials = can('sheet_materials.view');
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
        { hdfEnabled: milling.hdfEnabled, hdfEdgeMm: milling.hdfEdgeMm },
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

  const sheetMaterialOptions = useMemo(
    () => (sheetMaterialsData?.data ?? []).map((item) => ({
      label: item.is_active === false ? `${item.name} (неактивный)` : item.name,
      value: item.sheet_material_type_id,
      disabled: item.is_active === false && item.sheet_material_type_id !== settings?.sheetMaterialTypeId,
    })),
    [settings?.sheetMaterialTypeId, sheetMaterialsData?.data],
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
    if (draft.hdfEnabled && (draft.hdfEdgeMm == null || draft.hdfEdgeMm <= 0)) {
      message.error('Для включённой ХДФ укажите ребро больше 0');
      return;
    }
    setSavingMillingId(row.millingTypeId);
    try {
      await productionTechSettingsApi.updateHdfMilling(row.millingTypeId, {
        hdfEnabled: draft.hdfEnabled,
        hdfEdgeMm: draft.hdfEnabled ? draft.hdfEdgeMm : null,
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

  const updateMillingDraft = (id: number, patch: Partial<MillingDraft>) => {
    setMillingDrafts((current) => ({
      ...current,
      [id]: {
        hdfEnabled: current[id]?.hdfEnabled ?? false,
        hdfEdgeMm: current[id]?.hdfEdgeMm ?? null,
        ...patch,
      },
    }));
  };

  const columns: ColumnsType<HdfMillingSettingsDto> = [
    {
      title: 'Фрезеровка',
      dataIndex: 'name',
      key: 'name',
      render: (value: string, row: HdfMillingSettingsDto) => (
        <Space size={8}>
          <Text>{value}</Text>
          {row.isActive ? null : <Tag>Неактивна</Tag>}
        </Space>
      ),
    },
    {
      title: 'ХДФ',
      dataIndex: 'hdfEnabled',
      key: 'hdfEnabled',
      width: 120,
      render: (_: boolean, row: HdfMillingSettingsDto) => (
        <Switch
          checked={millingDrafts[row.millingTypeId]?.hdfEnabled ?? false}
          disabled={!canManage}
          onChange={(checked) => updateMillingDraft(row.millingTypeId, { hdfEnabled: checked })}
        />
      ),
    },
    {
      title: 'Ребро, мм',
      dataIndex: 'hdfEdgeMm',
      key: 'hdfEdgeMm',
      width: 180,
      render: (_: number | null, row: HdfMillingSettingsDto) => (
        <InputNumber
          min={0.1}
          step={0.5}
          precision={1}
          style={{ width: 120 }}
          value={millingDrafts[row.millingTypeId]?.hdfEdgeMm ?? null}
          disabled={!canManage || !(millingDrafts[row.millingTypeId]?.hdfEnabled ?? false)}
          onChange={(value) => updateMillingDraft(row.millingTypeId, { hdfEdgeMm: value == null ? null : Number(value) })}
        />
      ),
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
        description="ХДФ рассчитывается автоматически для деталей с включённой фрезеровкой. В заказ попадут только свежие строки без ошибки минимального размера."
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

      <Card size="small" title="Фрезеровки, которые дают ХДФ">
        <Table<HdfMillingSettingsDto>
          rowKey="millingTypeId"
          loading={loading}
          dataSource={settings?.millingTypes ?? []}
          columns={columns}
          pagination={false}
          size="small"
        />
      </Card>
    </Space>
  );
}

function isMillingChanged(row: HdfMillingSettingsDto, draft: MillingDraft | undefined): boolean {
  if (!draft) return false;
  return draft.hdfEnabled !== row.hdfEnabled || (draft.hdfEdgeMm ?? null) !== (row.hdfEdgeMm ?? null);
}

function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return `${error.message}. Обновите данные и повторите сохранение.`;
    return error.message;
  }
  return fallback;
}
