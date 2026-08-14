import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, InputNumber, Select, Space, Typography, message } from 'antd';
import { useList } from '@refinedev/core';
import { ApiError } from '../../../api/apiError';
import {
  productionTechSettingsApi,
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

export function ProductionThresholdsConfigTab() {
  const canManage = can('settings.manage');
  const canViewSheetMaterials = can('sheet_materials.view');
  const [settings, setSettings] = useState<HdfProductionTechSettingsDto | null>(null);
  const [thresholdDraft, setThresholdDraft] = useState<number | null>(null);
  const [materialDraft, setMaterialDraft] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingGlobal, setSavingGlobal] = useState(false);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const next = await productionTechSettingsApi.getHdf();
      setSettings(next);
      setThresholdDraft(next.minSideThresholdMm);
      setMaterialDraft(next.sheetMaterialTypeId);
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

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%', padding: '16px 0' }}>
      <Alert
        type="info"
        showIcon
        message="Пороги техпроцессов производства"
        description="Общий порог ХДФ и материал ХДФ для автоматических расчетов заказа."
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
