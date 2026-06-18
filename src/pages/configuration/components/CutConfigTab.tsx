import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  cutConfigApi,
  type CutConfig,
  type CutParamProfile,
  type CutRenderPreset,
  type SheetMaterialType,
  type SheetMaterialTypeInput,
} from '../../../api/cutConfigApi';
import { ApiError } from '../../../api/httpClient';
import { can } from '../../../utils/permissions';
import {
  extractEligibilityCodes,
  findSetting,
  parseCodesCsv,
  parseJsonObject,
  sheetSpecOnboardingHint,
} from './cutConfigHelpers';

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
  const [editing, setEditing] = useState<SheetMaterialType | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [profileEdit, setProfileEdit] = useState<CutParamProfile | null>(null);
  const [profileCreate, setProfileCreate] = useState(false);
  const [presetEdit, setPresetEdit] = useState<CutRenderPreset | null>(null);
  const [presetCreate, setPresetCreate] = useState(false);
  const [eligibilityCsv, setEligibilityCsv] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await cutConfigApi.get();
      setConfig(data);
      setEligibilityCsv(extractEligibilityCodes(data.settings).join(', '));
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
      await cutConfigApi.updateSetting('eligibility.statuses', { codes: parseCodesCsv(eligibilityCsv) }, row.version);
      message.success('Статусы готовности к раскрою сохранены');
      await reload();
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : 'Не удалось сохранить статусы');
    } finally {
      setBusy(false);
    }
  }, [config, eligibilityCsv, reload]);

  const removeSheet = useCallback(
    async (row: SheetMaterialType) => {
      setBusy(true);
      try {
        await cutConfigApi.deleteSheetMaterialType(row.sheetMaterialTypeId, row.version);
        message.success('Спецификация деактивирована');
        await reload();
      } catch (error) {
        message.error(error instanceof ApiError ? error.message : 'Не удалось удалить спецификацию');
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

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
      { title: 'Параметры', key: 'params', render: (_: unknown, r) => <Text code>{JSON.stringify(r.params)}</Text> },
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

  const sheetColumns: ColumnsType<SheetMaterialType> = useMemo(
    () => [
      { title: 'Название', dataIndex: 'name', key: 'name' },
      { title: 'Тип', dataIndex: 'materialTypeId', key: 'type' },
      { title: 'Толщина, мм', dataIndex: 'thicknessMm', key: 'thickness' },
      { title: 'Ширина, мм', dataIndex: 'widthMm', key: 'width' },
      { title: 'Высота, мм', dataIndex: 'heightMm', key: 'height' },
      {
        title: 'Активна',
        key: 'active',
        render: (_: unknown, row) => (row.isActive ? <Tag color="green">да</Tag> : <Tag>нет</Tag>),
      },
      {
        title: 'Действия',
        key: 'actions',
        render: (_: unknown, row) => (
          <Space>
            <Button size="small" disabled={!canManage} onClick={() => setEditing(row)}>
              Изменить
            </Button>
            <Popconfirm title="Деактивировать спецификацию?" onConfirm={() => removeSheet(row)} okText="Да" cancelText="Нет">
              <Button size="small" danger disabled={!canManage || !row.isActive}>
                Деактивировать
              </Button>
            </Popconfirm>
          </Space>
        ),
      },
    ],
    [canManage, removeSheet],
  );

  if (!can('cut.view')) {
    return <Alert type="error" showIcon message="Недостаточно прав для конфигурации раскроя" />;
  }
  if (loading || !config) {
    return <Spin />;
  }

  const onboardingHint = sheetSpecOnboardingHint(config.sheetMaterialTypes.length);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Title level={4}>Раскрой</Title>
      {onboardingHint && <Alert type="warning" showIcon message={onboardingHint} />}

      <Card
        size="small"
        title="Раскройные спецификации материалов (sheet_material_types)"
        extra={
          <Button type="primary" disabled={!canManage} onClick={() => setCreateOpen(true)}>
            Добавить спецификацию
          </Button>
        }
      >
        <Table<SheetMaterialType>
          size="small"
          rowKey="sheetMaterialTypeId"
          columns={sheetColumns}
          dataSource={config.sheetMaterialTypes}
          pagination={false}
        />
      </Card>

      <Card size="small" title="Статусы готовности к раскрою (eligibility.statuses)">
        <Paragraph type="secondary">
          Коды производственных статусов, при которых деталь считается готовой к раскрою.
        </Paragraph>
        <Space>
          <Input
            value={eligibilityCsv}
            onChange={(e) => setEligibilityCsv(e.target.value)}
            placeholder="new, drawn, film_purchase"
            style={{ width: 320 }}
            disabled={!canManage}
          />
          <Button type="primary" disabled={!canManage} loading={busy} onClick={saveEligibility}>
            Сохранить
          </Button>
        </Space>
      </Card>

      <Card
        size="small"
        title="Профили параметров freecut"
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

      <SheetModal
        open={createOpen || editing !== null}
        editing={editing}
        onClose={() => {
          setCreateOpen(false);
          setEditing(null);
        }}
        onSaved={async () => {
          setCreateOpen(false);
          setEditing(null);
          await reload();
        }}
      />

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
  const [paramsText, setParamsText] = useState('{}');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setIsDefault(editing?.isDefault ?? false);
    setParamsText(JSON.stringify(editing?.params ?? {}, null, 2));
  }, [open, editing]);

  const submit = useCallback(async () => {
    const parsed = parseJsonObject(paramsText);
    if (!parsed.ok) {
      message.error(`Параметры: ${parsed.error}`);
      return;
    }
    setSaving(true);
    try {
      const input = { name: name.trim(), params: parsed.value, isDefault };
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
  }, [editing, name, isDefault, paramsText, onSaved]);

  return (
    <Modal
      title={editing ? 'Изменить профиль параметров' : 'Новый профиль параметров'}
      open={open}
      onOk={submit}
      confirmLoading={saving}
      onCancel={onClose}
      okText="Сохранить"
      cancelText="Отмена"
    >
      <Form layout="vertical">
        <Form.Item label="Название" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="МДФ быстрый" />
        </Form.Item>
        <Form.Item label="Профиль по умолчанию">
          <Switch checked={isDefault} onChange={setIsDefault} />
        </Form.Item>
        <Form.Item label="Параметры (JSON: kerf_mm, spacing_mm, trim_mm, objective, time_limit_ms, restarts, layout_mode, retry_strategy)">
          <Input.TextArea value={paramsText} onChange={(e) => setParamsText(e.target.value)} rows={8} />
        </Form.Item>
      </Form>
    </Modal>
  );
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

interface SheetModalProps {
  open: boolean;
  editing: SheetMaterialType | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

const SheetModal: React.FC<SheetModalProps> = ({ open, editing, onClose, onSaved }) => {
  const [form] = Form.useForm<SheetMaterialTypeInput>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      form.setFieldsValue({
        name: editing.name,
        materialTypeId: editing.materialTypeId,
        thicknessMm: editing.thicknessMm,
        widthMm: editing.widthMm,
        heightMm: editing.heightMm,
      });
    } else {
      form.resetFields();
    }
  }, [open, editing, form]);

  const submit = useCallback(async () => {
    setSaving(true);
    try {
      const values = await form.validateFields();
      if (editing) {
        await cutConfigApi.updateSheetMaterialType(editing.sheetMaterialTypeId, values, editing.version);
      } else {
        await cutConfigApi.createSheetMaterialType(values);
      }
      message.success('Спецификация сохранена');
      await onSaved();
    } catch (error) {
      if (error && (error as { errorFields?: unknown }).errorFields) return;
      message.error(error instanceof ApiError ? error.message : 'Не удалось сохранить спецификацию');
    } finally {
      setSaving(false);
    }
  }, [editing, form, onSaved]);

  return (
    <Modal
      title={editing ? 'Изменить спецификацию' : 'Новая раскройная спецификация'}
      open={open}
      onOk={submit}
      confirmLoading={saving}
      onCancel={onClose}
      okText="Сохранить"
      cancelText="Отмена"
    >
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="Название" rules={[{ required: true, message: 'Укажите название' }]}>
          <Input maxLength={200} placeholder="ЛДСП Egger H1234 16мм 2070x2800" />
        </Form.Item>
        <Form.Item name="materialTypeId" label="ID типа материала" rules={[{ required: true, message: 'Укажите тип материала' }]}>
          <InputNumber min={1} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="thicknessMm" label="Толщина, мм" rules={[{ required: true, message: 'Укажите толщину' }]}>
          <InputNumber min={0.01} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="widthMm" label="Ширина, мм" rules={[{ required: true, message: 'Укажите ширину' }]}>
          <InputNumber min={0.01} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="heightMm" label="Высота, мм" rules={[{ required: true, message: 'Укажите высоту' }]}>
          <InputNumber min={0.01} style={{ width: '100%' }} />
        </Form.Item>
      </Form>
    </Modal>
  );
};
