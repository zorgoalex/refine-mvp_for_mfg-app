import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Row,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useList } from '@refinedev/core';
import {
  cutConfigApi,
  type CutConfig,
  type CutParamProfile,
  type CutRenderPreset,
} from '../../../api/cutConfigApi';
import { ApiError } from '../../../api/httpClient';
import { can } from '../../../utils/permissions';
import {
  DEFAULT_PARAM_FORM,
  type FreecutLayoutMode,
  type FreecutObjective,
  type FreecutRetryStrategy,
  type ParamProfileForm,
  extractEligibilityCodes,
  findSetting,
  formToParams,
  paramsToForm,
  summarizeParams,
} from './cutConfigHelpers';
import { CutDefaultSettingsCard } from './CutDefaultSettingsCard';

const { Title, Text, Paragraph } = Typography;

/**
 * /configuration "Раскрой" tab (plan §4a, §5). Backend-owned config CRUD via
 * cutConfigApi (`/api/v1/cut-config`) — no page-level Hasura access. Day-0
 * onboarding: define sheet specs -> link materials -> eligibility surfaces
 * no_sheet_spec until done.
 */
export const CutConfigTab: React.FC = () => {
  const canManage = can('cut.manage');
  const [config, setConfig] = useState<CutConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileEdit, setProfileEdit] = useState<CutParamProfile | null>(null);
  const [profileCreate, setProfileCreate] = useState(false);
  const [presetEdit, setPresetEdit] = useState<CutRenderPreset | null>(null);
  const [presetCreate, setPresetCreate] = useState(false);
  const [eligibilityCodes, setEligibilityCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // Production statuses come from the retained Hasura reference layer (lookup/select,
  // CLAUDE.md principle 1) — same read path as the production workflow tab. Includes
  // inactive statuses so a previously-saved code still renders as a selected chip.
  const { data: statusesData } = useList({
    resource: 'production_statuses',
    pagination: { pageSize: 200 },
    filters: [{ field: 'is_active', operator: 'in', value: [true, false] }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
  });
  const statusOptions = useMemo(
    () =>
      (statusesData?.data ?? []).map((s: any) => ({
        value: s.production_status_code as string,
        label: `${s.production_status_name} (${s.production_status_code})`,
      })),
    [statusesData],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await cutConfigApi.get();
      setConfig(data);
      setEligibilityCodes(extractEligibilityCodes(data.settings));
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : 'Не удалось загрузить конфигурацию раскроя');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const saveEligibility = useCallback(async () => {
    if (!config) return;
    const row = findSetting(config.settings, 'eligibility.statuses');
    if (!row) return;
    setBusy(true);
    try {
      await cutConfigApi.updateSetting('eligibility.statuses', { codes: eligibilityCodes }, row.version);
      message.success('Статусы готовности к раскрою сохранены');
      await reload();
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : 'Не удалось сохранить статусы');
    } finally {
      setBusy(false);
    }
  }, [config, eligibilityCodes, reload]);

  const removeProfile = useCallback(
    async (row: CutParamProfile) => {
      setBusy(true);
      try {
        await cutConfigApi.deleteParamProfile(row.cutParamProfileId, row.version);
        message.success('Профиль деактивирован');
        await reload();
      } catch (error) {
        message.error(error instanceof ApiError ? error.message : 'Не удалось удалить профиль');
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const removePreset = useCallback(
    async (row: CutRenderPreset) => {
      setBusy(true);
      try {
        await cutConfigApi.deleteRenderPreset(row.cutRenderPresetId, row.version);
        message.success('Пресет деактивирован');
        await reload();
      } catch (error) {
        message.error(error instanceof ApiError ? error.message : 'Не удалось удалить пресет');
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const profileColumns: ColumnsType<CutParamProfile> = useMemo(
    () => [
      { title: 'Название', dataIndex: 'name', key: 'name' },
      { title: 'По умолчанию', key: 'default', render: (_: unknown, r) => (r.isDefault ? <Tag color="blue">да</Tag> : null) },
      { title: 'Параметры', key: 'params', render: (_: unknown, r) => <Text type="secondary">{summarizeParams(r.params)}</Text> },
      { title: 'Активен', key: 'active', render: (_: unknown, r) => (r.isActive ? <Tag color="green">да</Tag> : <Tag>нет</Tag>) },
      {
        title: 'Действия',
        key: 'actions',
        render: (_: unknown, r) => (
          <Space>
            <Button size="small" disabled={!canManage} onClick={() => setProfileEdit(r)}>Изменить</Button>
            <Popconfirm title="Деактивировать профиль?" onConfirm={() => removeProfile(r)} okText="Да" cancelText="Нет">
              <Button size="small" danger disabled={!canManage || !r.isActive}>Деактивировать</Button>
            </Popconfirm>
          </Space>
        ),
      },
    ],
    [canManage, removeProfile],
  );

  const presetColumns: ColumnsType<CutRenderPreset> = useMemo(
    () => [
      { title: 'Название', dataIndex: 'name', key: 'name' },
      { title: 'Размер, px', dataIndex: 'targetPx', key: 'px' },
      { title: 'Фон', dataIndex: 'background', key: 'bg' },
      { title: 'Активен', key: 'active', render: (_: unknown, r) => (r.isActive ? <Tag color="green">да</Tag> : <Tag>нет</Tag>) },
      {
        title: 'Действия',
        key: 'actions',
        render: (_: unknown, r) => (
          <Space>
            <Button size="small" disabled={!canManage} onClick={() => setPresetEdit(r)}>Изменить</Button>
            <Popconfirm title="Деактивировать пресет?" onConfirm={() => removePreset(r)} okText="Да" cancelText="Нет">
              <Button size="small" danger disabled={!canManage || !r.isActive}>Деактивировать</Button>
            </Popconfirm>
          </Space>
        ),
      },
    ],
    [canManage, removePreset],
  );

  if (!can('cut.view')) {
    return <Alert type="error" showIcon message="Недостаточно прав для конфигурации раскроя" />;
  }
  if (loading || !config) {
    return <Spin />;
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Title level={4}>Раскрой</Title>

      <CutDefaultSettingsCard config={config} canManage={canManage} onSaved={reload} />

      <Card size="small" title="Статусы готовности к раскрою (eligibility.statuses)">
        <Paragraph type="secondary">
          Коды производственных статусов, при которых деталь считается готовой к раскрою.
        </Paragraph>
        <Space align="start">
          <Select
            mode="multiple"
            value={eligibilityCodes}
            onChange={setEligibilityCodes}
            options={statusOptions}
            optionFilterProp="label"
            placeholder="Выберите производственные статусы"
            style={{ minWidth: 360 }}
            disabled={!canManage}
          />
          <Button type="primary" disabled={!canManage} loading={busy} onClick={saveEligibility}>
            Сохранить
          </Button>
        </Space>
      </Card>

      <Card
        size="small"
        title="Профили параметров (доп.)"
        extra={
          <Button type="primary" disabled={!canManage} onClick={() => setProfileCreate(true)}>
            Добавить профиль
          </Button>
        }
      >
        <Table<CutParamProfile>
          size="small"
          rowKey="cutParamProfileId"
          columns={profileColumns}
          dataSource={config.paramProfiles}
          pagination={false}
        />
      </Card>

      <Card
        size="small"
        title="Пресеты рендера (PNG)"
        extra={
          <Button type="primary" disabled={!canManage} onClick={() => setPresetCreate(true)}>
            Добавить пресет
          </Button>
        }
      >
        <Table<CutRenderPreset>
          size="small"
          rowKey="cutRenderPresetId"
          columns={presetColumns}
          dataSource={config.renderPresets}
          pagination={false}
        />
      </Card>

      <ProfileModal
        open={profileCreate || profileEdit !== null}
        editing={profileEdit}
        onClose={() => {
          setProfileCreate(false);
          setProfileEdit(null);
        }}
        onSaved={async () => {
          setProfileCreate(false);
          setProfileEdit(null);
          await reload();
        }}
      />

      <PresetModal
        open={presetCreate || presetEdit !== null}
        editing={presetEdit}
        onClose={() => {
          setPresetCreate(false);
          setPresetEdit(null);
        }}
        onSaved={async () => {
          setPresetCreate(false);
          setPresetEdit(null);
          await reload();
        }}
      />
    </Space>
  );
};

interface ProfileModalProps {
  open: boolean;
  editing: CutParamProfile | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

const ProfileModal: React.FC<ProfileModalProps> = ({ open, editing, onClose, onSaved }) => {
  const [name, setName] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [params, setParams] = useState<ParamProfileForm>(DEFAULT_PARAM_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setIsDefault(editing?.isDefault ?? false);
    setParams(editing ? paramsToForm(editing.params) : DEFAULT_PARAM_FORM);
  }, [open, editing]);

  const setField = useCallback(<K extends keyof ParamProfileForm>(key: K, value: ParamProfileForm[K]) => {
    setParams((prev) => ({ ...prev, [key]: value }));
  }, []);

  const submit = useCallback(async () => {
    if (!name.trim()) {
      message.error('Укажите название профиля');
      return;
    }
    setSaving(true);
    try {
      const input = { name: name.trim(), params: formToParams(params), isDefault };
      if (editing) {
        await cutConfigApi.updateParamProfile(editing.cutParamProfileId, input, editing.version);
      } else {
        await cutConfigApi.createParamProfile(input);
      }
      message.success('Профиль сохранён');
      await onSaved();
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : 'Не удалось сохранить профиль');
    } finally {
      setSaving(false);
    }
  }, [editing, name, isDefault, params, onSaved]);

  const numberField = (key: NumKey) => {
    const m = NUM_META[key];
    return (
      <Form.Item label={m.label} tooltip={m.tooltip} extra={m.short} style={{ marginBottom: 12 }}>
        <InputNumber
          min={m.min}
          step={m.step}
          keyboard
          value={params[key] as number}
          onChange={(v) => setField(key, Number(v ?? 0) as never)}
          style={{ width: '100%' }}
        />
      </Form.Item>
    );
  };

  return (
    <Modal
      title={editing ? 'Изменить профиль параметров' : 'Новый профиль параметров'}
      open={open}
      onOk={submit}
      confirmLoading={saving}
      onCancel={onClose}
      okText="Сохранить"
      cancelText="Отмена"
      width={680}
    >
      <Form layout="vertical">
        <Form.Item label="Название" required extra="Понятное имя профиля для выбора при раскрое">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="МДФ быстрый" />
        </Form.Item>
        <Form.Item
          label="Профиль по умолчанию"
          tooltip="Профиль, который применяется к раскрою, если другой не выбран. По умолчанию может быть только один."
          extra="Применяется, если профиль не выбран явно"
        >
          <Switch checked={isDefault} onChange={setIsDefault} />
        </Form.Item>

        <Typography.Text type="secondary">Параметры реза, мм</Typography.Text>
        <Row gutter={12}>
          <Col span={12}>{numberField('kerf_mm')}</Col>
          <Col span={12}>{numberField('spacing_mm')}</Col>
        </Row>

        <Typography.Text type="secondary">Обрезка кромки листа (trim), мм</Typography.Text>
        <Row gutter={12}>
          <Col span={6}>{numberField('trim_left')}</Col>
          <Col span={6}>{numberField('trim_right')}</Col>
          <Col span={6}>{numberField('trim_top')}</Col>
          <Col span={6}>{numberField('trim_bottom')}</Col>
        </Row>

        <Typography.Text type="secondary">Оптимизация</Typography.Text>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item label="Цель оптимизации" tooltip={OBJECTIVE_META.tooltip} extra={OBJECTIVE_META.short} style={{ marginBottom: 12 }}>
              <Radio.Group
                optionType="button"
                buttonStyle="solid"
                value={params.objective}
                onChange={(e) => setField('objective', e.target.value as FreecutObjective)}
                options={[
                  { value: 'min_waste', label: 'Меньше отхода' },
                  { value: 'min_sheets', label: 'Меньше листов' },
                ]}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label="Тип раскладки" tooltip={LAYOUT_META.tooltip} extra={LAYOUT_META.short} style={{ marginBottom: 12 }}>
              <Radio.Group
                optionType="button"
                buttonStyle="solid"
                value={params.layout_mode}
                onChange={(e) => setField('layout_mode', e.target.value as FreecutLayoutMode)}
                options={[
                  { value: 'guillotine', label: 'Гильотинная' },
                  { value: 'nested', label: 'Вложенная' },
                ]}
              />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={12}>
          <Col span={8}>{numberField('time_limit_ms')}</Col>
          <Col span={8}>{numberField('restarts')}</Col>
          <Col span={8}>
            <Form.Item label="Ретраи при таймауте" tooltip={RETRY_META.tooltip} extra={RETRY_META.short} style={{ marginBottom: 12 }}>
              <Radio.Group
                optionType="button"
                buttonStyle="solid"
                value={params.retry_strategy}
                onChange={(e) => setField('retry_strategy', e.target.value as FreecutRetryStrategy)}
                options={[
                  { value: 'disabled', label: 'Отключены' },
                  { value: 'smart', label: 'Умные' },
                ]}
              />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
};

type NumKey =
  | 'kerf_mm'
  | 'spacing_mm'
  | 'trim_left'
  | 'trim_right'
  | 'trim_top'
  | 'trim_bottom'
  | 'time_limit_ms'
  | 'restarts';

const NUM_META: Record<NumKey, { label: string; short: string; tooltip: string; min: number; step: number }> = {
  kerf_mm: {
    label: 'Пропил (kerf), мм',
    short: 'Ширина реза пилой',
    tooltip: 'Толщина пропила пильного диска — на эту величину «съедается» материал между соседними деталями. Обычно 2–4 мм.',
    min: 0,
    step: 0.5,
  },
  spacing_mm: {
    label: 'Зазор (spacing), мм',
    short: 'Доп. отступ между деталями',
    tooltip: 'Технологический зазор между соседними деталями сверх пропила. Обычно 0–2 мм.',
    min: 0,
    step: 0.5,
  },
  trim_left: { label: 'Слева', short: 'Обрез кромки', tooltip: 'Сколько мм обрезается с левого края листа перед раскроем (некондиционная кромка).', min: 0, step: 1 },
  trim_right: { label: 'Справа', short: 'Обрез кромки', tooltip: 'Сколько мм обрезается с правого края листа перед раскроем (некондиционная кромка).', min: 0, step: 1 },
  trim_top: { label: 'Сверху', short: 'Обрез кромки', tooltip: 'Сколько мм обрезается с верхнего края листа перед раскроем (некондиционная кромка).', min: 0, step: 1 },
  trim_bottom: { label: 'Снизу', short: 'Обрез кромки', tooltip: 'Сколько мм обрезается с нижнего края листа перед раскроем (некондиционная кромка).', min: 0, step: 1 },
  time_limit_ms: {
    label: 'Лимит времени, мс',
    short: 'Бюджет на расчёт раскроя',
    tooltip: 'Максимум времени работы оптимизатора на одну группу. Больше времени — потенциально плотнее раскрой, но дольше. Прод-дефолт 1200 мс.',
    min: 0,
    step: 100,
  },
  restarts: {
    label: 'Перезапуски',
    short: 'Число попыток оптимизации',
    tooltip: 'Сколько раз оптимизатор стартует заново с разных начальных точек и берёт лучший результат. Больше — качественнее и дольше.',
    min: 0,
    step: 1,
  },
};

const OBJECTIVE_META = {
  short: 'Что минимизировать',
  tooltip: 'Меньше отхода — плотнее упаковка, меньше обрезков. Меньше листов — задействовать как можно меньше листов (может вырасти отход).',
};
const LAYOUT_META = {
  short: 'Схема резов',
  tooltip: 'Гильотинная — только сквозные резы от края до края (для форматно-раскроечного станка). Вложенная — произвольное размещение, плотнее, но требует другого оборудования.',
};
const RETRY_META = {
  short: 'Поведение при нехватке времени',
  tooltip: 'Отключены — вернуть лучший результат в рамках лимита времени (стабильно ~1.5 с). Умные — дополнительные попытки при таймауте слайса (может удлинить расчёт до ~3 с).',
};

interface PresetModalProps {
  open: boolean;
  editing: CutRenderPreset | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

const PresetModal: React.FC<PresetModalProps> = ({ open, editing, onClose, onSaved }) => {
  const [name, setName] = useState('');
  const [targetPx, setTargetPx] = useState<number>(1400);
  const [background, setBackground] = useState('#ffffff');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setTargetPx(editing?.targetPx ?? 1400);
    setBackground(editing?.background ?? '#ffffff');
  }, [open, editing]);

  const submit = useCallback(async () => {
    if (!name.trim()) {
      message.error('Укажите название пресета');
      return;
    }
    setSaving(true);
    try {
      const input = { name: name.trim(), targetPx, background };
      if (editing) {
        await cutConfigApi.updateRenderPreset(editing.cutRenderPresetId, input, editing.version);
      } else {
        await cutConfigApi.createRenderPreset(input);
      }
      message.success('Пресет сохранён');
      await onSaved();
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : 'Не удалось сохранить пресет');
    } finally {
      setSaving(false);
    }
  }, [editing, name, targetPx, background, onSaved]);

  return (
    <Modal
      title={editing ? 'Изменить пресет рендера' : 'Новый пресет рендера'}
      open={open}
      onOk={submit}
      confirmLoading={saving}
      onCancel={onClose}
      okText="Сохранить"
      cancelText="Отмена"
    >
      <Form layout="vertical">
        <Form.Item label="Название" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="screen" />
        </Form.Item>
        <Form.Item label="Размер (px, длинная сторона)" required>
          <InputNumber min={1} value={targetPx} onChange={(v) => setTargetPx(Number(v ?? 0))} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Цвет фона">
          <Input value={background} onChange={(e) => setBackground(e.target.value)} />
        </Form.Item>
      </Form>
    </Modal>
  );
};

