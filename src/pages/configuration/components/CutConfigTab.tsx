import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Collapse,
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
import {
  AlignCenterOutlined,
  AlignLeftOutlined,
  AlignRightOutlined,
  BorderOutlined,
  CopyOutlined,
  DeleteOutlined,
  MinusOutlined,
  PictureOutlined,
  PlusOutlined,
  QrcodeOutlined,
  SaveOutlined,
  TableOutlined,
} from '@ant-design/icons';
import type Konva from 'konva';
import { Group as KonvaGroup, Layer, Line as KonvaLine, Rect as KonvaRect, Stage, Text as KonvaText, Transformer } from 'react-konva';
import { useList } from '@refinedev/core';
import {
  cutConfigApi,
  type CutConfig,
  type CutPdfFieldCatalogItem,
  type CutParamProfile,
  type CutPdfTemplate,
  type CutRenderPreset,
} from '../../../api/cutConfigApi';
import type { LabelCustomExpressionNode, LabelFieldCatalogItem } from '../../../api/types/labelsApi.types';
import { ApiError } from '../../../api/httpClient';
import { can } from '../../../utils/permissions';
import {
  DEFAULT_PARAM_FORM,
  type FreecutCutQuality,
  type FreecutEngineChoice,
  type FreecutLayoutMode,
  type FreecutObjective,
  type FreecutQuality,
  type FreecutRetryStrategy,
  type ParamProfileForm,
  buildProfileCopyName,
  detectEngineParamAnomalies,
  extractEligibilityCodes,
  findSetting,
  formToParams,
  paramsToForm,
  summarizeParams,
} from './cutConfigHelpers';
import { CutDefaultSettingsCard } from './CutDefaultSettingsCard';
import { CustomFieldExpressionEditor } from './CustomFieldExpressionEditor';
import {
  customFieldRowsFromSchema,
  customFieldRowsToSchema,
  evaluateCustomFieldPreviewValues,
  isCustomFieldExpressionValid,
  summarizeCustomFieldExpression,
  type CustomFieldSchemaRow,
} from './labelTemplateEditorHelpers';

const { Title, Text, Paragraph } = Typography;
const { Panel } = Collapse;

const ENGINE_OPTIONS: Array<{ value: FreecutEngineChoice; label: string }> = [
  { value: 'auto', label: 'Авто' },
  { value: 'heuristic', label: 'Быстрый' },
  { value: 'ga', label: 'Генетический' },
];

const ENGINE_TOOLTIP =
  'Авто — движок выбирается автоматически: крупные задания (от серверного порога по числу деталей) считает быстрый движок, небольшие — генетический. ' +
  'Быстрый — принудительно эвристический движок: жадная укладка деталей с доупаковкой листов (уровень задаётся полем ниже, по умолчанию Max); крупные задания считаются в разы быстрее и обычно не хуже. ' +
  'Генетический — принудительно классический генетический алгоритм: эволюционный перебор множества вариантов раскладки в пределах лимита времени; на небольших и средних заданиях часто даёт самую плотную укладку, но на крупных считает заметно дольше и обычно уже не выигрывает у быстрого движка.';

const ENGINE_EXTRA: Record<FreecutEngineChoice, string> = {
  auto: 'Авто: крупные задания — быстрый движок, небольшие — генетический',
  heuristic: 'Быстрый движок экономит листы на крупных заданиях',
  ga: 'Генетический движок — самая плотная укладка небольших заданий, крупные считает дольше',
};

const CUT_QUALITY_OPTIONS: Array<{ value: FreecutCutQuality; label: string }> = [
  { value: 'fast', label: 'Fast' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'max', label: 'Max' },
];

function isEngineChoice(value: string | number): value is FreecutEngineChoice {
  return value === 'auto' || value === 'heuristic' || value === 'ga';
}

function isCutQuality(value: string | number): value is FreecutCutQuality {
  return value === 'fast' || value === 'balanced' || value === 'max';
}

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
    sorters: [{ field: 'sort_order', order: 'asc' }, { field: 'production_status_id', order: 'asc' }],
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
            label: 'Редактирование шаблонов карт раскроя PDF',
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

type PdfTemplateElementType = 'text' | 'field' | 'custom' | 'qr' | 'line' | 'rect' | 'sheet_thumbnail' | 'detail_table';
type PdfTextAlign = 'left' | 'center' | 'right';
type PdfFieldSource = CutPdfFieldCatalogItem['source'] | 'client' | 'computed';

interface PdfFieldCatalogItem {
  id: string;
  source: PdfFieldSource;
  sourceColumn?: string | null;
  label: string;
  category: string;
  type: 'string' | 'number' | 'boolean' | 'date';
}

interface PdfDetailTableColumn {
  field: string;
  label: string;
  width: number;
  visible: boolean;
}

interface PdfTemplateElement {
  id: string;
  type: PdfTemplateElementType;
  label: string;
  source: string | null;
  text: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  zIndex: number;
  align: PdfTextAlign;
  style: Record<string, unknown>;
}

interface PdfTemplateDraft {
  code: string;
  name: string;
  page: { width: number; height: number };
  customFields: CustomFieldSchemaRow[];
  elements: PdfTemplateElement[];
}

interface PdfTemplateEditorProps {
  templates: CutPdfTemplate[];
  canManage: boolean;
}

const PDF_TEMPLATE_DRAFTS_KEY = 'cut-pdf-template-drafts:v2';
const CUT_PDF_FIELD_DRAG_TYPE = 'application/x-cut-pdf-field';
const PDF_PAGE = { width: 297, height: 210 };
const PDF_OLD_PAGE = { width: 842, height: 595 };
const PDF_QR_ERROR_CORRECTION_OPTIONS = [
  { value: 'L', label: 'L' },
  { value: 'M', label: 'M' },
  { value: 'Q', label: 'Q' },
  { value: 'H', label: 'H' },
];
const PDF_CUSTOM_FIELD_TYPE_OPTIONS: Array<{ value: CustomFieldSchemaRow['type']; label: string }> = [
  { value: 'string', label: 'Строка' },
  { value: 'number', label: 'Число' },
  { value: 'boolean', label: 'Да/нет' },
  { value: 'date', label: 'Дата' },
];
const PDF_FIELD_CATALOG: PdfFieldCatalogItem[] = [
  { id: 'job.name', source: 'job', label: 'Название задания', category: 'Задание', type: 'string' },
  { id: 'job.number', source: 'job', label: 'Номер задания', category: 'Задание', type: 'number' },
  { id: 'job.pdf_template', source: 'job', label: 'Шаблон PDF', category: 'Задание', type: 'string' },
  { id: 'group.number', source: 'group', label: 'Номер группы', category: 'Группа', type: 'number' },
  { id: 'group.material', source: 'group', label: 'Материал группы', category: 'Группа', type: 'string' },
  { id: 'group.film', source: 'group', label: 'Пленка группы', category: 'Группа', type: 'string' },
  { id: 'sheet.number', source: 'sheet', label: 'Номер листа', category: 'Лист', type: 'number' },
  { id: 'sheet.page_count', source: 'sheet', label: 'Количество листов', category: 'Лист', type: 'number' },
  { id: 'sheet.size', source: 'sheet', label: 'Размер листа', category: 'Лист', type: 'string' },
  { id: 'sheet.details_count', source: 'sheet', label: 'Количество деталей на листе', category: 'Лист', type: 'number' },
  { id: 'sheet.area', source: 'sheet', label: 'Площадь деталей', category: 'Лист', type: 'number' },
  { id: 'sheet.thumbnail', source: 'sheet', label: 'Миниатюра листа раскроя', category: 'Лист', type: 'string' },
  { id: 'order.unique_names', source: 'order', label: 'Заказы на листе', category: 'Заказ', type: 'string' },
  { id: 'order.date', source: 'order', label: 'Дата заказа', category: 'Заказ', type: 'date' },
  { id: 'order.ready_date', source: 'order', label: 'Дата готовности', category: 'Заказ', type: 'date' },
  { id: 'client.unique_names', source: 'client', label: 'Клиенты на листе', category: 'Клиент', type: 'string' },
  { id: 'detail.materials', source: 'detail', label: 'Материалы деталей', category: 'Детали', type: 'string' },
  { id: 'detail.films', source: 'detail', label: 'Пленки деталей', category: 'Детали', type: 'string' },
  { id: 'detail.thicknesses', source: 'detail', label: 'Толщины деталей', category: 'Детали', type: 'string' },
  { id: 'detail.table', source: 'detail', label: 'Таблица деталей', category: 'Детали', type: 'string' },
  { id: 'detail.row_number', source: 'detail', label: 'Номер строки', category: 'Таблица деталей', type: 'number' },
  { id: 'detail.order', source: 'detail', label: 'Заказ', category: 'Таблица деталей', type: 'string' },
  { id: 'detail.position', source: 'detail', label: 'Позиция', category: 'Таблица деталей', type: 'string' },
  { id: 'detail.lengthMm', source: 'detail', label: 'Длина', category: 'Таблица деталей', type: 'number' },
  { id: 'detail.widthMm', source: 'detail', label: 'Ширина', category: 'Таблица деталей', type: 'number' },
  { id: 'detail.quantity', source: 'detail', label: 'Количество', category: 'Таблица деталей', type: 'number' },
  { id: 'detail.material', source: 'detail', label: 'Материал', category: 'Таблица деталей', type: 'string' },
  { id: 'detail.film', source: 'detail', label: 'Пленка', category: 'Таблица деталей', type: 'string' },
  { id: 'detail.client', source: 'detail', label: 'Клиент', category: 'Таблица деталей', type: 'string' },
  { id: 'detail.orderDate', source: 'detail', label: 'Дата заказа', category: 'Таблица деталей', type: 'date' },
  { id: 'detail.readyDate', source: 'detail', label: 'Дата готовности', category: 'Таблица деталей', type: 'date' },
  { id: 'detail.thickness', source: 'detail', label: 'Толщина', category: 'Таблица деталей', type: 'number' },
  { id: 'computed.today', source: 'computed', label: 'Текущая дата', category: 'Вычисляемые', type: 'date' },
  { id: 'computed.page_number', source: 'computed', label: 'Номер страницы', category: 'Вычисляемые', type: 'number' },
  { id: 'computed.page_count', source: 'computed', label: 'Всего страниц', category: 'Вычисляемые', type: 'number' },
];
const PDF_PREVIEW_VALUES: Record<string, string> = {
  'job.name': 'Раскрой заказ 11380',
  'job.number': '19',
  'job.pdf_template': 'Профили ванны',
  'group.number': '1',
  'group.material': 'Ванна 2080x1050',
  'group.film': 'Крем брюле -Декор+',
  'sheet.number': '1',
  'sheet.page_count': '3',
  'sheet.size': '2080x1050',
  'sheet.details_count': '32',
  'sheet.area': '5.378 м.кв.',
  'sheet.thumbnail': '',
  'order.unique_names': '11380',
  'order.date': '03.07.2026',
  'order.ready_date': '10.07.2026',
  'client.unique_names': 'Тестовый клиент',
  'detail.materials': 'Ванна 2080x1050',
  'detail.films': 'Крем брюле -Декор+',
  'detail.thicknesses': '16',
  'detail.table': '#  Длина  Ширина  Кол-во',
  'detail.row_number': '1',
  'detail.order': '11380',
  'detail.position': '12',
  'detail.lengthMm': '800',
  'detail.widthMm': '240',
  'detail.quantity': '2',
  'detail.material': 'Ванна 2080x1050',
  'detail.film': 'Крем брюле -Декор+',
  'detail.client': 'Тестовый клиент',
  'detail.orderDate': '03.07.2026',
  'detail.readyDate': '10.07.2026',
  'detail.thickness': '16',
  'computed.today': '03.07.2026',
  'computed.page_number': '1',
  'computed.page_count': '3',
};
const DEFAULT_PDF_DETAIL_TABLE_COLUMNS: PdfDetailTableColumn[] = [
  { field: 'detail.row_number', label: '#', width: 0.55, visible: true },
  { field: 'detail.order', label: 'Заказ', width: 1.6, visible: true },
  { field: 'detail.position', label: 'Поз.', width: 0.9, visible: true },
  { field: 'detail.lengthMm', label: 'Длина', width: 1.1, visible: true },
  { field: 'detail.widthMm', label: 'Ширина', width: 1.1, visible: true },
  { field: 'detail.quantity', label: 'Кол-во', width: 0.9, visible: true },
];
const DEFAULT_PDF_ELEMENTS: PdfTemplateElement[] = [
  makePdfElement('field', { id: 'field-order', label: 'Заказ', source: 'order.unique_names', x: 12, y: 10, w: 84, h: 8, align: 'left' }),
  makePdfElement('field', { id: 'field-client', label: 'Клиент', source: 'client.unique_names', x: 108, y: 10, w: 78, h: 8, align: 'left' }),
  makePdfElement('field', { id: 'field-film', label: 'Пленка', source: 'detail.films', x: 198, y: 10, w: 84, h: 8, align: 'left' }),
  makePdfElement('line', { id: 'line-header', label: 'Линия шапки', x: 12, y: 22, w: 270, h: 0 }),
  makePdfElement('sheet_thumbnail', { id: 'sheet-thumbnail', label: 'Миниатюра листа', source: 'sheet.thumbnail', x: 12, y: 34, w: 202, h: 154 }),
  makePdfElement('detail_table', { id: 'detail-table', label: 'Таблица деталей', source: 'detail.table', x: 222, y: 34, w: 60, h: 78 }),
];

const PdfTemplateEditor: React.FC<PdfTemplateEditorProps> = ({ templates, canManage }) => {
  const [drafts, setDrafts] = useState<PdfTemplateDraft[]>(() => loadPdfTemplateDrafts(templates));
  const [savingDraft, setSavingDraft] = useState(false);
  const [selectedCode, setSelectedCode] = useState(() => templates[0]?.code ?? drafts[0]?.code ?? 'standard');
  const [fieldCatalog, setFieldCatalog] = useState<PdfFieldCatalogItem[]>(PDF_FIELD_CATALOG);
  const [fieldCatalogError, setFieldCatalogError] = useState<string | null>(null);
  const [editingCustomFieldId, setEditingCustomFieldId] = useState<string | null>(null);
  const selected = drafts.find((draft) => draft.code === selectedCode) ?? drafts[0];
  const [selectedElementId, setSelectedElementId] = useState<string | null>(selected?.elements[0]?.id ?? null);
  const [fieldSearch, setFieldSearch] = useState('');
  const [draggingField, setDraggingField] = useState<PdfFieldCatalogItem | null>(null);
  const [showAllBounds, setShowAllBounds] = useState(false);
  const [wideCanvas, setWideCanvas] = useState(false);
  const selectedElement = selected?.elements.find((element) => element.id === selectedElementId) ?? selected?.elements[0] ?? null;
  const customFields = selected?.customFields ?? [];
  const customFieldCatalog = useMemo<PdfFieldCatalogItem[]>(
    () => customFields.map((field) => ({
      id: customFieldSourceId(field.fieldId),
      source: 'custom',
      label: field.label || field.fieldId,
      category: 'Пользовательские',
      type: field.type,
    })),
    [customFields],
  );
  const fields = useMemo(() => [...customFieldCatalog, ...fieldCatalog], [customFieldCatalog, fieldCatalog]);
  const fieldLabels = useMemo(() => new Map(fields.map((field) => [field.id, field.label])), [fields]);
  const expressionFields = useMemo(() => toLabelExpressionFields(fields), [fields]);
  const allowedExpressionFieldIds = useMemo(() => new Set([
    ...fields.map((field) => field.id),
    ...customFields.map((field) => field.fieldId),
  ]), [customFields, fields]);
  const usedFieldIds = useMemo(() => new Set((selected?.elements ?? []).map((element) => element.source).filter(Boolean) as string[]), [selected]);
  const previewValues = useMemo(() => {
    const evaluated = evaluateCustomFieldPreviewValues(customFields, PDF_PREVIEW_VALUES);
    return {
      ...PDF_PREVIEW_VALUES,
      ...evaluated,
      ...Object.fromEntries(Object.entries(evaluated).map(([key, value]) => [customFieldSourceId(key), value])),
    };
  }, [customFields]);
  const editingCustomField = customFields.find((field) => field.fieldId === editingCustomFieldId) ?? null;

  useEffect(() => {
    let cancelled = false;
    cutConfigApi.listPdfTemplateFields()
      .then((rows) => {
        if (cancelled) return;
        setFieldCatalog(rows.length > 0 ? rows.map(normalizePdfFieldCatalogItem) : PDF_FIELD_CATALOG);
        setFieldCatalogError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setFieldCatalog(PDF_FIELD_CATALOG);
        setFieldCatalogError('Не удалось загрузить полный список полей; показан локальный минимум.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const patchElementById = useCallback(
    (id: string, patch: Partial<PdfTemplateElement>) => {
      if (!selected) return;
      updateSelected({
        ...selected,
        elements: selected.elements.map((element) => (element.id === id ? normalizePdfElement({ ...element, ...patch }) : element)),
      });
    },
    [selected, updateSelected],
  );

  const updateElement = useCallback(
    (patch: Partial<PdfTemplateElement>) => {
      if (!selectedElement) return;
      patchElementById(selectedElement.id, patch);
    },
    [patchElementById, selectedElement],
  );

  const addElement = useCallback(
    (type: PdfTemplateElementType, patch: Partial<PdfTemplateElement> = {}) => {
      if (!selected) return;
      const element = makePdfElement(type, {
        id: `${type}-${Date.now().toString(36)}`,
        zIndex: selected.elements.length,
        ...patch,
      });
      updateSelected({ ...selected, elements: [...selected.elements, element] });
      setSelectedElementId(element.id);
    },
    [selected, updateSelected],
  );

  const addFieldElement = useCallback(
    (field: PdfFieldCatalogItem, x = 24, y = 28) => {
      const type: PdfTemplateElementType = field.id === 'sheet.thumbnail'
        ? 'sheet_thumbnail'
        : field.id === 'detail.table'
          ? 'detail_table'
          : field.source === 'custom'
            ? 'custom'
            : 'field';
      addElement(type, {
        label: field.label,
        source: field.id,
        x,
        y,
        w: type === 'sheet_thumbnail' ? 150 : type === 'detail_table' ? 82 : Math.min(80, Math.max(34, field.label.length * 3.2)),
        h: type === 'sheet_thumbnail' ? 90 : type === 'detail_table' ? 64 : 8,
        align: 'left',
      });
    },
    [addElement],
  );

  const deleteElement = useCallback(
    (id: string) => {
      if (!selected) return;
      const nextElements = selected.elements.filter((element) => element.id !== id);
      updateSelected({ ...selected, elements: nextElements });
      setSelectedElementId(nextElements[0]?.id ?? null);
    },
    [selected, updateSelected],
  );

  const duplicateElement = useCallback(
    (id: string) => {
      if (!selected) return;
      const source = selected.elements.find((element) => element.id === id);
      if (!source) return;
      const copy = normalizePdfElement({
        ...source,
        id: `${source.type}-${Date.now().toString(36)}`,
        label: `${source.label} копия`,
        x: source.x + 4,
        y: source.y + 4,
        zIndex: selected.elements.length,
      });
      updateSelected({ ...selected, elements: [...selected.elements, copy] });
      setSelectedElementId(copy.id);
    },
    [selected, updateSelected],
  );

  const moveZ = useCallback(
    (id: string, direction: 'front' | 'back') => {
      if (!selected) return;
      const target = selected.elements.find((element) => element.id === id);
      if (!target) return;
      const ordered = selected.elements.filter((element) => element.id !== id).sort((a, b) => a.zIndex - b.zIndex);
      const next = direction === 'front' ? [...ordered, target] : [target, ...ordered];
      updateSelected({ ...selected, elements: next.map((element, index) => ({ ...element, zIndex: index })) });
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
      elements: selected.elements.map((element, index) => ({ ...element, id: `${element.id}-copy-${index}` })),
    };
    setDrafts((prev) => [...prev, copy]);
    setSelectedCode(code);
    setSelectedElementId(copy.elements[0]?.id ?? null);
  }, [selected]);

  const saveDrafts = useCallback(async () => {
    if (!selected) return;
    const template = templates.find((item) => item.code === selected.code);
    const layout = pdfDraftToLayout(selected);
    if (!template) {
      window.localStorage.setItem(PDF_TEMPLATE_DRAFTS_KEY, JSON.stringify(drafts.map((draft) => pdfDraftToStoredDraft(draft))));
      message.success('Локальная копия шаблона PDF сохранена');
      return;
    }
    setSavingDraft(true);
    try {
      const updated = await cutConfigApi.updatePdfTemplate(
        template.cutPdfTemplateId,
        { name: selected.name, layout, isActive: template.isActive },
        template.version,
      );
      setDrafts((prev) => prev.map((draft) => (draft.code === updated.code ? pdfTemplateToDraft(updated) : draft)));
      message.success('Шаблон PDF сохранён');
    } catch (error) {
      message.error(formatPdfTemplateSaveError(error));
    } finally {
      setSavingDraft(false);
    }
  }, [drafts, selected, templates]);

  const addCustomField = useCallback(() => {
    if (!selected) return;
    const fieldId = `custom.field_${selected.customFields.length + 1}`;
    updateSelected({
      ...selected,
      customFields: [...selected.customFields, {
        fieldId,
        label: 'Новое поле',
        type: 'string',
        valueMode: 'source',
        sourceField: fieldCatalog[0]?.id ?? null,
        defaultValue: '',
        expression: null,
        extra: {},
      }],
    });
  }, [fieldCatalog, selected, updateSelected]);

  const patchCustomField = useCallback(
    (fieldId: string, patch: Partial<CustomFieldSchemaRow>) => {
      if (!selected) return;
      updateSelected({
        ...selected,
        customFields: selected.customFields.map((field) => (field.fieldId === fieldId ? { ...field, ...patch } : field)),
      });
    },
    [selected, updateSelected],
  );

  const setCustomFieldValueMode = useCallback(
    (field: CustomFieldSchemaRow, valueMode: CustomFieldSchemaRow['valueMode']) => {
      if (valueMode === 'expression') {
        patchCustomField(field.fieldId, {
          valueMode,
          type: 'string',
          expression: field.expression ?? { type: 'custom_expression', version: 1, root: defaultCustomExpressionNode(fieldCatalog[0]?.id ?? '') },
        });
        return;
      }
      patchCustomField(field.fieldId, {
        valueMode,
        expression: null,
        sourceField: valueMode === 'source' ? field.sourceField ?? fieldCatalog[0]?.id ?? null : field.sourceField,
      });
    },
    [fieldCatalog, patchCustomField],
  );

  const removeCustomField = useCallback(
    (fieldId: string) => {
      if (!selected) return;
      updateSelected({ ...selected, customFields: selected.customFields.filter((field) => field.fieldId !== fieldId) });
    },
    [selected, updateSelected],
  );

  if (!selected) {
    return <Alert type="warning" showIcon message="Нет активных шаблонов PDF" />;
  }

  const elementRows: ColumnsType<PdfTemplateElement> = [
    { title: 'Элемент', dataIndex: 'label', key: 'label' },
    {
      title: 'Тип',
      dataIndex: 'type',
      key: 'type',
      width: 112,
      render: (type: PdfTemplateElementType) => pdfElementTypeLabel(type),
    },
    {
      title: 'Данные',
      dataIndex: 'source',
      key: 'source',
      width: 180,
      render: (source: string | null) => source ? (fields.find((field) => field.id === source)?.label ?? source) : null,
    },
  ];

  const renderFieldPanel = () => (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small" title="Поля карты раскроя PDF">
        {fieldCatalogError && <Alert type="warning" showIcon message={fieldCatalogError} style={{ marginBottom: 8 }} />}
        <PdfFieldPalette
          fields={fields}
          usedFieldIds={usedFieldIds}
          disabled={!canManage}
          search={fieldSearch}
          onSearch={setFieldSearch}
          onBeginDrag={setDraggingField}
          onEndDrag={() => setDraggingField(null)}
          onAddField={addFieldElement}
        />
      </Card>
      <Collapse>
        <Panel header="Пользовательские поля" key="custom-fields">
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Button size="small" icon={<PlusOutlined />} disabled={!canManage} onClick={addCustomField}>
              Добавить поле
            </Button>
            <Table<CustomFieldSchemaRow>
              rowKey="fieldId"
              size="small"
              pagination={false}
              dataSource={customFields}
              columns={[
                {
                  title: 'Ключ',
                  width: 116,
                  render: (_, row) => (
                    <Input size="small" value={row.fieldId} disabled={!canManage} onChange={(event) => patchCustomField(row.fieldId, { fieldId: event.target.value.trim() })} />
                  ),
                },
                {
                  title: 'Название',
                  render: (_, row) => <Input size="small" value={row.label} disabled={!canManage} onChange={(event) => patchCustomField(row.fieldId, { label: event.target.value })} />,
                },
                {
                  title: 'Тип',
                  width: 92,
                  render: (_, row) => (
                    <Select
                      size="small"
                      value={row.type}
                      disabled={!canManage || row.valueMode === 'expression'}
                      options={PDF_CUSTOM_FIELD_TYPE_OPTIONS}
                      onChange={(type) => patchCustomField(row.fieldId, { type })}
                    />
                  ),
                },
                {
                  title: 'Значение',
                  render: (_, row) => (
                    <Space direction="vertical" size={4} style={{ width: '100%' }}>
                      <Select
                        size="small"
                        value={row.valueMode}
                        disabled={!canManage}
                        options={[
                          { value: 'source', label: 'Из поля' },
                          { value: 'constant', label: 'Константа' },
                          { value: 'expression', label: 'Формула' },
                        ]}
                        onChange={(valueMode) => setCustomFieldValueMode(row, valueMode)}
                      />
                      {row.valueMode === 'source' && (
                        <Select
                          showSearch
                          size="small"
                          value={row.sourceField ?? undefined}
                          disabled={!canManage}
                          options={fieldCatalog.map((field) => ({ value: field.id, label: `${field.category}: ${field.label}` }))}
                          onChange={(sourceField) => patchCustomField(row.fieldId, { sourceField })}
                        />
                      )}
                      {row.valueMode === 'constant' && (
                        <Input
                          size="small"
                          value={String(row.defaultValue ?? '')}
                          disabled={!canManage}
                          onChange={(event) => patchCustomField(row.fieldId, { defaultValue: event.target.value })}
                        />
                      )}
                      {row.valueMode === 'expression' && (
                        <Space size={4} wrap>
                          <Button size="small" disabled={!canManage} onClick={() => setEditingCustomFieldId(row.fieldId)}>
                            Формула
                          </Button>
                          {row.expression && !isCustomFieldExpressionValid(row.expression, allowedExpressionFieldIds) && <Tag color="error">Ошибка</Tag>}
                          {row.expression && <Text type="secondary">{summarizeCustomFieldExpression(row.expression, fieldLabels)}</Text>}
                        </Space>
                      )}
                    </Space>
                  ),
                },
                {
                  title: '',
                  width: 38,
                  render: (_, row) => <Button size="small" danger icon={<DeleteOutlined />} disabled={!canManage} onClick={() => removeCustomField(row.fieldId)} />,
                },
              ]}
            />
          </Space>
        </Panel>
      </Collapse>
    </Space>
  );

  const renderElementPanel = () => (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Table<PdfTemplateElement>
        size="small"
        rowKey="id"
        columns={elementRows}
        dataSource={selected.elements.slice().sort((a, b) => a.zIndex - b.zIndex)}
        pagination={false}
        scroll={{ y: wideCanvas ? 320 : 260 }}
        rowClassName={(row) => (row.id === selectedElement?.id ? 'ant-table-row-selected' : '')}
        onRow={(row) => ({ onClick: () => setSelectedElementId(row.id), style: { cursor: 'pointer' } })}
      />
      {selectedElement && (
        <PdfElementProperties
          element={selectedElement}
          fields={fields}
          canManage={canManage}
          onPatch={updateElement}
          onDelete={() => deleteElement(selectedElement.id)}
        />
      )}
    </Space>
  );

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
          style={{ width: 320 }}
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
        <Button icon={<PlusOutlined />} disabled={!canManage} onClick={() => addElement('text')}>
          Текст
        </Button>
        <Button icon={<PlusOutlined />} disabled={!canManage} onClick={() => addElement('field')}>
          Поле
        </Button>
        <Button icon={<QrcodeOutlined />} disabled={!canManage} onClick={() => addElement('qr')}>
          QR-код
        </Button>
        <Button icon={<PictureOutlined />} disabled={!canManage} onClick={() => addElement('sheet_thumbnail')}>
          Миниатюра листа
        </Button>
        <Button icon={<TableOutlined />} disabled={!canManage} onClick={() => addElement('detail_table')}>
          Таблица деталей
        </Button>
        <Button icon={<MinusOutlined />} disabled={!canManage} onClick={() => addElement('line')}>
          Линия
        </Button>
        <Button icon={<BorderOutlined />} disabled={!canManage} onClick={() => addElement('rect')}>
          Прямоугольник
        </Button>
      </Space>

      <Row gutter={[16, 16]} align="top">
        {!wideCanvas && (
          <Col xs={24} xl={6}>
            {renderFieldPanel()}
          </Col>
        )}
        <Col xs={24} xl={wideCanvas ? 24 : 12}>
          <Card
            size="small"
            title="Визуал карты раскроя PDF"
            extra={(
              <Space size={12} wrap>
                <Checkbox checked={wideCanvas} onChange={(event) => setWideCanvas(event.target.checked)}>
                  Широкий визуал
                </Checkbox>
                <Checkbox checked={showAllBounds} onChange={(event) => setShowAllBounds(event.target.checked)}>
                  Границы
                </Checkbox>
              </Space>
            )}
          >
            <PdfTemplateCanvas
              draft={selected}
              fields={fields}
              previewValues={previewValues}
              selectedElementId={selectedElementId}
              canManage={canManage}
              showAllBounds={showAllBounds}
              wideCanvas={wideCanvas}
              draggingField={draggingField}
              onSelect={setSelectedElementId}
              onPatch={patchElementById}
              onDelete={deleteElement}
              onDuplicate={duplicateElement}
              onMoveZ={moveZ}
              onDropField={(field, x, y) => {
                addFieldElement(field, x, y);
                setDraggingField(null);
              }}
            />
          </Card>
        </Col>
        {!wideCanvas && (
          <Col xs={24} xl={6}>
            {renderElementPanel()}
          </Col>
        )}
        {wideCanvas && (
          <>
            <Col xs={24} xl={12}>
              {renderFieldPanel()}
            </Col>
            <Col xs={24} xl={12}>
              {renderElementPanel()}
            </Col>
          </>
        )}
      </Row>
      <Modal
        title={editingCustomField ? `Формула: ${editingCustomField.label || editingCustomField.fieldId}` : 'Формула'}
        open={Boolean(editingCustomField)}
        onCancel={() => setEditingCustomFieldId(null)}
        onOk={() => setEditingCustomFieldId(null)}
        width={820}
        destroyOnClose
      >
        {editingCustomField && (
          <CustomFieldExpressionEditor
            value={editingCustomField.expression?.root ?? defaultCustomExpressionNode(fieldCatalog[0]?.id ?? '')}
            fields={expressionFields}
            disabled={!canManage}
            onChange={(root) => patchCustomField(editingCustomField.fieldId, {
              valueMode: 'expression',
              type: 'string',
              expression: { type: 'custom_expression', version: 1, root },
            })}
          />
        )}
      </Modal>
    </Space>
  );
};

const PdfTemplateCanvas: React.FC<{
  draft: PdfTemplateDraft;
  fields: PdfFieldCatalogItem[];
  previewValues: Record<string, string>;
  selectedElementId: string | null;
  canManage: boolean;
  showAllBounds: boolean;
  wideCanvas: boolean;
  draggingField: PdfFieldCatalogItem | null;
  onSelect: (id: string | null) => void;
  onPatch: (id: string, patch: Partial<PdfTemplateElement>) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onMoveZ: (id: string, direction: 'front' | 'back') => void;
  onDropField: (field: PdfFieldCatalogItem, x: number, y: number) => void;
}> = ({ draft, fields, previewValues, selectedElementId, canManage, showAllBounds, wideCanvas, draggingField, onSelect, onPatch, onDelete, onDuplicate, onMoveZ, onDropField }) => {
  const stageRef = useRef<Konva.Stage | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const nodeRefs = useRef(new Map<string, Konva.Node>());
  const [zoom, setZoom] = useState(1);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [showGrid, setShowGrid] = useState(false);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [contextMenu, setContextMenu] = useState<{ element: PdfTemplateElement; x: number; y: number } | null>(null);
  const page = draft.page;
  const defaultPreviewBaseWidth = Math.min(900, Math.max(520, page.width * 3));
  const widePreviewBaseWidth = viewportWidth > 0 ? Math.max(320, viewportWidth) : defaultPreviewBaseWidth;
  const previewWidth = Math.round((wideCanvas ? widePreviewBaseWidth : defaultPreviewBaseWidth) * zoom);
  const previewHeight = previewWidth * (page.height / page.width);
  const selected = draft.elements.find((element) => element.id === selectedElementId) ?? null;
  const selectedLocked = Boolean(selected?.style.locked);
  const fieldLabels = useMemo(() => new Map(fields.map((field) => [field.id, field.label])), [fields]);
  const sorted = draft.elements.slice().sort((a, b) => a.zIndex - b.zIndex);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    setViewportWidth(Math.round(node.getBoundingClientRect().width));
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      setViewportWidth(Math.round(entries[0]?.contentRect.width ?? 0));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!canManage || !selectedElementId || selectedLocked || draggingField) {
      transformerRef.current?.nodes([]);
      transformerRef.current?.getLayer()?.batchDraw();
      return;
    }
    const node = nodeRefs.current.get(selectedElementId);
    transformerRef.current?.nodes(node ? [node] : []);
    transformerRef.current?.getLayer()?.batchDraw();
  }, [canManage, draft.elements, draggingField, selectedElementId, selectedLocked]);

  const pointFromEvent = (event: Pick<React.MouseEvent<Element> | React.DragEvent<Element>, 'clientX' | 'clientY'>) => {
    const container = stageRef.current?.container();
    if (!container) return { x: 0, y: 0 };
    const rect = container.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * page.width,
      y: ((event.clientY - rect.top) / rect.height) * page.height,
    };
  };
  const snap = (value: number, free?: boolean) => (snapToGrid && !free ? Math.round(value) : value);
  const patchGeometry = (element: PdfTemplateElement, patch: Partial<PdfTemplateElement>, free?: boolean) => {
    onPatch(element.id, {
      ...patch,
      x: patch.x === undefined ? undefined : roundPdfMm(clamp(snap(patch.x, free), 0, page.width)),
      y: patch.y === undefined ? undefined : roundPdfMm(clamp(snap(patch.y, free), 0, page.height)),
      w: patch.w === undefined ? undefined : roundPdfMm(Math.max(0.5, snap(patch.w, free))),
      h: patch.h === undefined ? undefined : roundPdfMm(Math.max(element.type === 'line' ? 0 : 0.5, snap(patch.h, free))),
      rotation: patch.rotation === undefined ? undefined : roundPdfMm(patch.rotation),
    });
  };
  const moveElement = (element: PdfTemplateElement, x: number, y: number, event?: { altKey?: boolean }) => {
    if (element.style.locked) return;
    patchGeometry(element, {
      x: clamp(x, 0, Math.max(0, page.width - element.w)),
      y: clamp(y, 0, Math.max(0, page.height - Math.max(element.h, 1))),
    }, event?.altKey);
  };
  const transformEnd = (element: PdfTemplateElement, node: Konva.Node, event: Konva.KonvaEventObject<Event>) => {
    if (element.style.locked) return;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    node.scaleX(1);
    node.scaleY(1);
    const nextW = element.type === 'line' ? element.w * scaleX : Math.max(1, Number(node.width() || element.w) * scaleX);
    const nextH = element.type === 'line' ? element.h * scaleY : Math.max(1, Number(node.height() || element.h) * scaleY);
    patchGeometry(element, {
      x: clamp(node.x(), 0, page.width),
      y: clamp(node.y(), 0, page.height),
      w: nextW,
      h: nextH,
      rotation: Number(node.rotation() ?? 0),
    }, (event.evt as MouseEvent | PointerEvent | undefined)?.altKey);
  };
  const openContextMenu = (point: { x: number; y: number }) => {
    if (!canManage) return;
    const element = findTopPdfElement(sorted, point.x, point.y);
    if (!element) {
      setContextMenu(null);
      return;
    }
    onSelect(element.id);
    setContextMenu({ element, x: (point.x / page.width) * previewWidth, y: (point.y / page.height) * previewHeight });
  };
  const keyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!selected || !canManage) return;
    if ((event.key === 'Delete' || event.key === 'Backspace') && !selected.style.locked) {
      event.preventDefault();
      onDelete(selected.id);
      return;
    }
    const map: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const delta = map[event.key];
    if (!delta) return;
    event.preventDefault();
    const step = event.shiftKey ? 5 : 1;
    moveElement(selected, selected.x + delta[0] * step, selected.y + delta[1] * step, event);
  };

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space wrap>
        <Space size={6}><Text type="secondary">Сетка</Text><Switch size="small" checked={showGrid} onChange={setShowGrid} /></Space>
        <Space size={6}><Text type="secondary">Привязка</Text><Switch size="small" checked={snapToGrid} onChange={setSnapToGrid} /></Space>
        <Button size="small" onClick={() => setZoom((value) => clamp(Math.round((value - 0.1) * 10) / 10, 0.5, 2.2))}>-</Button>
        <Text>{Math.round(zoom * 100)}%</Text>
        <Button size="small" onClick={() => setZoom((value) => clamp(Math.round((value + 0.1) * 10) / 10, 0.5, 2.2))}>+</Button>
        <Button size="small" onClick={() => setZoom(1)}>100%</Button>
      </Space>
      <div
        ref={viewportRef}
        style={{
          width: '100%',
          overflowX: wideCanvas ? 'auto' : 'hidden',
          overflowY: 'hidden',
          paddingBottom: wideCanvas ? 8 : 0,
        }}
      >
        <div
          role="img"
          aria-label="Редактор шаблона карты раскроя PDF"
          tabIndex={canManage ? 0 : undefined}
          style={{
            width: wideCanvas ? previewWidth : '100%',
            maxWidth: wideCanvas ? undefined : previewWidth,
            aspectRatio: `${page.width} / ${page.height}`,
            background: '#fff',
            border: '1px solid #d9d9d9',
            boxShadow: '0 1px 2px rgba(0,0,0,0.08), 0 12px 32px rgba(15,23,42,0.08)',
            overflow: 'hidden',
            position: 'relative',
            outline: 'none',
          }}
          onDragOver={(event) => {
            if (!canManage || (!draggingField && !isCutPdfFieldDragEvent(event))) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={(event) => {
            if (!canManage) return;
            const field = resolveDroppedPdfField(fields, event, draggingField);
            if (!field) return;
            event.preventDefault();
            const point = pointFromEvent(event);
            onDropField(field, clamp(point.x, 0, page.width - 1), clamp(point.y, 0, page.height - 1));
          }}
          onKeyDown={keyDown}
          onContextMenu={(event) => {
            event.preventDefault();
            openContextMenu(pointFromEvent(event));
          }}
        >
          <Stage
            ref={stageRef}
            width={previewWidth}
            height={previewHeight}
            scaleX={previewWidth / page.width}
            scaleY={previewHeight / page.height}
            onMouseDown={(event) => {
              if (event.target === event.target.getStage()) onSelect(null);
              if (event.evt.button === 2) {
                event.evt.preventDefault();
                const pointer = event.target.getStage()?.getPointerPosition();
                if (pointer) openContextMenu({ x: (pointer.x / previewWidth) * page.width, y: (pointer.y / previewHeight) * page.height });
              }
            }}
            onWheel={(event) => {
              if (!event.evt.ctrlKey) return;
              event.evt.preventDefault();
              setZoom((value) => clamp(Math.round((value + (event.evt.deltaY > 0 ? -0.1 : 0.1)) * 10) / 10, 0.5, 2.2));
            }}
          >
            <Layer>
              <KonvaRect x={0} y={0} width={page.width} height={page.height} fill="#fff" listening={false} />
              {showGrid && renderPdfGrid(page.width, page.height)}
              {sorted.map((element) => (
                <PdfKonvaElement
                  key={element.id}
                  element={element}
                  fieldLabels={fieldLabels}
                  previewValues={previewValues}
                  selected={element.id === selectedElementId}
                  interactive={canManage && !draggingField}
                  showAllBounds={showAllBounds}
                  nodeRef={(node) => {
                    if (node) nodeRefs.current.set(element.id, node);
                    else nodeRefs.current.delete(element.id);
                  }}
                  onSelect={() => onSelect(element.id)}
                  onMove={(x, y, event) => moveElement(element, x, y, event)}
                  onTransformEnd={(node, event) => transformEnd(element, node, event)}
                />
              ))}
              {canManage && !draggingField && (
                <Transformer
                  ref={transformerRef}
                  rotateEnabled
                  enabledAnchors={selected?.type === 'line' ? ['middle-left', 'middle-right'] : undefined}
                  boundBoxFunc={(oldBox, newBox) => (newBox.width < 2 || newBox.height < 2 ? oldBox : newBox)}
                />
              )}
            </Layer>
          </Stage>
          {contextMenu && (
            <div
              style={{
                position: 'absolute',
                left: Math.min(contextMenu.x + 6, Math.max(8, previewWidth - 190)),
                top: Math.min(contextMenu.y + 6, Math.max(8, previewHeight - 216)),
                zIndex: 3,
                minWidth: 180,
                padding: 4,
                background: '#fff',
                border: '1px solid #d9d9d9',
                borderRadius: 4,
                boxShadow: '0 6px 16px rgba(0,0,0,0.16)',
              }}
              onMouseLeave={() => setContextMenu(null)}
            >
              <Button type="text" size="small" block onClick={() => { onPatch(contextMenu.element.id, { style: { ...contextMenu.element.style, locked: !contextMenu.element.style.locked } }); setContextMenu(null); }}>
                {contextMenu.element.style.locked ? 'Разблокировать' : 'Заблокировать'}
              </Button>
              <Button type="text" size="small" block onClick={() => { onDuplicate(contextMenu.element.id); setContextMenu(null); }}>Сделать копию</Button>
              <Button type="text" size="small" block onClick={() => { onMoveZ(contextMenu.element.id, 'front'); setContextMenu(null); }}>На передний план</Button>
              <Button type="text" size="small" block onClick={() => { onMoveZ(contextMenu.element.id, 'back'); setContextMenu(null); }}>На задний план</Button>
              <Button danger type="text" size="small" block onClick={() => { onDelete(contextMenu.element.id); setContextMenu(null); }}>Удалить</Button>
            </div>
          )}
        </div>
      </div>
    </Space>
  );
};

const PdfKonvaElement: React.FC<{
  element: PdfTemplateElement;
  fieldLabels: Map<string, string>;
  previewValues: Record<string, string>;
  selected: boolean;
  interactive: boolean;
  showAllBounds: boolean;
  nodeRef: (node: Konva.Node | null) => void;
  onSelect: () => void;
  onMove: (x: number, y: number, event?: { altKey?: boolean }) => void;
  onTransformEnd: (node: Konva.Node, event: Konva.KonvaEventObject<Event>) => void;
}> = ({ element, fieldLabels, previewValues, selected, interactive, showAllBounds, nodeRef, onSelect, onMove, onTransformEnd }) => {
  const common = {
    ref: nodeRef,
    x: element.x,
    y: element.y,
    rotation: element.rotation,
    listening: interactive,
    draggable: interactive && !element.style.locked,
    onClick: onSelect,
    onTap: onSelect,
    onDragStart: onSelect,
    onDragEnd: (event: Konva.KonvaEventObject<DragEvent>) => onMove(event.target.x(), event.target.y(), event.evt),
    onTransformEnd: (event: Konva.KonvaEventObject<Event>) => onTransformEnd(event.target, event),
    onMouseEnter: (event: Konva.KonvaEventObject<MouseEvent>) => event.target.getStage()?.container().style.setProperty('cursor', interactive ? 'move' : 'default'),
    onMouseLeave: (event: Konva.KonvaEventObject<MouseEvent>) => event.target.getStage()?.container().style.setProperty('cursor', 'default'),
  };
  const selectedBox = selected ? <KonvaRect x={element.x} y={element.y} width={Math.max(element.w, 1)} height={Math.max(element.h, 1)} stroke="#1677ff" strokeWidth={0.25} dash={[1, 1]} listening={false} /> : null;
  const boundsBox = showAllBounds ? <KonvaRect x={element.x} y={element.y} width={Math.max(element.w, 1)} height={Math.max(element.h, 1)} stroke="#faad14" strokeWidth={0.2} dash={[1, 1]} listening={false} /> : null;
  if (element.type === 'line') {
    return (
      <React.Fragment>
        <KonvaLine {...common} points={[0, 0, element.w, element.h]} stroke={String(element.style.color ?? '#111111')} strokeWidth={Number(element.style.strokeWidth ?? 0.35)} hitStrokeWidth={3} />
        {selectedBox}
        {boundsBox}
      </React.Fragment>
    );
  }
  if (element.type === 'rect') {
    return (
      <React.Fragment>
        <KonvaRect {...common} width={Math.max(element.w, 1)} height={Math.max(element.h, 1)} fill={String(element.style.fill ?? 'transparent')} stroke={String(element.style.color ?? '#111111')} strokeWidth={Number(element.style.strokeWidth ?? 0.35)} />
        {selectedBox}
        {boundsBox}
      </React.Fragment>
    );
  }
  if (element.type === 'sheet_thumbnail') {
    const w = Math.max(element.w, 1);
    const h = Math.max(element.h, 1);
    const pieceColor = ['#e6f4ff', '#fff1f0', '#f6ffed', '#fffbe6'];
    const pieces = [
      { x: w * 0.07, y: h * 0.08, w: w * 0.34, h: h * 0.24 },
      { x: w * 0.45, y: h * 0.08, w: w * 0.46, h: h * 0.18 },
      { x: w * 0.08, y: h * 0.38, w: w * 0.26, h: h * 0.48 },
      { x: w * 0.39, y: h * 0.35, w: w * 0.52, h: h * 0.38 },
    ];
    return (
      <React.Fragment>
        <KonvaGroup {...common} width={w} height={h}>
          <KonvaRect x={0} y={0} width={w} height={h} fill="#ffffff" stroke={String(element.style.color ?? '#111111')} strokeWidth={Number(element.style.strokeWidth ?? 0.25)} />
          {pieces.map((piece, index) => (
            <KonvaRect key={index} x={piece.x} y={piece.y} width={piece.w} height={piece.h} fill={pieceColor[index % pieceColor.length]} stroke="#334155" strokeWidth={0.18} listening={false} />
          ))}
        </KonvaGroup>
        {selectedBox}
        {boundsBox}
      </React.Fragment>
    );
  }
  if (element.type === 'detail_table') {
    const w = Math.max(element.w, 1);
    const h = Math.max(element.h, 1);
    const columns = readPdfDetailTableColumns(element.style);
    const headerH = Math.min(7, h * 0.22);
    const rowH = Math.max(4.5, Math.min(7, (h - headerH) / 4));
    const totalWidth = columns.reduce((sum, column) => sum + column.width, 0) || 1;
    let x = 0;
    return (
      <React.Fragment>
        <KonvaGroup {...common} width={w} height={h}>
          <KonvaRect x={0} y={0} width={w} height={h} fill="#ffffff" stroke={String(element.style.color ?? '#111111')} strokeWidth={0.22} />
          {columns.map((column, index) => {
            const colW = (w * column.width) / totalWidth;
            const cx = x;
            x += colW;
            return (
              <React.Fragment key={column.field}>
                <KonvaRect x={cx} y={0} width={colW} height={headerH} fill="#f5f5f5" stroke="#111111" strokeWidth={0.16} listening={false} />
                <KonvaText x={cx + 0.8} y={1} width={Math.max(1, colW - 1.6)} height={headerH - 1} text={column.label} fontFamily="Arial" fontSize={Math.max(2.2, Math.min(3.4, headerH * 0.42))} align="center" wrap="word" ellipsis listening={false} />
                {[0, 1, 2].map((rowIndex) => (
                  <KonvaRect key={`${column.field}-${rowIndex}`} x={cx} y={headerH + rowIndex * rowH} width={colW} height={rowH} fill="#ffffff" stroke="#111111" strokeWidth={0.12} listening={false} />
                ))}
                {[0, 1, 2].map((rowIndex) => (
                  <KonvaText key={`${column.field}-txt-${rowIndex}`} x={cx + 0.8} y={headerH + rowIndex * rowH + 1} width={Math.max(1, colW - 1.6)} height={rowH - 1} text={pdfDetailTablePreviewValue(column.field, rowIndex)} fontFamily="Arial" fontSize={Math.max(2, Math.min(3, rowH * 0.42))} align="center" wrap="word" ellipsis listening={false} />
                ))}
                {index === columns.length - 1 ? null : <KonvaLine points={[x, 0, x, h]} stroke="#111111" strokeWidth={0.12} listening={false} />}
              </React.Fragment>
            );
          })}
        </KonvaGroup>
        {selectedBox}
        {boundsBox}
      </React.Fragment>
    );
  }
  if (element.type === 'qr') {
    const side = Math.max(element.w, element.h, 8);
    const moduleSide = side / 7;
    const modules = [[0, 0], [1, 0], [2, 0], [4, 0], [5, 0], [6, 0], [0, 1], [2, 1], [3, 1], [6, 1], [0, 2], [1, 2], [2, 2], [4, 2], [6, 2], [3, 3], [5, 3], [0, 4], [2, 4], [4, 4], [5, 4], [6, 4], [0, 5], [3, 5], [6, 5], [0, 6], [1, 6], [2, 6], [4, 6], [6, 6]];
    return (
      <React.Fragment>
        <KonvaGroup {...common} width={side} height={side}>
          <KonvaRect x={0} y={0} width={side} height={side} fill="#fff" stroke="#111" strokeWidth={0.25} />
          {modules.map(([col, row], index) => <KonvaRect key={index} x={col * moduleSide} y={row * moduleSide} width={moduleSide} height={moduleSide} fill="#111" listening={false} />)}
          <KonvaText x={0} y={side / 2 - 2} width={side} height={4} text="QR" fontFamily="Arial" fontSize={Math.max(2, side * 0.18)} fill="#1677ff" align="center" listening={false} />
        </KonvaGroup>
        {selectedBox}
        {boundsBox}
      </React.Fragment>
    );
  }
  const fontSize = Math.max(2, Number(element.style.fontSize ?? 10) * 0.35);
  const value = element.type === 'text'
    ? element.text ?? ''
    : element.source
    ? previewValues[element.source] ?? fieldLabels.get(element.source) ?? element.source
    : '';
  return (
    <React.Fragment>
      <KonvaText
        {...common}
        width={Math.max(element.w, 1)}
        height={Math.max(element.h, fontSize + 1)}
        text={value}
        fontFamily="Arial"
        fontSize={fontSize}
        fontStyle={element.style.fontWeight === 'bold' ? 'bold' : 'normal'}
        fill={String(element.style.color ?? '#111111')}
        align={element.align}
        wrap="word"
        ellipsis
      />
      {selectedBox}
      {boundsBox}
    </React.Fragment>
  );
};

const PdfFieldPalette: React.FC<{
  fields: PdfFieldCatalogItem[];
  usedFieldIds: Set<string>;
  disabled: boolean;
  search: string;
  onSearch: (value: string) => void;
  onBeginDrag: (field: PdfFieldCatalogItem) => void;
  onEndDrag: () => void;
  onAddField: (field: PdfFieldCatalogItem) => void;
}> = ({ fields, usedFieldIds, disabled, search, onSearch, onBeginDrag, onEndDrag, onAddField }) => {
  const normalized = search.trim().toLowerCase();
  const visible = fields.filter((field) => !normalized || `${field.category} ${field.label} ${field.id}`.toLowerCase().includes(normalized));
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Input.Search value={search} onChange={(event) => onSearch(event.target.value)} allowClear />
      <div style={{ maxHeight: 420, overflowY: 'auto', paddingRight: 4 }}>
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {groupPdfFields(visible).map(([category, rows]) => (
            <div key={category}>
              <Text type="secondary">{category}</Text>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                {rows.map((field) => {
                  const used = usedFieldIds.has(field.id);
                  return (
                    <Tag
                      key={field.id}
                      color={used ? 'processing' : undefined}
                      draggable={!disabled}
                      onDragStart={(event) => {
                        if (disabled) return;
                        onBeginDrag(field);
                        event.dataTransfer.setData(CUT_PDF_FIELD_DRAG_TYPE, field.id);
                        event.dataTransfer.effectAllowed = 'copy';
                      }}
                      onDragEnd={onEndDrag}
                      onDoubleClick={() => {
                        if (!disabled) onAddField(field);
                      }}
                      style={{ cursor: disabled ? 'default' : 'grab', userSelect: 'none', fontWeight: used ? 600 : 400 }}
                    >
                      {field.label}
                    </Tag>
                  );
                })}
              </div>
            </div>
          ))}
        </Space>
      </div>
    </Space>
  );
};

const PdfElementProperties: React.FC<{
  element: PdfTemplateElement;
  fields: PdfFieldCatalogItem[];
  canManage: boolean;
  onPatch: (patch: Partial<PdfTemplateElement>) => void;
  onDelete: () => void;
}> = ({ element, fields, canManage, onPatch, onDelete }) => {
  const style = element.style;
  const tableFields = fields.filter((field) => field.category === 'Таблица деталей' && field.id !== 'detail.table');
  const tableColumns = readPdfDetailTableColumns(style, true);
  const tableSort = readPdfDetailTableSort(style);
  const patchStyle = (patch: Record<string, unknown>) => onPatch({ style: { ...style, ...patch } });
  const patchTableColumn = (index: number, patch: Partial<PdfDetailTableColumn>) => {
    patchStyle({ columns: tableColumns.map((column, columnIndex) => (columnIndex === index ? { ...column, ...patch } : column)) });
  };
  const removeTableColumn = (index: number) => {
    patchStyle({ columns: tableColumns.filter((_, columnIndex) => columnIndex !== index) });
  };
  return (
    <Card size="small" title="Свойства элемента" extra={<Button size="small" danger icon={<DeleteOutlined />} disabled={!canManage} onClick={onDelete} />}>
      <Form layout="vertical">
        <Form.Item label="Название" style={{ marginBottom: 10 }}>
          <Input value={element.label} onChange={(event) => onPatch({ label: event.target.value })} disabled={!canManage} />
        </Form.Item>
        <Form.Item label="Тип" style={{ marginBottom: 10 }}>
          <Select
            value={element.type}
            disabled={!canManage}
            onChange={(type) => onPatch({ type, ...defaultPatchForType(type) })}
            options={[
              { value: 'text', label: 'Текст' },
              { value: 'field', label: 'Динамическое поле' },
              { value: 'custom', label: 'Пользовательское поле' },
              { value: 'qr', label: 'QR-код' },
              { value: 'sheet_thumbnail', label: 'Миниатюра листа' },
              { value: 'detail_table', label: 'Таблица деталей' },
              { value: 'line', label: 'Линия' },
              { value: 'rect', label: 'Прямоугольник' },
            ]}
          />
        </Form.Item>
        {(element.type === 'field' || element.type === 'custom') && (
          <Form.Item label="Данные" style={{ marginBottom: 10 }}>
            <Select
              showSearch
              value={element.source ?? undefined}
              onChange={(source) => onPatch({ source })}
              options={fields.map((field) => ({ value: field.id, label: `${field.category}: ${field.label}` }))}
              disabled={!canManage}
            />
          </Form.Item>
        )}
        {element.type === 'text' && (
          <Form.Item label="Текст" style={{ marginBottom: 10 }}>
            <Input.TextArea value={element.text ?? ''} onChange={(event) => onPatch({ text: event.target.value })} disabled={!canManage} autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
        )}
        {element.type === 'qr' && (
          <>
            <Form.Item label="Имя QR" style={{ marginBottom: 10 }}>
              <Input value={String(style.qrName ?? '')} disabled={!canManage} onChange={(event) => onPatch({ style: { ...style, qrName: event.target.value } })} />
            </Form.Item>
            <Form.Item label="QR шаблон" style={{ marginBottom: 10 }}>
              <Input.TextArea value={String(style.qrTemplate ?? '')} disabled={!canManage} onChange={(event) => onPatch({ style: { ...style, qrTemplate: event.target.value } })} autoSize={{ minRows: 2, maxRows: 4 }} />
            </Form.Item>
            <Form.Item label="EC" style={{ marginBottom: 10 }}>
              <Select value={String(style.qrErrorCorrection ?? 'M')} disabled={!canManage} options={PDF_QR_ERROR_CORRECTION_OPTIONS} onChange={(qrErrorCorrection) => onPatch({ style: { ...style, qrErrorCorrection } })} />
            </Form.Item>
          </>
        )}
        {element.type === 'sheet_thumbnail' && (
          <Form.Item label="Масштабирование" style={{ marginBottom: 10 }}>
            <Select
              value={String(style.fit ?? 'contain')}
              disabled={!canManage}
              options={[
                { value: 'contain', label: 'Вписать' },
                { value: 'cover', label: 'Заполнить' },
                { value: 'stretch', label: 'Растянуть' },
              ]}
              onChange={(fit) => patchStyle({ fit })}
            />
          </Form.Item>
        )}
        {element.type === 'detail_table' && (
          <Space direction="vertical" size={8} style={{ width: '100%', marginBottom: 10 }}>
            <Text strong>Таблица деталей</Text>
            <Space.Compact block>
              <Select
                showSearch
                value={tableSort.field}
                disabled={!canManage}
                options={tableFields.map((field) => ({ value: field.id, label: `${field.category}: ${field.label}` }))}
                style={{ width: '70%' }}
                onChange={(field) => patchStyle({ sort: { ...tableSort, field } })}
              />
              <Select
                value={tableSort.direction}
                disabled={!canManage}
                options={[
                  { value: 'asc', label: 'A-Z' },
                  { value: 'desc', label: 'Z-A' },
                ]}
                style={{ width: '30%' }}
                onChange={(direction) => patchStyle({ sort: { ...tableSort, direction } })}
              />
            </Space.Compact>
            <Table<PdfDetailTableColumn>
              size="small"
              rowKey={(row, index) => `${row.field}-${index}`}
              pagination={false}
              dataSource={tableColumns}
              columns={[
                {
                  title: 'Поле',
                  render: (_, row, index) => (
                    <Select
                      showSearch
                      size="small"
                      value={row.field}
                      disabled={!canManage}
                      options={tableFields.map((field) => ({ value: field.id, label: field.label }))}
                      onChange={(field) => patchTableColumn(index, { field, label: fieldLabelsFromList(fields).get(field) ?? field })}
                    />
                  ),
                },
                {
                  title: 'Название',
                  render: (_, row, index) => <Input size="small" value={row.label} disabled={!canManage} onChange={(event) => patchTableColumn(index, { label: event.target.value })} />,
                },
                {
                  title: 'W',
                  width: 62,
                  render: (_, row, index) => <InputNumber size="small" min={0.1} max={20} step={0.1} value={row.width} disabled={!canManage} onChange={(width) => patchTableColumn(index, { width: Number(width ?? 1) })} />,
                },
                {
                  title: 'Вкл',
                  width: 44,
                  render: (_, row, index) => <Checkbox checked={row.visible} disabled={!canManage} onChange={(event) => patchTableColumn(index, { visible: event.target.checked })} />,
                },
                {
                  title: '',
                  width: 34,
                  render: (_, _row, index) => <Button size="small" danger icon={<DeleteOutlined />} disabled={!canManage || tableColumns.length <= 1} onClick={() => removeTableColumn(index)} />,
                },
              ]}
            />
            <Button
              size="small"
              icon={<PlusOutlined />}
              disabled={!canManage || tableFields.length === 0}
              onClick={() => patchStyle({ columns: [...tableColumns, defaultPdfDetailTableColumn(tableFields, tableColumns.length)] })}
            >
              Добавить колонку
            </Button>
          </Space>
        )}
        <Row gutter={8}>
          <Col span={6}><NumberBox label="X" value={element.x} disabled={!canManage} onChange={(x) => onPatch({ x })} /></Col>
          <Col span={6}><NumberBox label="Y" value={element.y} disabled={!canManage} onChange={(y) => onPatch({ y })} /></Col>
          <Col span={6}><NumberBox label="W" value={element.w} disabled={!canManage} onChange={(w) => onPatch({ w })} /></Col>
          <Col span={6}><NumberBox label="H" value={element.h} disabled={!canManage} onChange={(h) => onPatch({ h })} /></Col>
        </Row>
        <Row gutter={8}>
          <Col span={8}><NumberBox label="Поворот" value={element.rotation} disabled={!canManage} onChange={(rotation) => onPatch({ rotation })} /></Col>
          <Col span={8}><NumberBox label="Шрифт" value={Number(style.fontSize ?? 10)} disabled={!canManage || !['text', 'field', 'custom', 'detail_table'].includes(element.type)} onChange={(fontSize) => onPatch({ style: { ...style, fontSize } })} /></Col>
          <Col span={8}><NumberBox label="Линия" value={Number(style.strokeWidth ?? 0.35)} disabled={!canManage || !['line', 'rect', 'sheet_thumbnail', 'detail_table'].includes(element.type)} onChange={(strokeWidth) => onPatch({ style: { ...style, strokeWidth } })} /></Col>
        </Row>
        <Form.Item label="Цвет" style={{ marginBottom: 10 }}>
          <Input type="color" value={String(style.color ?? '#111111')} disabled={!canManage} onChange={(event) => onPatch({ style: { ...style, color: event.target.value } })} />
        </Form.Item>
        <Form.Item label="Выравнивание" style={{ marginBottom: 10 }}>
          <Segmented
            value={element.align}
            onChange={(align) => onPatch({ align: align as PdfTextAlign })}
            options={[
              { value: 'left', label: <AlignLeftOutlined /> },
              { value: 'center', label: <AlignCenterOutlined /> },
              { value: 'right', label: <AlignRightOutlined /> },
            ]}
            disabled={!canManage || !['text', 'field', 'custom'].includes(element.type)}
          />
        </Form.Item>
        <Checkbox checked={Boolean(style.locked)} disabled={!canManage} onChange={(event) => onPatch({ style: { ...style, locked: event.target.checked } })}>
          Заблокировать
        </Checkbox>
      </Form>
    </Card>
  );
};

const NumberBox: React.FC<{ label: string; value: number; disabled: boolean; onChange: (value: number) => void }> = ({ label, value, disabled, onChange }) => (
  <Form.Item label={label} style={{ marginBottom: 10 }}>
    <InputNumber value={value} onChange={(next) => onChange(Number(next ?? 0))} disabled={disabled} style={{ width: '100%' }} />
  </Form.Item>
);

function loadPdfTemplateDrafts(templates: CutPdfTemplate[]): PdfTemplateDraft[] {
  if (typeof window !== 'undefined') {
    try {
      const saved = window.localStorage.getItem(PDF_TEMPLATE_DRAFTS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as PdfTemplateDraft[];
        if (Array.isArray(parsed) && parsed.length > 0) return mergePdfTemplateDrafts(parsed.map(normalizePdfDraft), templates);
      }
    } catch {
      // Ignore broken local drafts; config templates remain authoritative.
    }
  }
  return mergePdfTemplateDrafts([], templates);
}

function mergePdfTemplateDrafts(drafts: PdfTemplateDraft[], templates: CutPdfTemplate[]): PdfTemplateDraft[] {
  const byCode = new Map(drafts.map((draft) => [draft.code, normalizePdfDraft(draft)]));
  for (const template of templates) {
    if (!template.isActive) continue;
    byCode.set(template.code, pdfTemplateToDraft(template));
  }
  return [...byCode.values()];
}

function pdfTemplateToDraft(template: CutPdfTemplate): PdfTemplateDraft {
  return normalizePdfDraft({
    code: template.code,
    name: template.name,
    ...layoutToPdfDraftShape(template.layout),
  });
}

function layoutToPdfDraftShape(layout: Record<string, unknown>): Pick<PdfTemplateDraft, 'page' | 'customFields' | 'elements'> {
  const page = isRecord(layout.page) ? {
    width: Number(layout.page.width ?? PDF_PAGE.width),
    height: Number(layout.page.height ?? PDF_PAGE.height),
  } : PDF_PAGE;
  const customFields = isRecord(layout.customFieldSchema)
    ? customFieldRowsFromSchema(layout.customFieldSchema)
    : Array.isArray(layout.customFields)
      ? layout.customFields.map(normalizeCustomField)
      : [];
  const rawElements = Array.isArray(layout.elements) ? layout.elements : DEFAULT_PDF_ELEMENTS;
  return { page, customFields, elements: rawElements.map((element, index) => normalizePdfElement(element, index)) };
}

function pdfDraftToLayout(draft: PdfTemplateDraft): Record<string, unknown> {
  const customFields = draft.customFields.map((field) => ({ ...field, fieldId: customFieldSourceId(field.fieldId) }));
  const customFieldSchema = customFieldRowsToSchema(customFields);
  return {
    version: 3,
    page: draft.page,
    customFieldSchema,
    customFields: customFields.map((field) => ({
      fieldId: field.fieldId,
      label: field.label,
      type: field.type,
      sourceField: field.valueMode === 'source' ? field.sourceField : null,
    })),
    elements: draft.elements.map((element, index) => ({ ...normalizePdfElement(element, index), zIndex: index })),
  };
}

function pdfDraftToStoredDraft(draft: PdfTemplateDraft): PdfTemplateDraft {
  return normalizePdfDraft({ ...draft, elements: draft.elements.map((element, index) => normalizePdfElement(element, index)) });
}

function normalizePdfDraft(raw: Partial<PdfTemplateDraft>): PdfTemplateDraft {
  return {
    code: String(raw.code ?? 'standard'),
    name: String(raw.name ?? 'Стандартный'),
    page: {
      width: Number(raw.page?.width ?? PDF_PAGE.width),
      height: Number(raw.page?.height ?? PDF_PAGE.height),
    },
    customFields: Array.isArray(raw.customFields) ? raw.customFields.map(normalizeCustomField) : [],
    elements: (Array.isArray(raw.elements) && raw.elements.length > 0 ? raw.elements : DEFAULT_PDF_ELEMENTS).map((element, index) => normalizePdfElement(element, index)),
  };
}

function normalizeCustomField(raw: unknown): CustomFieldSchemaRow {
  const r = isRecord(raw) ? raw : {};
  const type = r.type === 'number' || r.type === 'date' || r.type === 'boolean' ? r.type : 'string';
  return {
    fieldId: customFieldSourceId(String(r.fieldId ?? r.id ?? 'field').trim()),
    label: String(r.label ?? r.fieldId ?? r.id ?? 'Поле').trim(),
    type,
    valueMode: typeof r.sourceField === 'string' ? 'source' : 'constant',
    sourceField: typeof r.sourceField === 'string' ? r.sourceField : null,
    defaultValue: isRecord(r) && Object.prototype.hasOwnProperty.call(r, 'defaultValue') ? r.defaultValue : '',
    expression: null,
    extra: {},
  };
}

function normalizePdfElement(raw: unknown, index = 0): PdfTemplateElement {
  const r = isRecord(raw) ? raw : {};
  if (typeof r.type === 'string' && (r.type === 'field' || r.type === 'line' || r.type === 'rect') && typeof r.x === 'number' && r.x > PDF_PAGE.width) {
    return makePdfElement(r.type as PdfTemplateElementType, {
      id: String(r.id ?? `${r.type}-${index}`),
      label: String(r.label ?? pdfElementTypeLabel(r.type as PdfTemplateElementType)),
      source: typeof r.source === 'string' ? r.source : null,
      x: roundPdfMm((Number(r.x ?? 0) / PDF_OLD_PAGE.width) * PDF_PAGE.width),
      y: roundPdfMm((Number(r.y ?? 0) / PDF_OLD_PAGE.height) * PDF_PAGE.height),
      w: roundPdfMm((Number(r.w ?? 24) / PDF_OLD_PAGE.width) * PDF_PAGE.width),
      h: roundPdfMm((Number(r.h ?? 8) / PDF_OLD_PAGE.height) * PDF_PAGE.height),
      align: r.align === 'right' || r.align === 'center' ? r.align : 'left',
      zIndex: Number(r.zIndex ?? index),
      style: isRecord(r.style) ? r.style : {},
    });
  }
  const type = isPdfElementType(r.type) ? r.type : 'field';
  return makePdfElement(type, {
    id: String(r.id ?? `${type}-${index}`),
    label: String(r.label ?? pdfElementTypeLabel(type)),
    source: typeof r.source === 'string' ? r.source : null,
    text: typeof r.text === 'string' ? r.text : null,
    x: Number(r.x ?? 12),
    y: Number(r.y ?? 12),
    w: Number(r.w ?? (type === 'qr' ? 22 : 48)),
    h: Number(r.h ?? (type === 'line' ? 0 : type === 'qr' ? 22 : 8)),
    rotation: Number(r.rotation ?? 0),
    zIndex: Number(r.zIndex ?? index),
    align: r.align === 'right' || r.align === 'center' ? r.align : 'left',
    style: isRecord(r.style) ? r.style : {},
  });
}

function makePdfElement(type: PdfTemplateElementType, patch: Partial<PdfTemplateElement> = {}): PdfTemplateElement {
  const base = defaultPatchForType(type);
  const style = { ...base.style, ...(patch.style ?? {}) };
  return {
    id: patch.id ?? `${type}-${Date.now().toString(36)}`,
    type,
    label: patch.label ?? base.label,
    source: patch.source ?? base.source ?? null,
    text: patch.text ?? base.text ?? null,
    x: roundPdfMm(Number(patch.x ?? base.x ?? 18)),
    y: roundPdfMm(Number(patch.y ?? base.y ?? 18)),
    w: roundPdfMm(Math.max(0.5, Number(patch.w ?? base.w ?? 48))),
    h: roundPdfMm(Math.max(type === 'line' ? 0 : 0.5, Number(patch.h ?? base.h ?? 8))),
    rotation: roundPdfMm(Number(patch.rotation ?? base.rotation ?? 0)),
    zIndex: Number(patch.zIndex ?? base.zIndex ?? 0),
    align: patch.align ?? base.align ?? 'left',
    style,
  };
}

function defaultPatchForType(type: PdfTemplateElementType): Partial<PdfTemplateElement> {
  if (type === 'text') return { label: 'Текст', source: null, text: 'Текст', x: 18, y: 18, w: 48, h: 8, align: 'left', style: { fontSize: 10, color: '#111111' } };
  if (type === 'field') return { label: 'Поле', source: 'order.unique_names', text: null, x: 18, y: 18, w: 58, h: 8, align: 'left', style: { fontSize: 10, color: '#111111' } };
  if (type === 'custom') return { label: 'Пользовательское поле', source: null, text: null, x: 18, y: 18, w: 58, h: 8, align: 'left', style: { fontSize: 10, color: '#111111' } };
  if (type === 'qr') return { label: 'QR-код', source: null, text: null, x: 18, y: 18, w: 22, h: 22, align: 'center', style: { qrName: 'QR', qrTemplate: '{order.unique_names}\\n{sheet.number}', qrErrorCorrection: 'M' } };
  if (type === 'sheet_thumbnail') return { label: 'Миниатюра листа', source: 'sheet.thumbnail', text: null, x: 18, y: 32, w: 150, h: 95, align: 'center', style: { color: '#111111', strokeWidth: 0.25, fit: 'contain' } };
  if (type === 'detail_table') return { label: 'Таблица деталей', source: 'detail.table', text: null, x: 180, y: 32, w: 88, h: 72, align: 'center', style: { color: '#111111', strokeWidth: 0.25, fontSize: 7, columns: DEFAULT_PDF_DETAIL_TABLE_COLUMNS, sort: { field: 'detail.order', direction: 'asc' } } };
  if (type === 'line') return { label: 'Линия', source: null, text: null, x: 18, y: 18, w: 64, h: 0, align: 'left', style: { color: '#111111', strokeWidth: 0.35 } };
  return { label: 'Прямоугольник', source: null, text: null, x: 18, y: 18, w: 48, h: 22, align: 'center', style: { color: '#111111', strokeWidth: 0.35, fill: 'transparent' } };
}

function pdfElementTypeLabel(type: PdfTemplateElementType): string {
  const labels: Record<PdfTemplateElementType, string> = {
    text: 'Текст',
    field: 'Поле',
    custom: 'Пользовательское',
    qr: 'QR',
    sheet_thumbnail: 'Миниатюра листа',
    detail_table: 'Таблица деталей',
    line: 'Линия',
    rect: 'Прямоугольник',
  };
  return labels[type];
}

function isPdfElementType(value: unknown): value is PdfTemplateElementType {
  return value === 'text'
    || value === 'field'
    || value === 'custom'
    || value === 'qr'
    || value === 'sheet_thumbnail'
    || value === 'detail_table'
    || value === 'line'
    || value === 'rect';
}

function normalizePdfFieldCatalogItem(row: CutPdfFieldCatalogItem): PdfFieldCatalogItem {
  return {
    id: row.id,
    source: row.source,
    sourceColumn: row.sourceColumn,
    label: row.label,
    category: row.category,
    type: row.type,
  };
}

function isCutPdfFieldDragEvent(event: React.DragEvent<Element>): boolean {
  return Array.from(event.dataTransfer.types).includes(CUT_PDF_FIELD_DRAG_TYPE);
}

function resolveDroppedPdfField(
  fields: PdfFieldCatalogItem[],
  event: React.DragEvent<Element>,
  fallback: PdfFieldCatalogItem | null,
): PdfFieldCatalogItem | null {
  if (fallback) return fallback;
  const fieldId = event.dataTransfer.getData(CUT_PDF_FIELD_DRAG_TYPE);
  return fields.find((field) => field.id === fieldId) ?? null;
}

function toLabelExpressionFields(fields: PdfFieldCatalogItem[]): LabelFieldCatalogItem[] {
  return fields.map((field) => ({
    id: field.id,
    source: field.source === 'bazis' || field.source === 'dynamic' || field.source === 'detail' || field.source === 'order'
      ? field.source
      : 'dynamic',
    sourceColumn: field.sourceColumn ?? null,
    label: field.label,
    type: field.type,
    category: field.category,
  }));
}

function defaultCustomExpressionNode(fieldId: string): LabelCustomExpressionNode {
  return fieldId ? { type: 'field', field: fieldId } : { type: 'empty' };
}

function customFieldSourceId(fieldId: string): string {
  const normalized = fieldId.trim() || 'custom.field';
  return normalized.startsWith('custom.') ? normalized : `custom.${normalized}`;
}

function readPdfDetailTableColumns(style: Record<string, unknown>, includeHidden = false): PdfDetailTableColumn[] {
  const table = isRecord(style.table) ? style.table : {};
  const rawColumns = Array.isArray(table.columns)
    ? table.columns
    : Array.isArray(style.columns)
      ? style.columns
      : DEFAULT_PDF_DETAIL_TABLE_COLUMNS;
  return rawColumns
    .map((raw): PdfDetailTableColumn | null => {
      if (!isRecord(raw)) return null;
      const field = typeof raw.field === 'string' && raw.field.trim() ? raw.field.trim() : 'detail.order';
      return {
        field,
        label: String(raw.label ?? fieldLabelsFromList(PDF_FIELD_CATALOG).get(field) ?? field),
        width: Math.max(0.1, Number(raw.width ?? 1)),
        visible: raw.visible !== false,
      };
    })
    .filter((column): column is PdfDetailTableColumn => Boolean(column) && (includeHidden || column.visible));
}

function readPdfDetailTableSort(style: Record<string, unknown>): { field: string; direction: 'asc' | 'desc' } {
  const table = isRecord(style.table) ? style.table : {};
  const raw = isRecord(table.sort) ? table.sort : isRecord(style.sort) ? style.sort : {};
  return {
    field: typeof raw.field === 'string' ? raw.field : 'detail.order',
    direction: raw.direction === 'desc' ? 'desc' : 'asc',
  };
}

function defaultPdfDetailTableColumn(fields: PdfFieldCatalogItem[], index: number): PdfDetailTableColumn {
  const field = fields[index % Math.max(fields.length, 1)];
  return {
    field: field?.id ?? 'detail.order',
    label: field?.label ?? 'Заказ',
    width: 1,
    visible: true,
  };
}

function formatPdfTemplateSaveError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Не удалось сохранить шаблон PDF';
  const details = isRecord(error.details) ? error.details : {};
  const field = typeof details.field === 'string' && details.field ? details.field : '';
  return field ? `${error.message}: ${field}` : error.message;
}

function fieldLabelsFromList(fields: PdfFieldCatalogItem[]): Map<string, string> {
  return new Map(fields.map((field) => [field.id, field.label]));
}

function pdfDetailTablePreviewValue(field: string, rowIndex: number): string {
  const suffix = rowIndex === 0 ? '' : rowIndex === 1 ? '-2' : '-3';
  const values: Record<string, string> = {
    'detail.row_number': String(rowIndex + 1),
    'detail.order': `11380${suffix}`,
    'detail.position': String(12 + rowIndex),
    'detail.lengthMm': String(800 - rowIndex * 20),
    'detail.widthMm': String(240 + rowIndex * 15),
    'detail.quantity': String(rowIndex + 1),
    'detail.material': 'Ванна',
    'detail.film': 'Крем',
    'detail.client': 'Клиент',
    'detail.orderDate': '03.07.2026',
    'detail.readyDate': '10.07.2026',
    'detail.thickness': '16',
  };
  return values[field] ?? values[field.replace(/^detail\./, 'detail.')] ?? '';
}

function groupPdfFields(fields: PdfFieldCatalogItem[]): Array<[string, PdfFieldCatalogItem[]]> {
  const grouped = new Map<string, PdfFieldCatalogItem[]>();
  for (const field of fields) grouped.set(field.category, [...(grouped.get(field.category) ?? []), field]);
  const order = [
    'Пользовательские',
    'Задание',
    'Задание раскроя',
    'Группа',
    'Группа раскроя',
    'Лист',
    'Лист раскроя',
    'Заказ',
    'Клиент',
    'Детали',
    'Таблица деталей',
    'Вычисляемые',
  ];
  return [...grouped.entries()].sort(([a], [b]) => {
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    return a.localeCompare(b, 'ru');
  });
}

function renderPdfGrid(width: number, height: number): React.ReactNode[] {
  const lines: React.ReactNode[] = [];
  for (let x = 0; x <= width; x += 5) {
    const major = x % 25 === 0;
    lines.push(<KonvaLine key={`x-${x}`} points={[x, 0, x, height]} stroke={major ? '#d9d9d9' : '#f0f0f0'} strokeWidth={major ? 0.12 : 0.06} listening={false} />);
  }
  for (let y = 0; y <= height; y += 5) {
    const major = y % 25 === 0;
    lines.push(<KonvaLine key={`y-${y}`} points={[0, y, width, y]} stroke={major ? '#d9d9d9' : '#f0f0f0'} strokeWidth={major ? 0.12 : 0.06} listening={false} />);
  }
  return lines;
}

function findTopPdfElement(elements: PdfTemplateElement[], x: number, y: number): PdfTemplateElement | null {
  for (const element of elements.slice().reverse()) {
    const h = Math.max(element.type === 'line' ? 1 : element.h, 1);
    if (x >= element.x && x <= element.x + Math.max(element.w, 1) && y >= element.y && y <= element.y + h) return element;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundPdfMm(value: number): number {
  return Math.round(value * 10) / 10;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  const engineAnomalies = useMemo(() => (editing ? detectEngineParamAnomalies(editing.params) : []), [editing]);

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
        {engineAnomalies.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="Несогласованные параметры движка в сохранённом профиле"
            description={`${engineAnomalies.join('; ')}. При сохранении параметры будут приведены к выбранным в форме значениям.`}
          />
        )}

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
          <Col span={12}>
            {params.layout_mode !== 'vacuum_table' && (
              <Form.Item
                label="Движок расчёта"
                tooltip={ENGINE_TOOLTIP}
                extra={<Text type="secondary" style={{ display: 'block', fontSize: 12 }}>{ENGINE_EXTRA[params.engine]}</Text>}
                style={{ marginBottom: 12 }}
              >
                <Segmented
                  value={params.engine}
                  onChange={(v) => {
                    if (isEngineChoice(v)) setField('engine', v);
                  }}
                  options={ENGINE_OPTIONS}
                />
              </Form.Item>
            )}
          </Col>
          <Col span={12}>
            {params.layout_mode !== 'vacuum_table' && params.engine === 'heuristic' && (
              <Form.Item
                label="Доупаковка (быстрый движок)"
                tooltip="Fast — только базовая укладка, миллисекунды. Balanced — доупаковка недозаполненных листов. Max — доупаковка + итеративный поиск в пределах лимита времени; обычно экономит листы на крупных заданиях."
                style={{ marginBottom: 12 }}
              >
                <Segmented
                  value={params.cutQuality}
                  onChange={(v) => {
                    if (isCutQuality(v)) setField('cutQuality', v);
                  }}
                  options={CUT_QUALITY_OPTIONS}
                />
              </Form.Item>
            )}
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
