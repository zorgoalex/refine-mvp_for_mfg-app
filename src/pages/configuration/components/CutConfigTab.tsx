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
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { BorderOutlined, CopyOutlined, MinusOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import { useList } from '@refinedev/core';
import {
  cutConfigApi,
  type CutConfig,
  type CutParamProfile,
  type CutPdfTemplate,
  type CutRenderPreset,
} from '../../../api/cutConfigApi';
import { ApiError } from '../../../api/httpClient';
import { can } from '../../../utils/permissions';
import {
  DEFAULT_PARAM_FORM,
  type FreecutLayoutMode,
  type FreecutObjective,
  type FreecutQuality,
  type FreecutRetryStrategy,
  type ParamProfileForm,
  buildProfileCopyName,
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

  const pdfTemplateColumns: ColumnsType<CutPdfTemplate> = useMemo(
    () => [
      { title: 'Название', dataIndex: 'name', key: 'name' },
      { title: 'Код', dataIndex: 'code', key: 'code' },
      { title: 'Активен', key: 'active', render: (_: unknown, r) => (r.isActive ? <Tag color="green">да</Tag> : <Tag>нет</Tag>) },
    ],
    [],
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

      <Tabs
        items={[
          {
            key: 'cut-settings',
            label: 'Настройки раскроя',
            children: (
              <Space direction="vertical" size="large" style={{ width: '100%' }}>
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

                <Card size="small" title="Шаблоны PDF">
                  <Table<CutPdfTemplate>
                    size="small"
                    rowKey="cutPdfTemplateId"
                    columns={pdfTemplateColumns}
                    dataSource={config.pdfTemplates}
                    pagination={false}
                  />
                </Card>
              </Space>
            ),
          },
          {
            key: 'pdf-template-editor',
            label: 'Редактирование шаблонов PDF',
            children: <PdfTemplateEditor templates={config.pdfTemplates} canManage={canManage} />,
          },
        ]}
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

type PdfTemplateElementType = 'field' | 'line' | 'rect';

interface PdfTemplateElement {
  id: string;
  type: PdfTemplateElementType;
  label: string;
  source: string;
  x: number;
  y: number;
  w: number;
  h: number;
  align: 'left' | 'center' | 'right';
}

interface PdfTemplateDraft {
  code: string;
  name: string;
  elements: PdfTemplateElement[];
}

interface PdfTemplateEditorProps {
  templates: CutPdfTemplate[];
  canManage: boolean;
}

const PDF_TEMPLATE_DRAFTS_KEY = 'cut-pdf-template-drafts:v1';
const PDF_FIELD_OPTIONS = [
  { value: 'order.unique_names', label: 'Заказ' },
  { value: 'client.unique_names', label: 'Клиент' },
  { value: 'order.date', label: 'Дата' },
  { value: 'order.ready_date', label: 'Дата готовности' },
  { value: 'detail.materials', label: 'Материал' },
  { value: 'detail.thicknesses', label: 'Толщина' },
  { value: 'detail.films', label: 'Пленка' },
  { value: 'sheet.number', label: 'Номер листа' },
  { value: 'sheet.page_count', label: 'Количество листов' },
] as const;

const DEFAULT_PDF_ELEMENTS: PdfTemplateElement[] = [
  { id: 'field-order', type: 'field', label: 'Заказ', source: 'order.unique_names', x: 36, y: 34, w: 220, h: 22, align: 'left' },
  { id: 'field-client', type: 'field', label: 'Клиент', source: 'client.unique_names', x: 306, y: 34, w: 220, h: 22, align: 'left' },
  { id: 'field-film', type: 'field', label: 'Пленка', source: 'detail.films', x: 36, y: 74, w: 220, h: 22, align: 'left' },
  { id: 'line-header', type: 'line', label: 'Линия шапки', source: 'shape.line', x: 36, y: 62, w: 770, h: 0, align: 'left' },
  { id: 'rect-sheet', type: 'rect', label: 'Область листа', source: 'sheet.layout', x: 36, y: 112, w: 560, h: 420, align: 'center' },
  { id: 'rect-table', type: 'rect', label: 'Таблица деталей', source: 'detail.table', x: 622, y: 112, w: 184, h: 230, align: 'center' },
];

const PdfTemplateEditor: React.FC<PdfTemplateEditorProps> = ({ templates, canManage }) => {
  const [drafts, setDrafts] = useState<PdfTemplateDraft[]>(() => loadPdfTemplateDrafts(templates));
  const [savingDraft, setSavingDraft] = useState(false);
  const [selectedCode, setSelectedCode] = useState(() => templates[0]?.code ?? drafts[0]?.code ?? 'standard');
  const selected = drafts.find((draft) => draft.code === selectedCode) ?? drafts[0];
  const [selectedElementId, setSelectedElementId] = useState<string | null>(selected?.elements[0]?.id ?? null);
  const selectedElement = selected?.elements.find((element) => element.id === selectedElementId) ?? selected?.elements[0] ?? null;

  useEffect(() => {
    setDrafts((prev) => mergePdfTemplateDrafts(prev, templates));
  }, [templates]);

  useEffect(() => {
    if (!selected || selected.code === selectedCode) return;
    setSelectedCode(selected.code);
  }, [selected, selectedCode]);

  const updateSelected = useCallback((next: PdfTemplateDraft) => {
    setDrafts((prev) => prev.map((draft) => (draft.code === next.code ? next : draft)));
  }, []);

  const updateElement = useCallback(
    (patch: Partial<PdfTemplateElement>) => {
      if (!selected || !selectedElement) return;
      updateSelected({
        ...selected,
        elements: selected.elements.map((element) => (element.id === selectedElement.id ? { ...element, ...patch } : element)),
      });
    },
    [selected, selectedElement, updateSelected],
  );

  const addElement = useCallback(
    (type: PdfTemplateElementType) => {
      if (!selected) return;
      const id = `${type}-${Date.now()}`;
      const base: PdfTemplateElement = type === 'field'
        ? { id, type, label: 'Новое поле', source: 'order.unique_names', x: 80, y: 90, w: 180, h: 24, align: 'left' }
        : type === 'line'
        ? { id, type, label: 'Новая линия', source: 'shape.line', x: 80, y: 120, w: 220, h: 0, align: 'left' }
        : { id, type, label: 'Новый прямоугольник', source: 'shape.rect', x: 80, y: 140, w: 180, h: 80, align: 'center' };
      updateSelected({ ...selected, elements: [...selected.elements, base] });
      setSelectedElementId(id);
    },
    [selected, updateSelected],
  );

  const copyTemplate = useCallback(() => {
    if (!selected) return;
    const code = `${selected.code}_copy_${Date.now().toString(36)}`;
    const copy = {
      ...selected,
      code,
      name: `${selected.name} копия`,
      elements: selected.elements.map((element) => ({ ...element, id: `${element.id}-copy` })),
    };
    setDrafts((prev) => [...prev, copy]);
    setSelectedCode(code);
    setSelectedElementId(copy.elements[0]?.id ?? null);
  }, [selected]);

  const saveDrafts = useCallback(async () => {
    if (!selected) return;
    const template = templates.find((item) => item.code === selected.code);
    if (!template) {
      window.localStorage.setItem(PDF_TEMPLATE_DRAFTS_KEY, JSON.stringify(drafts));
      message.success('Локальная копия шаблона PDF сохранена');
      return;
    }
    setSavingDraft(true);
    try {
      const updated = template
        ? await cutConfigApi.updatePdfTemplate(
            template.cutPdfTemplateId,
            { name: selected.name, layout: { elements: selected.elements }, isActive: template.isActive },
            template.version,
          )
        : await cutConfigApi.createPdfTemplate({
            code: selected.code,
            name: selected.name,
            layout: { elements: selected.elements },
            isActive: true,
          });
      setDrafts((prev) => prev.map((draft) => (draft.code === updated.code ? pdfTemplateToDraft(updated) : draft)));
      message.success('Шаблон PDF сохранён');
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : 'Не удалось сохранить шаблон PDF');
    } finally {
      setSavingDraft(false);
    }
  }, [drafts, selected, templates]);

  if (!selected) {
    return <Alert type="warning" showIcon message="Нет активных шаблонов PDF" />;
  }

  const elementRows: ColumnsType<PdfTemplateElement> = [
    { title: 'Элемент', dataIndex: 'label', key: 'label' },
    { title: 'Тип', dataIndex: 'type', key: 'type', width: 90 },
    { title: 'Данные', dataIndex: 'source', key: 'source', width: 160 },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space wrap align="center">
        <Select
          value={selectedCode}
          onChange={(code) => {
            const draft = drafts.find((item) => item.code === code);
            setSelectedCode(code);
            setSelectedElementId(draft?.elements[0]?.id ?? null);
          }}
          options={drafts.map((draft) => ({ value: draft.code, label: draft.name }))}
          style={{ width: 260 }}
        />
        <Button icon={<SaveOutlined />} type="primary" disabled={!canManage} loading={savingDraft} onClick={() => void saveDrafts()}>
          Сохранить
        </Button>
        <Button icon={<CopyOutlined />} disabled={!canManage} onClick={copyTemplate}>
          Создать копию
        </Button>
        <Button disabled={!canManage} onClick={copyTemplate}>
          Сохранить как
        </Button>
        <Button icon={<PlusOutlined />} disabled={!canManage} onClick={() => addElement('field')}>
          Добавить поле
        </Button>
        <Button icon={<MinusOutlined />} disabled={!canManage} onClick={() => addElement('line')}>
          Добавить линию
        </Button>
        <Button icon={<BorderOutlined />} disabled={!canManage} onClick={() => addElement('rect')}>
          Добавить прямоугольник
        </Button>
      </Space>

      <Row gutter={16} align="top">
        <Col xs={24} xl={15}>
          <div
            role="img"
            aria-label="Предпросмотр шаблона PDF"
            style={{
              position: 'relative',
              width: '100%',
              maxWidth: 842,
              aspectRatio: '842 / 595',
              background: '#ffffff',
              boxShadow: '0 1px 2px rgba(0,0,0,0.08), 0 12px 32px rgba(15,23,42,0.08)',
              overflow: 'hidden',
            }}
          >
            {selected.elements.map((element) => (
              <PdfTemplateElementBox
                key={element.id}
                element={element}
                active={element.id === selectedElement?.id}
                onSelect={() => setSelectedElementId(element.id)}
              />
            ))}
          </div>
        </Col>
        <Col xs={24} xl={9}>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Table<PdfTemplateElement>
              size="small"
              rowKey="id"
              columns={elementRows}
              dataSource={selected.elements}
              pagination={false}
              rowClassName={(row) => (row.id === selectedElement?.id ? 'ant-table-row-selected' : '')}
              onRow={(row) => ({ onClick: () => setSelectedElementId(row.id) })}
            />
            {selectedElement && (
              <Card size="small" title="Свойства элемента">
                <Form layout="vertical">
                  <Form.Item label="Название" style={{ marginBottom: 10 }}>
                    <Input value={selectedElement.label} onChange={(e) => updateElement({ label: e.target.value })} disabled={!canManage} />
                  </Form.Item>
                  <Form.Item label="Данные" style={{ marginBottom: 10 }}>
                    <Select
                      value={selectedElement.source}
                      onChange={(source) => updateElement({ source })}
                      options={PDF_FIELD_OPTIONS}
                      disabled={!canManage || selectedElement.type !== 'field'}
                    />
                  </Form.Item>
                  <Row gutter={8}>
                    <Col span={6}><NumberBox label="X" value={selectedElement.x} disabled={!canManage} onChange={(x) => updateElement({ x })} /></Col>
                    <Col span={6}><NumberBox label="Y" value={selectedElement.y} disabled={!canManage} onChange={(y) => updateElement({ y })} /></Col>
                    <Col span={6}><NumberBox label="W" value={selectedElement.w} disabled={!canManage} onChange={(w) => updateElement({ w })} /></Col>
                    <Col span={6}><NumberBox label="H" value={selectedElement.h} disabled={!canManage} onChange={(h) => updateElement({ h })} /></Col>
                  </Row>
                  <Form.Item label="Выравнивание" style={{ marginBottom: 0 }}>
                    <Segmented
                      value={selectedElement.align}
                      onChange={(align) => updateElement({ align: align as PdfTemplateElement['align'] })}
                      options={[
                        { value: 'left', label: 'Лево' },
                        { value: 'center', label: 'Центр' },
                        { value: 'right', label: 'Право' },
                      ]}
                      disabled={!canManage || selectedElement.type !== 'field'}
                    />
                  </Form.Item>
                </Form>
              </Card>
            )}
          </Space>
        </Col>
      </Row>
    </Space>
  );
};

const PdfTemplateElementBox: React.FC<{ element: PdfTemplateElement; active: boolean; onSelect: () => void }> = ({
  element,
  active,
  onSelect,
}) => {
  const commonStyle: React.CSSProperties = {
    position: 'absolute',
    left: `${(element.x / 842) * 100}%`,
    top: `${(element.y / 595) * 100}%`,
    width: `${(element.w / 842) * 100}%`,
    height: element.type === 'line' ? 1 : `${(Math.max(element.h, 1) / 595) * 100}%`,
    cursor: 'pointer',
  };
  if (element.type === 'line') {
    return <div onClick={onSelect} style={{ ...commonStyle, background: active ? '#1677ff' : '#111111' }} />;
  }
  if (element.type === 'rect') {
    return (
      <div
        onClick={onSelect}
        style={{
          ...commonStyle,
          border: active ? '2px solid #1677ff' : '1px solid #111111',
          background: 'rgba(22,119,255,0.03)',
        }}
      />
    );
  }
  return (
    <div
      onClick={onSelect}
      style={{
        ...commonStyle,
        borderBottom: active ? '2px solid #1677ff' : '1px solid #111111',
        color: '#111111',
        fontSize: 12,
        lineHeight: '20px',
        textAlign: element.align,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {element.label}: {'{'}{element.source}{'}'}
    </div>
  );
};

const NumberBox: React.FC<{ label: string; value: number; disabled: boolean; onChange: (value: number) => void }> = ({
  label,
  value,
  disabled,
  onChange,
}) => (
  <Form.Item label={label} style={{ marginBottom: 10 }}>
    <InputNumber min={0} value={value} onChange={(next) => onChange(Number(next ?? 0))} disabled={disabled} style={{ width: '100%' }} />
  </Form.Item>
);

function loadPdfTemplateDrafts(templates: CutPdfTemplate[]): PdfTemplateDraft[] {
  if (typeof window !== 'undefined') {
    try {
      const saved = window.localStorage.getItem(PDF_TEMPLATE_DRAFTS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as PdfTemplateDraft[];
        if (Array.isArray(parsed) && parsed.length > 0) return mergePdfTemplateDrafts(parsed, templates);
      }
    } catch {
      // Ignore broken local drafts; config templates remain authoritative.
    }
  }
  return mergePdfTemplateDrafts([], templates);
}

function mergePdfTemplateDrafts(drafts: PdfTemplateDraft[], templates: CutPdfTemplate[]): PdfTemplateDraft[] {
  const byCode = new Map(drafts.map((draft) => [draft.code, draft]));
  for (const template of templates) {
    if (!template.isActive) continue;
    byCode.set(template.code, pdfTemplateToDraft(template));
  }
  return [...byCode.values()];
}

function pdfTemplateToDraft(template: CutPdfTemplate): PdfTemplateDraft {
  const elements = Array.isArray((template.layout as { elements?: unknown }).elements)
    ? ((template.layout as { elements: PdfTemplateElement[] }).elements)
    : DEFAULT_PDF_ELEMENTS;
  return { code: template.code, name: template.name, elements };
}

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
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [copyName, setCopyName] = useState('');
  const [savingCopy, setSavingCopy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setIsDefault(editing?.isDefault ?? false);
    setParams(editing ? paramsToForm(editing.params) : DEFAULT_PARAM_FORM);
    setSaveAsOpen(false);
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

  const openSaveAs = useCallback(() => {
    setCopyName(buildProfileCopyName(name));
    setSaveAsOpen(true);
  }, [name]);

  const submitCopy = useCallback(async () => {
    const trimmed = copyName.trim();
    if (!trimmed) {
      message.error('Укажите название профиля');
      return;
    }
    setSavingCopy(true);
    try {
      // Reuse the audited create command with the CURRENT form params under a new
      // name; the copy never becomes default (avoids the single-default constraint).
      await cutConfigApi.createParamProfile({ name: trimmed, params: formToParams(params), isDefault: false });
      message.success('Профиль скопирован');
      setSaveAsOpen(false);
      await onSaved();
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : 'Не удалось сохранить профиль');
    } finally {
      setSavingCopy(false);
    }
  }, [copyName, params, onSaved]);

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
    <>
    <Modal
      title={editing ? 'Изменить профиль параметров' : 'Новый профиль параметров'}
      open={open}
      onCancel={onClose}
      width={680}
      footer={[
        editing ? (
          <Button key="saveas" disabled={saving} onClick={openSaveAs}>
            Сохранить как…
          </Button>
        ) : null,
        <Button key="cancel" onClick={onClose}>
          Отмена
        </Button>,
        <Button key="ok" type="primary" loading={saving} onClick={submit}>
          Сохранить
        </Button>,
      ]}
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
                  { value: 'vacuum_table', label: 'Вакуумный стол' },
                ]}
              />
            </Form.Item>
            {params.layout_mode === 'vacuum_table' && (
              <Form.Item
                label="Направление подачи"
                tooltip="Авто — оптимизатор выбирает направление. Вдоль — детали укладываются вдоль длинной стороны листа. Поперёк — поперёк длинной стороны."
                extra={VACUUM_DIRECTION_META.short}
                style={{ marginBottom: 12 }}
              >
                <Radio.Group
                  optionType="button"
                  buttonStyle="solid"
                  value={params.vacuum?.direction ?? 'optimal'}
                  onChange={(e) => setField('vacuum', { direction: e.target.value as 'optimal' | 'width' | 'height' })}
                  options={[
                    { value: 'optimal', label: 'Авто' },
                    { value: 'width', label: 'Вдоль' },
                    { value: 'height', label: 'Поперёк' },
                  ]}
                />
              </Form.Item>
            )}
          </Col>
        </Row>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item
              label="Качество"
              tooltip={QUALITY_META.tooltip}
              extra={QUALITY_META.short}
              style={{ marginBottom: 12 }}
            >
              <Segmented
                value={params.quality}
                onChange={(v) => setField('quality', v as FreecutQuality)}
                options={[
                  { value: 'fast', label: 'Быстро' },
                  { value: 'balanced', label: 'Баланс' },
                  { value: 'quality', label: 'Качество' },
                ]}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              label="Сжимать группы деталей"
              tooltip={GROUP_SHIFT_META.tooltip}
              extra={GROUP_SHIFT_META.short}
              style={{ marginBottom: 12 }}
            >
              <Switch checked={params.groupShift} onChange={(v) => setField('groupShift', v)} />
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

    <Modal
      title="Сохранить как новый профиль"
      open={saveAsOpen}
      onOk={submitCopy}
      confirmLoading={savingCopy}
      onCancel={() => setSaveAsOpen(false)}
      okText="Создать"
      cancelText="Отмена"
      width={480}
    >
      <Form layout="vertical">
        <Form.Item
          label="Название нового профиля"
          required
          extra="Копия создаётся с текущими параметрами формы. По умолчанию — нет."
        >
          <Input
            autoFocus
            value={copyName}
            onChange={(e) => setCopyName(e.target.value)}
            maxLength={200}
            onPressEnter={submitCopy}
          />
        </Form.Item>
      </Form>
    </Modal>
    </>
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
const VACUUM_DIRECTION_META = {
  short: 'Ориентация деталей на вакуумном столе',
  tooltip: 'Авто — оптимизатор выбирает направление. Вдоль — детали укладываются вдоль длинной стороны листа. Поперёк — поперёк длинной стороны.',
};
const QUALITY_META = {
  short: 'Скорость против плотности',
  tooltip: 'Быстро — считает быстрее, упаковка чуть свободнее. Баланс — рекомендуемый компромисс. Качество — плотнее раскрой, дольше расчёт.',
};
const GROUP_SHIFT_META = {
  short: 'Подтягивать крайние группы к центру',
  tooltip: 'Постобработка: сдвигает отдельно стоящие группы деталей к плотному кластеру, закрывая узкие коридоры — остаток листа цельнее. Может немного удлинить расчёт.',
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
