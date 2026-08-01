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
  Tooltip,
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
  FileTextOutlined,
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
import { notifyCutPdfTemplatesChanged } from '../../../api/cutPdfTemplateEvents';
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
import { CustomFieldExpressionEditor, type CustomFieldAggregateSourceOption } from './CustomFieldExpressionEditor';
import {
  customFieldRowsFromSchema,
  customFieldRowsToSchema,
  evaluateCustomFieldPreviewValues,
  isCustomFieldExpressionValid,
  readCustomFieldExpressionV1,
  summarizeCustomFieldExpression,
  type CustomExpressionPreviewCollections,
  type CustomFieldSchemaRow,
} from './labelTemplateEditorHelpers';
import './CutConfigTab.css';

const { Title, Text, Paragraph } = Typography;
const { Panel } = Collapse;

const PDF_DETAIL_DIMENSION_FONT_SCALE = 1.25;

function fitPdfDetailDimensionFont(
  label: string,
  length: number,
  thickness: number,
  standardFontSize: number,
  orientation: 'horizontal' | 'vertical',
): number {
  const estimatedTextWidth = Math.max(label.length * 0.56 * standardFontSize, 1);
  const widthScale = (length * 0.82) / estimatedTextWidth;
  const thicknessLimit = orientation === 'horizontal' ? 0.35 : 0.42;
  const thicknessScale = (thickness * thicknessLimit) / standardFontSize;
  return Math.max(1, Math.min(standardFontSize, standardFontSize * widthScale, standardFontSize * thicknessScale));
}

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

  const updatePdfTemplateInConfig = useCallback((template: CutPdfTemplate) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const exists = prev.pdfTemplates.some((item) => item.cutPdfTemplateId === template.cutPdfTemplateId || item.code === template.code);
      const pdfTemplates = (exists
        ? prev.pdfTemplates.map((item) => (
          item.cutPdfTemplateId === template.cutPdfTemplateId || item.code === template.code ? template : item
        ))
        : [...prev.pdfTemplates, template]
      ).slice().sort((a, b) => a.code.localeCompare(b.code));
      return { ...prev, pdfTemplates };
    });
    notifyCutPdfTemplatesChanged();
  }, []);

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
            children: <PdfTemplateEditor templates={config.pdfTemplates} canManage={canManage} onTemplateSaved={updatePdfTemplateInConfig} />,
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

type PdfTemplateElementType = 'text' | 'field' | 'custom' | 'qr' | 'line' | 'rect' | 'sheet_thumbnail' | 'detail_table' | 'machine_files_table';
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
  onTemplateSaved: (template: CutPdfTemplate) => void;
}

type PdfTemplateEditorLayoutMode = 'standard' | 'wide' | 'rightAccordion';

const PDF_TEMPLATE_DRAFTS_KEY = 'cut-pdf-template-drafts:v2';
const CUT_PDF_FIELD_DRAG_TYPE = 'application/x-cut-pdf-field';
const PDF_FIELD_PALETTE_DESKTOP_MAX_WIDTH = 228;
const PDF_FIELD_PALETTE_DESKTOP_MIN_WIDTH = 168;
const PDF_FIELD_PALETTE_LABEL_AVG_WIDTH = 5.9;
const PDF_FIELD_PALETTE_COLUMN_CHROME = 50;
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
  { id: 'job.number', source: 'job', label: 'Номер задания на раскрой', category: 'Задание', type: 'number' },
  { id: 'job.pdf_template', source: 'job', label: 'Шаблон PDF', category: 'Задание', type: 'string' },
  { id: 'cut.number', source: 'cut', label: 'Номер раскроя', category: 'Раскрой', type: 'string' },
  { id: 'cut.current_version', source: 'cut', label: 'Текущая/актуальная версия Карты раскроя', category: 'Раскрой', type: 'string' },
  { id: 'group.number', source: 'group', label: 'Номер группы', category: 'Группа', type: 'number' },
  { id: 'group.material', source: 'group', label: 'Материал группы', category: 'Группа', type: 'string' },
  { id: 'group.film', source: 'group', label: 'Пленка группы', category: 'Группа', type: 'string' },
  { id: 'sheet.number', source: 'sheet', label: 'Номер листа', category: 'Лист', type: 'number' },
  { id: 'sheet.page_count', source: 'sheet', label: 'Количество листов', category: 'Лист', type: 'number' },
  { id: 'sheet.size', source: 'sheet', label: 'Размер листа', category: 'Лист', type: 'string' },
  { id: 'sheet.details_count', source: 'sheet', label: 'Количество деталей на листе', category: 'Лист', type: 'number' },
  { id: 'sheet.area', source: 'sheet', label: 'Площадь деталей', category: 'Лист', type: 'number' },
  { id: 'sheet.utilization', source: 'sheet', label: 'Утилизация листа, %', category: 'Лист', type: 'number' },
  { id: 'sheet.film_requirement', source: 'sheet', label: 'Потребность в плёнке', category: 'Лист', type: 'string' },
  { id: 'sheet.thumbnail', source: 'sheet', label: 'Миниатюра листа раскроя', category: 'Лист', type: 'string' },
  { id: 'sheet.machine_files', source: 'sheet', label: 'Файлы станка на листе', category: 'Лист', type: 'string' },
  { id: 'order.unique_names', source: 'order', label: 'Заказы на листе', category: 'Заказ', type: 'string' },
  { id: 'order.date', source: 'order', label: 'Дата заказа', category: 'Заказ', type: 'date' },
  { id: 'order.ready_date', source: 'order', label: 'Дата готовности', category: 'Заказ', type: 'date' },
  { id: 'client.unique_names', source: 'client', label: 'Клиенты на листе', category: 'Клиент', type: 'string' },
  { id: 'detail.materials', source: 'detail', label: 'Материалы деталей', category: 'Детали', type: 'string' },
  { id: 'detail.films', source: 'detail', label: 'Пленки деталей', category: 'Детали', type: 'string' },
  { id: 'detail.thicknesses', source: 'detail', label: 'Толщины деталей', category: 'Детали', type: 'string' },
  { id: 'detail.edge_types', source: 'detail', label: 'Обкаты деталей', category: 'Детали', type: 'string' },
  { id: 'detail.machine_files', source: 'detail', label: 'Файлы станка деталей', category: 'Детали', type: 'string' },
  { id: 'detail.table', source: 'detail', label: 'Таблица деталей', category: 'Детали', type: 'string' },
  { id: 'detail.row_number', source: 'detail', label: 'Номер строки', category: 'Таблица деталей', type: 'number' },
  { id: 'detail.order', source: 'detail', label: 'Заказ', category: 'Таблица деталей', type: 'string' },
  { id: 'detail.position', source: 'detail', label: 'Позиция', category: 'Таблица деталей', type: 'string' },
  { id: 'detail.lengthMm', source: 'detail', label: 'Длина', category: 'Таблица деталей', type: 'number' },
  { id: 'detail.widthMm', source: 'detail', label: 'Ширина', category: 'Таблица деталей', type: 'number' },
  { id: 'detail.quantity', source: 'detail', label: 'Количество', category: 'Таблица деталей', type: 'number' },
  { id: 'detail.doweling', source: 'detail', sourceColumn: 'doweling', label: 'Присадка', category: 'Таблица деталей', type: 'boolean' },
  { id: 'detail.machine_file', source: 'detail', label: 'Файл станка', category: 'Таблица деталей', type: 'string' },
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
const PDF_AGGREGATE_SOURCES: CustomFieldAggregateSourceOption[] = [
  { value: 'sheet.details', label: 'Детали листа', fieldSource: 'detail' },
];
const PDF_PREVIEW_VALUES: Record<string, string> = {
  'job.name': 'Раскрой заказ 11380',
  'job.number': '19',
  'job.pdf_template': 'Профили ванны',
  'cut.number': '19-3',
  'cut.current_version': '19-4',
  'group.number': '1',
  'group.material': 'Ванна 2080x1050',
  'group.film': 'Крем брюле -Декор+',
  'sheet.number': '1',
  'sheet.page_count': '3',
  'sheet.size': '2080x1050',
  'sheet.details_count': '32',
  'sheet.area': '5.378',
  'sheet.utilization': '48.76',
  'sheet.film_requirement': '2,1 пог. м',
  'sheet.thumbnail': '',
  'sheet.machine_files': 'CNC#1_11380.TXT',
  'order.unique_names': '11380',
  'order.date': '03.07.2026',
  'order.ready_date': '10.07.2026',
  'client.unique_names': 'Тестовый клиент',
  'detail.materials': 'Ванна 2080x1050',
  'detail.films': 'Крем брюле -Декор+',
  'detail.thicknesses': '16',
  'detail.edge_types': 'ПВХ 2мм, ABS 1мм',
  'detail.machine_files': 'CNC#1_11380.TXT',
  'detail.table': '#  Длина  Ширина  Кол-во',
  'detail.row_number': '1',
  'detail.order': '11380',
  'detail.position': '12',
  'detail.lengthMm': '800',
  'detail.widthMm': '240',
  'detail.quantity': '2',
  'detail.doweling': '✓',
  'detail.machine_file': 'CNC#1_11380.TXT',
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
const PDF_PREVIEW_COLLECTIONS: CustomExpressionPreviewCollections = {
  'sheet.details': [
    {
      'detail.order': '11380',
      'detail.position': '12',
      'detail.lengthMm': 800,
      'detail.widthMm': 240,
      'detail.quantity': 2,
      'detail.doweling': true,
      'detail.machine_file': 'CNC#1_11380.TXT',
      'detail.material': 'Ванна 2080x1050',
      'detail.film': 'Крем брюле -Декор+',
      'detail.thickness': 16,
      'detail.edge_type_name': 'ПВХ 2мм',
    },
    {
      'detail.order': '11380',
      'detail.position': '13',
      'detail.lengthMm': 780,
      'detail.widthMm': 255,
      'detail.quantity': 1,
      'detail.doweling': false,
      'detail.machine_file': 'CNC#2_11380.TXT',
      'detail.material': 'Ванна 2080x1050',
      'detail.film': 'Крем брюле -Декор+',
      'detail.thickness': 16,
      'detail.edge_type_name': 'ABS 1мм',
    },
    {
      'detail.order': '11381',
      'detail.position': '14',
      'detail.lengthMm': 760,
      'detail.widthMm': 270,
      'detail.quantity': 1,
      'detail.doweling': true,
      'detail.machine_file': 'CNC#1_11380.TXT',
      'detail.material': 'Ванна 2080x1050',
      'detail.film': 'Крем брюле -Декор+',
      'detail.thickness': 16,
      'detail.edge_type_name': 'ПВХ 2мм',
    },
  ],
};
const DEFAULT_PDF_DETAIL_TABLE_COLUMNS: PdfDetailTableColumn[] = [
  { field: 'detail.row_number', label: '#', width: 0.55, visible: true },
  { field: 'detail.order', label: 'Заказ', width: 1.6, visible: true },
  { field: 'detail.position', label: 'Поз.', width: 0.9, visible: true },
  { field: 'detail.lengthMm', label: 'Длина', width: 1.1, visible: true },
  { field: 'detail.widthMm', label: 'Ширина', width: 1.1, visible: true },
  { field: 'detail.quantity', label: 'Кол-во', width: 0.9, visible: true },
  { field: 'detail.doweling', label: 'Присадка', width: 0.95, visible: true },
  { field: 'detail.machine_file', label: 'Файл станка', width: 1.8, visible: true },
];
const DEFAULT_PDF_ELEMENTS: PdfTemplateElement[] = [
  makePdfElement('field', { id: 'field-order', label: 'Заказ', source: 'order.unique_names', x: 12, y: 10, w: 84, h: 8, align: 'left' }),
  makePdfElement('field', { id: 'field-client', label: 'Клиент', source: 'client.unique_names', x: 108, y: 10, w: 78, h: 8, align: 'left' }),
  makePdfElement('field', { id: 'field-film', label: 'Пленка', source: 'detail.films', x: 198, y: 10, w: 84, h: 8, align: 'left' }),
  makePdfElement('line', { id: 'line-header', label: 'Линия шапки', x: 12, y: 22, w: 270, h: 0 }),
  makePdfElement('sheet_thumbnail', { id: 'sheet-thumbnail', label: 'Миниатюра листа', source: 'sheet.thumbnail', x: 12, y: 34, w: 202, h: 154 }),
  makePdfElement('detail_table', { id: 'detail-table', label: 'Таблица деталей', source: 'detail.table', x: 222, y: 34, w: 60, h: 78 }),
  makePdfElement('machine_files_table', { id: 'machine-files-table', label: 'Файлы станка', source: 'sheet.machine_files', x: 222, y: 116, w: 60, h: 32 }),
];
const BATH_PROFILE_PDF_ELEMENTS: PdfTemplateElement[] = [
  makePdfElement('text', { id: 'bath-label-order', label: 'Подпись Заказ', text: 'Заказ:', x: 9.9, y: 9.9, w: 28.9, h: 5.4, style: { fontSize: 10.5, color: '#111111' } }),
  makePdfElement('field', { id: 'bath-field-order', label: 'Заказ', source: 'order.unique_names', x: 38.8, y: 9.9, w: 60.5, h: 6.4, style: { fontSize: 10.5, color: '#111111' } }),
  makePdfElement('text', { id: 'bath-label-client', label: 'Подпись Клиент', text: 'Клиент:', x: 102.3, y: 9.9, w: 28.9, h: 5.4, style: { fontSize: 10.5, color: '#111111' } }),
  makePdfElement('field', { id: 'bath-field-client', label: 'Клиент', source: 'client.unique_names', x: 131.2, y: 9.9, w: 60.5, h: 6.4, style: { fontSize: 10.5, color: '#111111' } }),
  makePdfElement('text', { id: 'bath-label-order-date', label: 'Подпись Дата заказа', text: 'Дата:', x: 194.7, y: 9.9, w: 28.9, h: 5.4, style: { fontSize: 10.5, color: '#111111' } }),
  makePdfElement('field', { id: 'bath-field-order-date', label: 'Дата заказа', source: 'order.date', x: 223.7, y: 9.9, w: 60.5, h: 6.4, style: { fontSize: 10.5, color: '#111111' } }),
  makePdfElement('line', { id: 'bath-line-header-1', label: 'Линия шапки 1', x: 9.9, y: 16.6, w: 277.3, h: 0, style: { color: '#111111', strokeWidth: 0.25 } }),
  makePdfElement('text', { id: 'bath-label-ready-date', label: 'Подпись Дата готовности', text: 'Дата готовности:', x: 9.9, y: 17.7, w: 28.9, h: 5.4, style: { fontSize: 10.5, color: '#111111' } }),
  makePdfElement('field', { id: 'bath-field-ready-date', label: 'Дата готовности', source: 'order.ready_date', x: 38.8, y: 17.7, w: 60.5, h: 6.4, style: { fontSize: 10.5, color: '#111111' } }),
  makePdfElement('text', { id: 'bath-label-material', label: 'Подпись Материал', text: 'Материал:', x: 102.3, y: 17.7, w: 28.9, h: 5.4, style: { fontSize: 10.5, color: '#111111' } }),
  makePdfElement('field', { id: 'bath-field-material', label: 'Материал', source: 'detail.materials', x: 131.2, y: 17.7, w: 60.5, h: 6.4, style: { fontSize: 10.5, color: '#111111' } }),
  makePdfElement('text', { id: 'bath-label-thickness', label: 'Подпись Толщина', text: 'Толщина:', x: 194.7, y: 17.7, w: 28.9, h: 5.4, style: { fontSize: 10.5, color: '#111111' } }),
  makePdfElement('field', { id: 'bath-field-thickness', label: 'Толщина', source: 'detail.thicknesses', x: 223.7, y: 17.7, w: 60.5, h: 6.4, style: { fontSize: 10.5, color: '#111111' } }),
  makePdfElement('line', { id: 'bath-line-header-2', label: 'Линия шапки 2', x: 9.9, y: 24.3, w: 277.3, h: 0, style: { color: '#111111', strokeWidth: 0.25 } }),
  makePdfElement('text', { id: 'bath-label-film', label: 'Подпись Пленка', text: 'Пленка:', x: 9.9, y: 25.4, w: 28.9, h: 5.4, style: { fontSize: 10.5, color: '#111111' } }),
  makePdfElement('field', { id: 'bath-field-film', label: 'Пленка', source: 'detail.films', x: 38.8, y: 25.4, w: 245.4, h: 6.4, style: { fontSize: 10.5, color: '#111111' } }),
  makePdfElement('sheet_thumbnail', { id: 'bath-sheet-thumbnail', label: 'Миниатюра листа', source: 'sheet.thumbnail', x: 9.9, y: 37.4, w: 213.1, h: 150.6 }),
  makePdfElement('text', { id: 'bath-table-title', label: 'Заголовок листа', text: 'Лист', x: 227.9, y: 28.6, w: 24, h: 4.5, align: 'right', style: { fontSize: 10, color: '#111111' } }),
  makePdfElement('field', { id: 'bath-field-sheet-number', label: 'Номер листа', source: 'sheet.number', x: 252.5, y: 28.6, w: 34.7, h: 4.5, style: { fontSize: 10, color: '#111111' } }),
  makePdfElement('text', { id: 'bath-table-subtitle', label: 'Заголовок деталей', text: 'Детали', x: 227.9, y: 32.8, w: 59.3, h: 4.5, align: 'center', style: { fontSize: 9, color: '#111111' } }),
  makePdfElement('detail_table', { id: 'bath-detail-table', label: 'Таблица деталей', source: 'detail.table', x: 227.9, y: 37.4, w: 59.3, h: 118, style: { color: '#111111', strokeWidth: 0.18, fontSize: 6.8, headerFontSize: 6, rowHeight: 5.3, headerHeight: 5.6, columns: DEFAULT_PDF_DETAIL_TABLE_COLUMNS, sort: { field: 'detail.order', direction: 'asc' } } }),
  makePdfElement('machine_files_table', { id: 'bath-machine-files-table', label: 'Файлы станка', source: 'sheet.machine_files', x: 227.9, y: 158, w: 59.3, h: 24, style: { color: '#111111', strokeWidth: 0.18, fontSize: 6.8, headerFontSize: 6.8, rowHeight: 5.5, headerHeight: 5.8 } }),
  makePdfElement('line', { id: 'bath-line-footer', label: 'Линия итогов', x: 9.9, y: 181.3, w: 215.2, h: 0, style: { color: '#111111', strokeWidth: 0.25 } }),
  makePdfElement('text', { id: 'bath-label-sheet-size', label: 'Подпись Размер листа', text: 'Размер листа:', x: 16.9, y: 183.4, w: 35, h: 4.8, style: { fontSize: 9, color: '#111111' } }),
  makePdfElement('field', { id: 'bath-field-sheet-size', label: 'Размер листа', source: 'sheet.size', x: 52.5, y: 183.4, w: 40, h: 4.8, style: { fontSize: 9, color: '#111111' } }),
  makePdfElement('text', { id: 'bath-label-sheet-copy-count', label: 'Количество листов', text: '|  Кол-во - 1', x: 94, y: 183.4, w: 38, h: 4.8, style: { fontSize: 9, color: '#111111' } }),
  makePdfElement('text', { id: 'bath-label-detail-count', label: 'Подпись Количество деталей', text: 'Количество деталей:', x: 16.9, y: 188.4, w: 50, h: 4.8, style: { fontSize: 9, color: '#111111' } }),
  makePdfElement('field', { id: 'bath-field-detail-count', label: 'Количество деталей', source: 'sheet.details_count', x: 66.5, y: 188.4, w: 16, h: 4.8, style: { fontSize: 9, color: '#111111' } }),
  makePdfElement('text', { id: 'bath-label-detail-area', label: 'Подпись Площадь деталей', text: '|  Площадь деталей:', x: 83, y: 188.4, w: 49, h: 4.8, style: { fontSize: 9, color: '#111111' } }),
  makePdfElement('field', { id: 'bath-field-detail-area', label: 'Площадь деталей', source: 'sheet.area', x: 132, y: 188.4, w: 21, h: 4.8, style: { fontSize: 9, color: '#111111' } }),
  makePdfElement('text', { id: 'bath-label-area-unit', label: 'Ед. площади', text: 'м.кв.  |', x: 153.5, y: 188.4, w: 20, h: 4.8, style: { fontSize: 9, color: '#111111' } }),
  makePdfElement('text', { id: 'bath-label-utilization', label: 'Подпись Утилизация', text: 'Утилизация:', x: 174, y: 188.4, w: 34, h: 4.8, style: { fontSize: 9, color: '#111111' } }),
  makePdfElement('field', { id: 'bath-field-utilization', label: 'Утилизация', source: 'sheet.utilization', x: 208.5, y: 188.4, w: 17, h: 4.8, align: 'right', style: { fontSize: 9, color: '#111111' } }),
  makePdfElement('text', { id: 'bath-label-utilization-unit', label: 'Процент утилизации', text: '%', x: 226, y: 188.4, w: 6, h: 4.8, style: { fontSize: 9, color: '#111111' } }),
];

const PdfTemplateEditor: React.FC<PdfTemplateEditorProps> = ({ templates, canManage, onTemplateSaved }) => {
  const [drafts, setDrafts] = useState<PdfTemplateDraft[]>(() => loadPdfTemplateDrafts(templates));
  const [savingDraft, setSavingDraft] = useState(false);
  const [selectedCode, setSelectedCode] = useState(() => templates[0]?.code ?? drafts[0]?.code ?? 'standard');
  const [fieldCatalog, setFieldCatalog] = useState<PdfFieldCatalogItem[]>(PDF_FIELD_CATALOG);
  const [fieldCatalogError, setFieldCatalogError] = useState<string | null>(null);
  const [editingCustomFieldId, setEditingCustomFieldId] = useState<string | null>(null);
  const selected = drafts.find((draft) => draft.code === selectedCode) ?? drafts[0];
  const [selectedElementIds, setSelectedElementIds] = useState<string[]>(() => selected?.elements[0]?.id ? [selected.elements[0].id] : []);
  const [fieldSearch, setFieldSearch] = useState('');
  const [draggingField, setDraggingField] = useState<PdfFieldCatalogItem | null>(null);
  const [showAllBounds, setShowAllBounds] = useState(false);
  const [layoutMode, setLayoutMode] = useState<PdfTemplateEditorLayoutMode>('standard');
  const autoPublishingDraftCodesRef = useRef<Set<string>>(new Set());
  const templateCodes = useMemo(() => new Set(templates.map((template) => template.code)), [templates]);
  const wideCanvas = layoutMode === 'wide';
  const rightAccordionLayout = layoutMode === 'rightAccordion';
  const canvasFillsColumn = wideCanvas || rightAccordionLayout;
  const selectedElementId = selectedElementIds.at(-1) ?? null;
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
    const evaluated = evaluateCustomFieldPreviewValues(customFields, PDF_PREVIEW_VALUES, {
      collections: PDF_PREVIEW_COLLECTIONS,
    });
    return {
      ...PDF_PREVIEW_VALUES,
      ...evaluated,
      ...Object.fromEntries(Object.entries(evaluated).map(([key, value]) => [customFieldSourceId(key), value])),
    };
  }, [customFields]);
  const fieldPaletteColumnWidth = useMemo(() => estimatePdfFieldPaletteColumnWidth(fields), [fields]);
  const editorRowStyle = useMemo(
    () => ({ '--cut-pdf-field-panel-width': `${fieldPaletteColumnWidth}px` }) as React.CSSProperties,
    [fieldPaletteColumnWidth],
  );
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

  useEffect(() => {
    if (!selected) {
      setSelectedElementIds([]);
      return;
    }
    setSelectedElementIds((prev) => {
      const existing = prev.filter((id) => selected.elements.some((element) => element.id === id));
      return existing.length > 0 ? existing : selected.elements[0]?.id ? [selected.elements[0].id] : [];
    });
  }, [selected]);

  const updateSelected = useCallback((next: PdfTemplateDraft) => {
    setDrafts((prev) => prev.map((draft) => (draft.code === next.code ? next : draft)));
  }, []);

  const selectPdfElement = useCallback(
    (id: string | null, additive = false) => {
      if (!id || !selected) {
        setSelectedElementIds([]);
        return;
      }
      setSelectedElementIds((current) => selectPdfElements(selected.elements, current, id, additive));
    },
    [selected],
  );

  const renameSelectedTemplate = useCallback(
    (name: string) => {
      if (!selected) return;
      updateSelected({ ...selected, name });
    },
    [selected, updateSelected],
  );

  const patchElementById = useCallback(
    (id: string, patch: Partial<PdfTemplateElement>) => {
      if (!selected) return;
      const cleanPatch = compactPdfElementPatch(patch);
      updateSelected({
        ...selected,
        elements: selected.elements.map((element) => (element.id === id ? normalizePdfElement({ ...element, ...cleanPatch }) : element)),
      });
    },
    [selected, updateSelected],
  );

  const patchElementsById = useCallback(
    (patches: Array<{ id: string; patch: Partial<PdfTemplateElement> }>) => {
      if (!selected || patches.length === 0) return;
      const byId = new Map(patches.map(({ id, patch }) => [id, compactPdfElementPatch(patch)]));
      updateSelected({
        ...selected,
        elements: selected.elements.map((element) => {
          const patch = byId.get(element.id);
          return patch ? normalizePdfElement({ ...element, ...patch }) : element;
        }),
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
      setSelectedElementIds([element.id]);
    },
    [selected, updateSelected],
  );

  const addFieldElement = useCallback(
    (field: PdfFieldCatalogItem, x = 24, y = 28) => {
      const type: PdfTemplateElementType = field.id === 'sheet.thumbnail'
        ? 'sheet_thumbnail'
        : field.id === 'sheet.machine_files' || field.id === 'detail.machine_files'
          ? 'machine_files_table'
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
        w: type === 'sheet_thumbnail' ? 150 : type === 'detail_table' || type === 'machine_files_table' ? 82 : Math.min(80, Math.max(34, field.label.length * 3.2)),
        h: type === 'sheet_thumbnail' ? 90 : type === 'detail_table' ? 64 : type === 'machine_files_table' ? 28 : 8,
        align: 'left',
      });
    },
    [addElement],
  );

  const deleteElement = useCallback(
    (id: string) => {
      if (!selected) return;
      const ids = selectedElementIds.includes(id) ? selectedElementIds : selectPdfElements(selected.elements, [], id, false);
      const removed = new Set(ids);
      const nextElements = cleanupSingletonPdfGroups(selected.elements.filter((element) => !removed.has(element.id)));
      updateSelected({ ...selected, elements: nextElements });
      setSelectedElementIds(nextElements[0]?.id ? [nextElements[0].id] : []);
    },
    [selected, selectedElementIds, updateSelected],
  );

  const duplicateElement = useCallback(
    (id: string) => {
      if (!selected) return;
      const ids = selectedElementIds.includes(id) ? selectedElementIds : selectPdfElements(selected.elements, [], id, false);
      const source = selected.elements.filter((element) => ids.includes(element.id));
      if (source.length === 0) return;
      const groupId = source.length > 1 || source.some((element) => pdfElementGroupId(element))
        ? `pdf-group-copy-${Date.now().toString(36)}`
        : null;
      let zIndex = Math.max(0, ...selected.elements.map((element) => Number(element.zIndex ?? 0))) + 1;
      const copies = source.map((element, index) => normalizePdfElement(withPdfElementGroupId({
        ...element,
        id: `${element.type}-${Date.now().toString(36)}-${index}`,
        label: `${element.label} копия`,
        x: element.x + 4,
        y: element.y + 4,
        zIndex: zIndex++,
        style: { ...element.style, locked: false },
      }, groupId)));
      updateSelected({ ...selected, elements: [...selected.elements, ...copies] });
      setSelectedElementIds(copies.map((element) => element.id));
    },
    [selected, selectedElementIds, updateSelected],
  );

  const moveZ = useCallback(
    (ids: string[], direction: 'front' | 'back') => {
      if (!selected) return;
      const selectedIds = new Set(ids);
      const ordered = selected.elements.slice().sort((a, b) => a.zIndex - b.zIndex);
      const targets = ordered.filter((element) => selectedIds.has(element.id));
      if (targets.length === 0) return;
      const rest = ordered.filter((element) => !selectedIds.has(element.id));
      const next = direction === 'front' ? [...rest, ...targets] : [...targets, ...rest];
      updateSelected({ ...selected, elements: next.map((element, index) => ({ ...element, zIndex: index })) });
    },
    [selected, updateSelected],
  );

  const groupPdfElements = useCallback(
    (ids: string[]) => {
      if (!selected || ids.length < 2) return;
      const groupId = `pdf-group-${Date.now().toString(36)}`;
      const idSet = expandPdfSelectionIds(selected.elements, ids);
      const elements = selected.elements.map((element) => (idSet.has(element.id) ? withPdfElementGroupId(element, groupId) : element));
      updateSelected({ ...selected, elements });
      setSelectedElementIds(elements.filter((element) => pdfElementGroupId(element) === groupId).map((element) => element.id));
    },
    [selected, updateSelected],
  );

  const ungroupPdfElements = useCallback(
    (ids: string[]) => {
      if (!selected || ids.length === 0) return;
      const idSet = expandPdfSelectionIds(selected.elements, ids);
      updateSelected({
        ...selected,
        elements: selected.elements.map((element) => (idSet.has(element.id) ? withPdfElementGroupId(element, null) : element)),
      });
      setSelectedElementIds(selected.elements.filter((element) => idSet.has(element.id)).map((element) => element.id));
    },
    [selected, updateSelected],
  );

  const centerPdfElements = useCallback(
    (ids: string[], axis: 'horizontal' | 'vertical') => {
      if (!selected || ids.length === 0) return;
      const idSet = expandPdfSelectionIds(selected.elements, ids);
      const elements = selected.elements.filter((element) => idSet.has(element.id));
      const bounds = pdfElementsBounds(elements);
      if (!bounds) return;
      const deltaX = axis === 'horizontal' ? selected.page.width / 2 - (bounds.minX + bounds.maxX) / 2 : 0;
      const deltaY = axis === 'vertical' ? selected.page.height / 2 - (bounds.minY + bounds.maxY) / 2 : 0;
      patchElementsById(elements.map((element) => ({
        id: element.id,
        patch: {
          x: roundPdfMm(element.x + deltaX),
          y: roundPdfMm(element.y + deltaY),
        },
      })));
    },
    [patchElementsById, selected],
  );

  const publishDraftAsTemplate = useCallback(
    async (
      draft: PdfTemplateDraft,
      options: { code?: string; name?: string; select?: boolean; successMessage?: string } = {},
    ): Promise<CutPdfTemplate | null> => {
      const templateName = (options.name ?? draft.name).trim();
      if (!templateName) {
        message.error('Укажите название шаблона PDF');
        return null;
      }
      const normalizedDraft = normalizePdfDraft({
        ...draft,
        code: options.code ?? draft.code,
        name: templateName,
      });
      const layout = pdfDraftToLayout(normalizedDraft);
      setSavingDraft(true);
      try {
        const created = await cutConfigApi.createPdfTemplate({
          code: normalizedDraft.code,
          name: templateName,
          layout,
          isActive: true,
        });
        const createdDraft = pdfTemplateToDraft(created);
        setDrafts((prev) => {
          const next = prev.filter((item) => item.code !== draft.code && item.code !== created.code);
          return [...next, createdDraft];
        });
        if (options.select !== false) {
          setSelectedCode(created.code);
          setSelectedElementIds(createdDraft.elements[0]?.id ? [createdDraft.elements[0].id] : []);
        }
        clearStoredPdfTemplateDrafts();
        onTemplateSaved(created);
        message.success(options.successMessage ?? 'Шаблон PDF создан');
        return created;
      } catch (error) {
        message.error(formatPdfTemplateSaveError(error));
        return null;
      } finally {
        setSavingDraft(false);
      }
    },
    [onTemplateSaved],
  );

  const saveTemplateAsCopy = useCallback(async () => {
    if (!selected) return;
    if (!selected.name.trim()) {
      message.error('Укажите название шаблона PDF');
      return;
    }
    const templateName = makePdfTemplateCopyName(selected.name);
    const code = makePdfTemplateCopyCode(selected.code);
    const copy = normalizePdfDraft({
      ...selected,
      code,
      name: templateName,
      elements: selected.elements.map((element, index) => ({ ...element, id: `${element.id}-copy-${index}` })),
    });
    await publishDraftAsTemplate(copy, { code, name: templateName });
  }, [publishDraftAsTemplate, selected]);

  useEffect(() => {
    if (!canManage || savingDraft) return;
    const localDraft = drafts.find((draft) => !templateCodes.has(draft.code) && !autoPublishingDraftCodesRef.current.has(draft.code));
    if (!localDraft) return;
    autoPublishingDraftCodesRef.current.add(localDraft.code);
    void publishDraftAsTemplate(localDraft, {
      select: selectedCode === localDraft.code,
      successMessage: `Шаблон PDF «${localDraft.name}» опубликован`,
    });
  }, [canManage, drafts, publishDraftAsTemplate, savingDraft, selectedCode, templateCodes]);

  const saveDrafts = useCallback(async () => {
    if (!selected) return;
    const templateName = selected.name.trim();
    if (!templateName) {
      message.error('Укажите название шаблона PDF');
      return;
    }
    const normalizedSelected = { ...selected, name: templateName };
    const template = templates.find((item) => item.code === selected.code);
    const layout = pdfDraftToLayout(normalizedSelected);
    if (!template) {
      await publishDraftAsTemplate(normalizedSelected, { name: templateName });
      return;
    }
    setSavingDraft(true);
    try {
      const updated = await cutConfigApi.updatePdfTemplate(
        template.cutPdfTemplateId,
        { name: templateName, layout, isActive: template.isActive },
        template.version,
      );
      setDrafts((prev) => prev.map((draft) => (draft.code === updated.code ? pdfTemplateToDraft(updated) : draft)));
      onTemplateSaved(updated);
      message.success('Шаблон PDF сохранён');
    } catch (error) {
      message.error(formatPdfTemplateSaveError(error));
    } finally {
      setSavingDraft(false);
    }
  }, [publishDraftAsTemplate, selected, templates]);

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
  const selectedNameValid = selected.name.trim().length > 0;

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

  const renderFieldPalette = () => (
    <>
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
    </>
  );

  const renderCustomFields = () => (
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
  );

  const renderElementList = (scrollY = wideCanvas ? 320 : 260) => (
    <Table<PdfTemplateElement>
      size="small"
      rowKey="id"
      columns={elementRows}
      dataSource={selected.elements.slice().sort((a, b) => a.zIndex - b.zIndex)}
      pagination={false}
      scroll={{ y: scrollY }}
      rowClassName={(row) => (selectedElementIds.includes(row.id) ? 'ant-table-row-selected' : '')}
      onRow={(row) => ({ onClick: (event) => selectPdfElement(row.id, event.shiftKey), style: { cursor: 'pointer' } })}
    />
  );

  const renderElementProperties = () => selectedElement && (
    <PdfElementProperties
      element={selectedElement}
      fields={fields}
      canManage={canManage}
      onPatch={updateElement}
      onDelete={() => deleteElement(selectedElement.id)}
    />
  );

  const renderFieldPanel = () => (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small" title="Поля карты раскроя PDF">
        {renderFieldPalette()}
      </Card>
    </Space>
  );

  const renderCustomFieldPanel = () => (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Collapse>
        <Panel header="Пользовательские поля" key="custom-fields">
          {renderCustomFields()}
        </Panel>
      </Collapse>
    </Space>
  );

  const renderElementPanel = () => (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {renderElementList()}
      {renderElementProperties()}
    </Space>
  );

  const renderRightAccordionPanel = () => (
    <Collapse accordion defaultActiveKey="elements">
      <Panel header="Поля карты раскроя PDF" key="fields">
        {renderFieldPalette()}
      </Panel>
      <Panel header="Элементы шаблона" key="elements">
        {renderElementList(260)}
      </Panel>
      <Panel header="Свойства элемента" key="properties">
        {renderElementProperties() ?? <Text type="secondary">Выберите элемент</Text>}
      </Panel>
    </Collapse>
  );

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space wrap align="center">
        <Select
          value={selectedCode}
          onChange={(code) => {
            const draft = drafts.find((item) => item.code === code);
            setSelectedCode(code);
            setSelectedElementIds(draft?.elements[0]?.id ? [draft.elements[0].id] : []);
          }}
          options={drafts.map((draft) => ({ value: draft.code, label: draft.name }))}
          style={{ width: 320 }}
        />
        <Space align="center" size={6}>
          <Text type="secondary">Название</Text>
          <Input
            value={selected.name}
            disabled={!canManage || savingDraft}
            maxLength={200}
            status={selectedNameValid ? undefined : 'error'}
            placeholder="Название шаблона PDF"
            style={{ width: 280 }}
            onChange={(event) => renameSelectedTemplate(event.target.value)}
            onPressEnter={() => void saveDrafts()}
          />
        </Space>
        <Button icon={<SaveOutlined />} type="primary" disabled={!canManage || !selectedNameValid} loading={savingDraft} onClick={() => void saveDrafts()}>
          Сохранить
        </Button>
        <Button icon={<CopyOutlined />} disabled={!canManage || savingDraft || !selectedNameValid} loading={savingDraft} onClick={() => void saveTemplateAsCopy()}>
          Создать копию
        </Button>
        <Button disabled={!canManage || savingDraft || !selectedNameValid} loading={savingDraft} onClick={() => void saveTemplateAsCopy()}>
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
        <Button icon={<FileTextOutlined />} disabled={!canManage} onClick={() => addElement('machine_files_table')}>
          Файлы станка
        </Button>
        <Button icon={<MinusOutlined />} disabled={!canManage} onClick={() => addElement('line')}>
          Линия
        </Button>
        <Button icon={<BorderOutlined />} disabled={!canManage} onClick={() => addElement('rect')}>
          Прямоугольник
        </Button>
      </Space>

      <Row gutter={[16, 16]} align="top" className="cut-pdf-template-editor-row" style={editorRowStyle}>
        {!wideCanvas && !rightAccordionLayout && (
          <Col xs={24} className="cut-pdf-template-editor-field-col">
            {renderFieldPanel()}
          </Col>
        )}
        <Col xs={24} className={wideCanvas ? 'cut-pdf-template-editor-canvas-col cut-pdf-template-editor-canvas-col-wide' : 'cut-pdf-template-editor-canvas-col'}>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Card
              size="small"
              title="Визуал карты раскроя PDF"
              extra={(
                <Space size={12} wrap>
                  <Checkbox checked={wideCanvas} onChange={(event) => setLayoutMode(event.target.checked ? 'wide' : 'standard')}>
                    Широкий визуал
                  </Checkbox>
                  <Checkbox checked={rightAccordionLayout} onChange={(event) => setLayoutMode(event.target.checked ? 'rightAccordion' : 'standard')}>
                    Панели справа
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
                selectedElementIds={selectedElementIds}
                canManage={canManage}
                showAllBounds={showAllBounds}
                wideCanvas={canvasFillsColumn}
                draggingField={draggingField}
                onSelect={selectPdfElement}
                onPatch={patchElementById}
                onPatchMany={patchElementsById}
                onDelete={deleteElement}
                onDuplicate={duplicateElement}
                onMoveZ={moveZ}
                onGroup={groupPdfElements}
                onUngroup={ungroupPdfElements}
                onCenter={centerPdfElements}
                onDropField={(field, x, y) => {
                  addFieldElement(field, x, y);
                  setDraggingField(null);
                }}
              />
            </Card>
            {renderCustomFieldPanel()}
          </Space>
        </Col>
        {rightAccordionLayout && (
          <Col xs={24} className="cut-pdf-template-editor-field-col">
            {renderRightAccordionPanel()}
          </Col>
        )}
        {!wideCanvas && !rightAccordionLayout && (
          <Col xs={24} className="cut-pdf-template-editor-side-col">
            {renderElementPanel()}
          </Col>
        )}
        {wideCanvas && !rightAccordionLayout && (
          <>
            <Col xs={24} className="cut-pdf-template-editor-wide-half-col">
              {renderFieldPanel()}
            </Col>
            <Col xs={24} className="cut-pdf-template-editor-wide-half-col">
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
            aggregateSources={PDF_AGGREGATE_SOURCES}
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
  selectedElementIds: string[];
  canManage: boolean;
  showAllBounds: boolean;
  wideCanvas: boolean;
  draggingField: PdfFieldCatalogItem | null;
  onSelect: (id: string | null, additive?: boolean) => void;
  onPatch: (id: string, patch: Partial<PdfTemplateElement>) => void;
  onPatchMany: (patches: Array<{ id: string; patch: Partial<PdfTemplateElement> }>) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onMoveZ: (ids: string[], direction: 'front' | 'back') => void;
  onGroup: (ids: string[]) => void;
  onUngroup: (ids: string[]) => void;
  onCenter: (ids: string[], axis: 'horizontal' | 'vertical') => void;
  onDropField: (field: PdfFieldCatalogItem, x: number, y: number) => void;
}> = ({
  draft,
  fields,
  previewValues,
  selectedElementIds,
  canManage,
  showAllBounds,
  wideCanvas,
  draggingField,
  onSelect,
  onPatch,
  onPatchMany,
  onDelete,
  onDuplicate,
  onMoveZ,
  onGroup,
  onUngroup,
  onCenter,
  onDropField,
}) => {
  const stageRef = useRef<Konva.Stage | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const nodeRefs = useRef(new Map<string, Konva.Node>());
  const dragGestureRef = useRef<{
    ownerId: string;
    ownerStart: { x: number; y: number };
    ids: string[];
    starts: Map<string, { x: number; y: number }>;
  } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [showGrid, setShowGrid] = useState(false);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [contextMenu, setContextMenu] = useState<{ elementId: string; x: number; y: number } | null>(null);
  const page = draft.page;
  const defaultPreviewBaseWidth = Math.min(900, Math.max(520, page.width * 3));
  const widePreviewBaseWidth = viewportWidth > 0 ? Math.max(320, viewportWidth) : defaultPreviewBaseWidth;
  const previewWidth = Math.round((wideCanvas ? widePreviewBaseWidth : defaultPreviewBaseWidth) * zoom);
  const previewHeight = previewWidth * (page.height / page.width);
  const selectedElementId = selectedElementIds.at(-1) ?? null;
  const selectedElements = draft.elements.filter((element) => selectedElementIds.includes(element.id));
  const selected = draft.elements.find((element) => element.id === selectedElementId) ?? null;
  const selectedLocked = selectedElements.some((element) => Boolean(element.style.locked));
  const contextElement = contextMenu ? draft.elements.find((element) => element.id === contextMenu.elementId) ?? null : null;
  const contextIds = contextElement && selectedElementIds.includes(contextElement.id)
    ? selectedElementIds
    : contextElement
      ? selectPdfElements(draft.elements, [], contextElement.id, false)
      : [];
  const contextElements = draft.elements.filter((element) => contextIds.includes(element.id));
  const contextBounds = pdfElementsBounds(contextElements);
  const contextTextElement = contextElements.find((element) => ['text', 'field', 'custom'].includes(element.type)) ?? null;
  const contextHasGroup = contextElements.some((element) => Boolean(pdfElementGroupId(element)));
  const contextAllLocked = contextElements.length > 0 && contextElements.every((element) => Boolean(element.style.locked));
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
    if (!canManage || selectedElementIds.length === 0 || selectedLocked || draggingField) {
      transformerRef.current?.nodes([]);
      transformerRef.current?.getLayer()?.batchDraw();
      return;
    }
    const nodes = selectedElementIds
      .map((id) => nodeRefs.current.get(id))
      .filter((node): node is Konva.Node => Boolean(node));
    transformerRef.current?.nodes(nodes);
    transformerRef.current?.getLayer()?.batchDraw();
  }, [canManage, draft.elements, draggingField, selectedElementIds, selectedLocked]);

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
    const next: Partial<PdfTemplateElement> = {};
    if (patch.x !== undefined) next.x = roundPdfMm(clamp(snap(patch.x, free), 0, page.width));
    if (patch.y !== undefined) next.y = roundPdfMm(clamp(snap(patch.y, free), 0, page.height));
    if (patch.w !== undefined) next.w = roundPdfMm(Math.max(0.5, snap(patch.w, free)));
    if (patch.h !== undefined) next.h = roundPdfMm(Math.max(element.type === 'line' ? 0 : 0.5, snap(patch.h, free)));
    if (patch.rotation !== undefined) next.rotation = roundPdfMm(patch.rotation);
    onPatch(element.id, next);
  };
  const moveElement = (element: PdfTemplateElement, x: number, y: number, event?: { altKey?: boolean }) => {
    if (element.style.locked) return;
    const moving = selectedElementIds.includes(element.id) ? selectedElements : [element];
    const bounds = pdfElementsBounds(moving);
    if (!bounds) return;
    const deltaX = clamp(x - element.x, -bounds.minX, page.width - bounds.maxX);
    const deltaY = clamp(y - element.y, -bounds.minY, page.height - bounds.maxY);
    onPatchMany(moving.map((item) => ({
      id: item.id,
      patch: {
        x: roundPdfMm(snap(item.x + deltaX, event?.altKey)),
        y: roundPdfMm(snap(item.y + deltaY, event?.altKey)),
      },
    })));
  };
  const beginDragElement = (element: PdfTemplateElement, node: Konva.Node, event: Konva.KonvaEventObject<DragEvent>) => {
    onSelect(element.id, event.evt.shiftKey);
    const ids = selectedElementIds.includes(element.id) ? selectedElementIds : selectPdfElements(draft.elements, [], element.id, false);
    const starts = new Map<string, { x: number; y: number }>();
    for (const id of ids) {
      const selectedNode = nodeRefs.current.get(id);
      if (selectedNode) starts.set(id, { x: selectedNode.x(), y: selectedNode.y() });
    }
    dragGestureRef.current = {
      ownerId: element.id,
      ownerStart: starts.get(element.id) ?? { x: node.x(), y: node.y() },
      ids,
      starts,
    };
  };
  const dragMoveElement = (element: PdfTemplateElement, node: Konva.Node, event: Konva.KonvaEventObject<DragEvent>) => {
    const gesture = dragGestureRef.current;
    if (!gesture || gesture.ownerId !== element.id) return;
    const moving = draft.elements.filter((item) => gesture.ids.includes(item.id));
    const bounds = pdfElementsBounds(moving);
    if (!bounds) return;
    const targetX = snap(node.x(), event.evt.altKey);
    const targetY = snap(node.y(), event.evt.altKey);
    const deltaX = clamp(targetX - gesture.ownerStart.x, -bounds.minX, page.width - bounds.maxX);
    const deltaY = clamp(targetY - gesture.ownerStart.y, -bounds.minY, page.height - bounds.maxY);
    for (const [id, start] of gesture.starts.entries()) {
      nodeRefs.current.get(id)?.position({ x: start.x + deltaX, y: start.y + deltaY });
    }
  };
  const endDragElement = (element: PdfTemplateElement) => {
    const gesture = dragGestureRef.current;
    if (!gesture || gesture.ownerId !== element.id) return;
    onPatchMany(Array.from(gesture.starts, ([id]) => {
      const node = nodeRefs.current.get(id);
      return node ? { id, patch: { x: roundPdfMm(node.x()), y: roundPdfMm(node.y()) } } : null;
    }).filter((item): item is { id: string; patch: Partial<PdfTemplateElement> } => Boolean(item)));
    dragGestureRef.current = null;
  };
  const transformSelectionEnd = (event: Konva.KonvaEventObject<Event>) => {
    if (selectedElements.length === 0 || selectedLocked) return;
    const free = (event.evt as MouseEvent | PointerEvent | undefined)?.altKey;
    const patches = selectedElements.flatMap((element) => {
      const node = nodeRefs.current.get(element.id);
      if (!node) return [];
      const scaleX = node.scaleX();
      const scaleY = node.scaleY();
      node.scaleX(1);
      node.scaleY(1);
      const nextW = element.type === 'line' ? element.w * scaleX : Math.max(1, Number(node.width() || element.w) * scaleX);
      const nextH = element.type === 'line' ? element.h * scaleY : Math.max(1, Number(node.height() || element.h) * scaleY);
      return [{
        id: element.id,
        patch: {
          x: roundPdfMm(clamp(snap(node.x(), free), 0, page.width)),
          y: roundPdfMm(clamp(snap(node.y(), free), 0, page.height)),
          w: roundPdfMm(Math.max(0.5, snap(nextW, free))),
          h: roundPdfMm(Math.max(element.type === 'line' ? 0 : 0.5, snap(nextH, free))),
          rotation: roundPdfMm(Number(node.rotation() ?? 0)),
        },
      }];
    });
    onPatchMany(patches);
  };
  const openContextMenu = (point: { x: number; y: number }) => {
    if (!canManage) return;
    const element = findTopPdfElement(sorted, point.x, point.y);
    if (!element) {
      setContextMenu(null);
      return;
    }
    if (!selectedElementIds.includes(element.id)) onSelect(element.id);
    setContextMenu({ elementId: element.id, x: (point.x / page.width) * previewWidth, y: (point.y / page.height) * previewHeight });
  };
  const patchContextStyle = (patch: Record<string, unknown>) => {
    onPatchMany(contextElements.filter((element) => !element.style.locked).map((element) => ({
      id: element.id,
      patch: { style: { ...element.style, ...patch } },
    })));
  };
  const setContextAlign = (align: PdfTextAlign) => {
    onPatchMany(contextElements.filter((element) => isPdfTextElement(element) && !element.style.locked).map((element) => ({
      id: element.id,
      patch: { align },
    })));
    setContextMenu(null);
  };
  const toggleContextLock = () => {
    onPatchMany(contextElements.map((element) => ({
      id: element.id,
      patch: { style: { ...element.style, locked: !contextAllLocked } },
    })));
    setContextMenu(null);
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
                  selected={selectedElementIds.includes(element.id)}
                  interactive={canManage && !draggingField}
                  showAllBounds={showAllBounds}
                  nodeRef={(node) => {
                    if (node) nodeRefs.current.set(element.id, node);
                    else nodeRefs.current.delete(element.id);
                  }}
                  onSelect={(event) => onSelect(element.id, event.evt.shiftKey)}
                  onDragStart={(node, event) => beginDragElement(element, node, event)}
                  onDragMove={(node, event) => dragMoveElement(element, node, event)}
                  onDragEnd={() => endDragElement(element)}
                />
              ))}
              {canManage && !draggingField && (
                <Transformer
                  ref={transformerRef}
                  rotateEnabled
                  enabledAnchors={selected?.type === 'line' ? ['middle-left', 'middle-right'] : undefined}
                  boundBoxFunc={(oldBox, newBox) => (newBox.width < 2 || newBox.height < 2 ? oldBox : newBox)}
                  onTransformEnd={transformSelectionEnd}
                />
              )}
            </Layer>
          </Stage>
          {contextMenu && contextElement && contextBounds && (
            <div
              data-cut-pdf-context-menu
              style={{
                position: 'absolute',
                left: Math.min(contextMenu.x + 6, Math.max(8, previewWidth - 252)),
                top: Math.min(contextMenu.y + 6, Math.max(8, previewHeight - 420)),
                zIndex: 3,
                minWidth: 244,
                padding: 4,
                background: '#fff',
                border: '1px solid #d9d9d9',
                borderRadius: 4,
                boxShadow: '0 6px 16px rgba(0,0,0,0.16)',
              }}
              onMouseLeave={() => setContextMenu(null)}
            >
              <div style={{ padding: '4px 6px 7px', borderBottom: '1px solid #f0f0f0', marginBottom: 3 }}>
                <Text strong style={{ display: 'block', fontSize: 12 }}>
                  {contextElements.length > 1 ? `Выбрано: ${contextElements.length}` : pdfElementContextTitle(contextElement, fieldLabels)}
                </Text>
                <Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 3 }}>
                  X {roundPdfMm(contextBounds.minX)} · Y {roundPdfMm(contextBounds.minY)} · {roundPdfMm(contextBounds.width)} × {roundPdfMm(contextBounds.height)} мм
                </Text>
              </div>
              {contextTextElement && (
                <div style={{ padding: '4px 4px 6px' }}>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>
                    Шрифт
                  </Text>
                  <Space.Compact block style={{ marginBottom: 6 }}>
                    <InputNumber
                      aria-label="Размер шрифта в контекстном меню PDF"
                      min={2}
                      max={96}
                      addonAfter="pt"
                      value={Number(contextTextElement.style.fontSize ?? 10)}
                      disabled={contextElements.some((element) => Boolean(element.style.locked))}
                      onChange={(value) => patchContextStyle({ fontSize: Number(value ?? 10) })}
                    />
                    <Button
                      type={contextTextElement.style.fontWeight === 'bold' ? 'primary' : 'default'}
                      disabled={contextElements.some((element) => Boolean(element.style.locked))}
                      onClick={() => patchContextStyle({ fontWeight: contextTextElement.style.fontWeight === 'bold' ? 'normal' : 'bold' })}
                    >
                      <strong>Ж</strong>
                    </Button>
                    <Button
                      type={contextTextElement.style.fontItalic === true ? 'primary' : 'default'}
                      disabled={contextElements.some((element) => Boolean(element.style.locked))}
                      onClick={() => patchContextStyle({ fontItalic: contextTextElement.style.fontItalic !== true })}
                    >
                      <em>К</em>
                    </Button>
                  </Space.Compact>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>
                    Выравнивание значения
                  </Text>
                  <Space.Compact block>
                    <Tooltip title="Выровнять значение по левой стороне поля">
                      <Button size="small" icon={<AlignLeftOutlined />} type={contextTextElement.align === 'left' ? 'primary' : 'default'} disabled={contextElements.some((element) => Boolean(element.style.locked))} onClick={() => setContextAlign('left')} />
                    </Tooltip>
                    <Tooltip title="Выровнять значение по центру поля">
                      <Button size="small" icon={<AlignCenterOutlined />} type={contextTextElement.align === 'center' ? 'primary' : 'default'} disabled={contextElements.some((element) => Boolean(element.style.locked))} onClick={() => setContextAlign('center')} />
                    </Tooltip>
                    <Tooltip title="Выровнять значение по правой стороне поля">
                      <Button size="small" icon={<AlignRightOutlined />} type={contextTextElement.align === 'right' ? 'primary' : 'default'} disabled={contextElements.some((element) => Boolean(element.style.locked))} onClick={() => setContextAlign('right')} />
                    </Tooltip>
                  </Space.Compact>
                </div>
              )}
              <Button type="text" size="small" block disabled={contextElements.some((element) => Boolean(element.style.locked))} onClick={() => { onCenter(contextIds, 'horizontal'); setContextMenu(null); }}>
                По горизонтальному центру канваса
              </Button>
              <Button type="text" size="small" block disabled={contextElements.some((element) => Boolean(element.style.locked))} onClick={() => { onCenter(contextIds, 'vertical'); setContextMenu(null); }}>
                По вертикальному центру канваса
              </Button>
              {contextElements.length > 1 && (
                <Button type="text" size="small" block disabled={contextElements.some((element) => Boolean(element.style.locked))} onClick={() => { onGroup(contextIds); setContextMenu(null); }}>
                  {contextHasGroup ? 'Перегруппировать выделение' : 'Сгруппировать'}
                </Button>
              )}
              {contextHasGroup && (
                <Button type="text" size="small" block disabled={contextElements.some((element) => Boolean(element.style.locked))} onClick={() => { onUngroup(contextIds); setContextMenu(null); }}>
                  Разгруппировать
                </Button>
              )}
              <Button type="text" size="small" block onClick={toggleContextLock}>
                {contextAllLocked ? 'Разблокировать' : 'Заблокировать'}
              </Button>
              <Button type="text" size="small" block onClick={() => { onDuplicate(contextElement.id); setContextMenu(null); }}>
                Сделать копию
              </Button>
              <Button type="text" size="small" block onClick={() => { onMoveZ(contextIds, 'front'); setContextMenu(null); }}>
                На передний план
              </Button>
              <Button type="text" size="small" block onClick={() => { onMoveZ(contextIds, 'back'); setContextMenu(null); }}>
                На задний план
              </Button>
              <Button danger type="text" size="small" block onClick={() => { onDelete(contextElement.id); setContextMenu(null); }}>
                Удалить
              </Button>
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
  onSelect: (event: Konva.KonvaEventObject<MouseEvent>) => void;
  onDragStart: (node: Konva.Node, event: Konva.KonvaEventObject<DragEvent>) => void;
  onDragMove: (node: Konva.Node, event: Konva.KonvaEventObject<DragEvent>) => void;
  onDragEnd: () => void;
}> = ({ element, fieldLabels, previewValues, selected, interactive, showAllBounds, nodeRef, onSelect, onDragStart, onDragMove, onDragEnd }) => {
  const common = {
    ref: nodeRef,
    x: element.x,
    y: element.y,
    rotation: element.rotation,
    listening: interactive,
    draggable: interactive && !element.style.locked,
    onClick: onSelect,
    onTap: onSelect,
    onDragStart: (event: Konva.KonvaEventObject<DragEvent>) => onDragStart(event.target, event),
    onDragMove: (event: Konva.KonvaEventObject<DragEvent>) => onDragMove(event.target, event),
    onDragEnd,
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
      { x: w * 0.07, y: h * 0.08, w: w * 0.34, h: h * 0.24, order: '11380', widthLabel: '800', heightLabel: '240', edge: 'ПВХ 2мм', milling: 'Модерн', doweling: true },
      { x: w * 0.45, y: h * 0.08, w: w * 0.46, h: h * 0.18, order: '11380', widthLabel: '780', heightLabel: '180', edge: 'ABS 1мм', milling: 'Паз', doweling: false },
      { x: w * 0.08, y: h * 0.38, w: w * 0.26, h: h * 0.48, order: '11381', widthLabel: '1100', heightLabel: '320', edge: '—', milling: 'Модерн', doweling: true },
      { x: w * 0.39, y: h * 0.35, w: w * 0.52, h: h * 0.38, order: '11382', widthLabel: '950', heightLabel: '420', edge: 'ПВХ 2мм', milling: 'Классика', doweling: false },
    ];
    return (
      <React.Fragment>
        <KonvaGroup {...common} width={w} height={h}>
          <KonvaRect x={0} y={0} width={w} height={h} fill="#ffffff" stroke={String(element.style.color ?? '#111111')} strokeWidth={Number(element.style.strokeWidth ?? 0.25)} />
          {pieces.map((piece, index) => {
            const detailFontSize = Math.max(1.8, Math.min(3.8, Math.min(piece.w, piece.h) * 0.12));
            const orderFontSize = detailFontSize * 1.25;
            const detailMetaFontSize = orderFontSize / 2;
            const detailMetaLines = [piece.edge, piece.milling, ...(piece.doweling ? ['присадка'] : [])];
            const detailMetaHeight = detailMetaFontSize * detailMetaLines.length;
            const standardDimensionFontSize = 3.8 * PDF_DETAIL_DIMENSION_FONT_SCALE;
            const widthDimensionFontSize = fitPdfDetailDimensionFont(
              piece.widthLabel,
              piece.w,
              piece.h,
              standardDimensionFontSize,
              'horizontal',
            );
            const heightDimensionFontSize = fitPdfDetailDimensionFont(
              piece.heightLabel,
              piece.h,
              piece.w,
              standardDimensionFontSize,
              'vertical',
            );
            return (
              <KonvaGroup
                key={index}
                x={piece.x}
                y={piece.y}
                width={piece.w}
                height={piece.h}
                clipX={0}
                clipY={0}
                clipWidth={piece.w}
                clipHeight={piece.h}
                listening={false}
              >
                <KonvaRect x={0} y={0} width={piece.w} height={piece.h} fill={pieceColor[index % pieceColor.length]} stroke="#334155" strokeWidth={0.18} listening={false} />
                <KonvaText
                  x={1}
                  y={0.5}
                  width={Math.max(1, piece.w - 2)}
                  text={piece.widthLabel}
                  fontFamily="Arial"
                  fontSize={widthDimensionFontSize}
                  align="center"
                  fill="#111111"
                  listening={false}
                />
                <KonvaText
                  x={heightDimensionFontSize * 0.9}
                  y={piece.h - 1}
                  width={Math.max(1, piece.h - 2)}
                  text={piece.heightLabel}
                  fontFamily="Arial"
                  fontSize={heightDimensionFontSize}
                  align="center"
                  fill="#111111"
                  rotation={-90}
                  listening={false}
                />
                <KonvaText
                  x={heightDimensionFontSize * 1.25}
                  y={Math.max(widthDimensionFontSize * 1.4, piece.h * 0.4)}
                  width={Math.max(1, piece.w - heightDimensionFontSize * 1.5)}
                  text={piece.order}
                  fontFamily="Arial"
                  fontSize={orderFontSize}
                  fontStyle="bold"
                  fill="#7f1d1d"
                  stroke="#7f1d1d"
                  strokeWidth={detailFontSize * 0.04}
                  align="center"
                  listening={false}
                />
                <KonvaText
                  x={1}
                  y={Math.max(1, piece.h - detailMetaHeight - detailMetaFontSize * 0.05)}
                  width={Math.max(1, piece.w - 2)}
                  height={detailMetaHeight}
                  text={detailMetaLines.join('\n')}
                  fontFamily="Arial"
                  fontSize={detailMetaFontSize}
                  lineHeight={1}
                  align="right"
                  verticalAlign="bottom"
                  fill="#111111"
                  listening={false}
                />
              </KonvaGroup>
            );
          })}
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
  if (element.type === 'machine_files_table') {
    const w = Math.max(element.w, 1);
    const h = Math.max(element.h, 1);
    const headerH = Math.min(7, h * 0.28);
    const rowH = Math.max(4.5, Math.min(7, (h - headerH) / 3));
    const files = ['CNC#1_11380.TXT', 'CNC#2_11380.TXT'];
    return (
      <React.Fragment>
        <KonvaGroup {...common} width={w} height={h}>
          <KonvaRect x={0} y={0} width={w} height={h} fill="#ffffff" stroke={String(element.style.color ?? '#111111')} strokeWidth={0.22} />
          <KonvaRect x={0} y={0} width={w} height={headerH} fill="#f5f5f5" stroke="#111111" strokeWidth={0.16} listening={false} />
          <KonvaText x={0.8} y={1} width={Math.max(1, w - 1.6)} height={headerH - 1} text="Файлы станка" fontFamily="Arial" fontSize={Math.max(2.2, Math.min(3.4, headerH * 0.42))} align="center" wrap="word" ellipsis listening={false} />
          {files.map((file, rowIndex) => (
            <React.Fragment key={file}>
              <KonvaRect x={0} y={headerH + rowIndex * rowH} width={w} height={rowH} fill="#ffffff" stroke="#111111" strokeWidth={0.12} listening={false} />
              <KonvaText x={0.8} y={headerH + rowIndex * rowH + 1} width={Math.max(1, w - 1.6)} height={rowH - 1} text={file} fontFamily="Arial" fontSize={Math.max(2, Math.min(3, rowH * 0.42))} align="center" wrap="word" ellipsis listening={false} />
            </React.Fragment>
          ))}
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
        fontStyle={[
          element.style.fontWeight === 'bold' ? 'bold' : '',
          element.style.fontItalic === true ? 'italic' : '',
        ].filter(Boolean).join(' ') || 'normal'}
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
    <Space className="cut-pdf-template-editor-field-palette" direction="vertical" size={8} style={{ width: '100%' }}>
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
  const tableFields = uniquePdfFields(fields.filter(isPdfDetailTableField));
  const tableFieldLabels = fieldLabelsFromList(tableFields);
  const tableFieldOptions = tableFields.map((field) => ({ value: field.id, label: `${field.category}: ${field.label}` }));
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
              { value: 'machine_files_table', label: 'Файлы станка' },
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
        {element.type === 'detail_table' && (
          <Space direction="vertical" size={8} style={{ width: '100%', marginBottom: 10 }}>
            <Text strong>Таблица деталей</Text>
            <Space.Compact block>
              <Select
                showSearch
                value={tableSort.field}
                disabled={!canManage}
                options={tableFieldOptions}
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
                      options={tableFieldOptions}
                      onChange={(field) => patchTableColumn(index, { field, label: tableFieldLabels.get(field) ?? field })}
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
          <Col span={8}><NumberBox label="Шрифт" value={Number(style.fontSize ?? 10)} disabled={!canManage || !['text', 'field', 'custom', 'detail_table', 'machine_files_table'].includes(element.type)} onChange={(fontSize) => onPatch({ style: { ...style, fontSize } })} /></Col>
          <Col span={8}><NumberBox label="Линия" value={Number(style.strokeWidth ?? 0.35)} disabled={!canManage || !['line', 'rect', 'sheet_thumbnail', 'detail_table', 'machine_files_table'].includes(element.type)} onChange={(strokeWidth) => onPatch({ style: { ...style, strokeWidth } })} /></Col>
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

function clearStoredPdfTemplateDrafts(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(PDF_TEMPLATE_DRAFTS_KEY);
  } catch {
    // Storage may be unavailable; backend templates remain authoritative.
  }
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
    ...layoutToPdfDraftShape(template.layout, template.code),
  });
}

function makePdfTemplateCopyCode(code: string): string {
  const suffix = `_copy_${Date.now().toString(36)}`;
  const base = code.slice(0, Math.max(1, 100 - suffix.length));
  return `${base}${suffix}`;
}

function makePdfTemplateCopyName(name: string): string {
  return `${name.trim()} копия`.trim().slice(0, 200);
}

function layoutToPdfDraftShape(layout: Record<string, unknown>, templateCode = 'standard'): Pick<PdfTemplateDraft, 'page' | 'customFields' | 'elements'> {
  const fallbackElements = defaultPdfElementsForTemplateCode(templateCode);
  const page = isRecord(layout.page) ? {
    width: Number(layout.page.width ?? PDF_PAGE.width),
    height: Number(layout.page.height ?? PDF_PAGE.height),
  } : PDF_PAGE;
  const customFields = isRecord(layout.customFieldSchema)
    ? customFieldRowsFromSchema(layout.customFieldSchema)
    : Array.isArray(layout.customFields)
      ? layout.customFields.map(normalizeCustomField)
      : [];
  const rawElements = Array.isArray(layout.elements) && layout.elements.length > 0 ? layout.elements : fallbackElements;
  return { page, customFields, elements: upgradeDefaultPdfElements(rawElements.map((element, index) => normalizePdfElement(element, index))) };
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
  const code = String(raw.code ?? 'standard');
  const fallbackElements = defaultPdfElementsForTemplateCode(code);
  return {
    code,
    name: String(raw.name ?? 'Стандартный'),
    page: {
      width: Number(raw.page?.width ?? PDF_PAGE.width),
      height: Number(raw.page?.height ?? PDF_PAGE.height),
    },
    customFields: Array.isArray(raw.customFields) ? raw.customFields.map(normalizeCustomField) : [],
    elements: upgradeDefaultPdfElements((Array.isArray(raw.elements) && raw.elements.length > 0 ? raw.elements : fallbackElements).map((element, index) => normalizePdfElement(element, index))),
  };
}

function defaultPdfElementsForTemplateCode(templateCode: string): PdfTemplateElement[] {
  return templateCode === 'bath_profiles' ? BATH_PROFILE_PDF_ELEMENTS : DEFAULT_PDF_ELEMENTS;
}

function normalizeCustomField(raw: unknown): CustomFieldSchemaRow {
  const r = isRecord(raw) ? raw : {};
  const type = r.type === 'number' || r.type === 'date' || r.type === 'boolean' ? r.type : 'string';
  const sourceField = typeof r.sourceField === 'string' ? r.sourceField : null;
  const expression = readCustomFieldExpressionV1(r);
  const hasDefaultValue = Object.prototype.hasOwnProperty.call(r, 'defaultValue');
  const valueMode = expression ? 'expression' : sourceField ? 'source' : 'constant';
  return {
    fieldId: customFieldSourceId(String(r.fieldId ?? r.id ?? 'field').trim()),
    label: String(r.label ?? r.fieldId ?? r.id ?? 'Поле').trim(),
    type,
    valueMode,
    sourceField,
    defaultValue: hasDefaultValue ? r.defaultValue : '',
    expression,
    extra: Object.fromEntries(
      Object.entries(r).filter(([key]) => !['fieldId', 'id', 'label', 'type', 'sourceField', 'defaultValue', 'expression'].includes(key)),
    ),
  };
}

function normalizePdfElement(raw: unknown, index = 0): PdfTemplateElement {
  const r = isRecord(raw) ? raw : {};
  if (typeof r.type === 'string' && (r.type === 'field' || r.type === 'line' || r.type === 'rect') && typeof r.x === 'number' && r.x > PDF_PAGE.width) {
    const type = r.type as PdfTemplateElementType;
    return makePdfElement(r.type as PdfTemplateElementType, {
      id: String(r.id ?? `${r.type}-${index}`),
      label: String(r.label ?? pdfElementTypeLabel(type)),
      source: typeof r.source === 'string' ? r.source : null,
      x: roundPdfMm((Number(r.x ?? 0) / PDF_OLD_PAGE.width) * PDF_PAGE.width),
      y: roundPdfMm((Number(r.y ?? 0) / PDF_OLD_PAGE.height) * PDF_PAGE.height),
      w: roundPdfMm((Number(r.w ?? 24) / PDF_OLD_PAGE.width) * PDF_PAGE.width),
      h: roundPdfMm((Number(r.h ?? 8) / PDF_OLD_PAGE.height) * PDF_PAGE.height),
      align: r.align === 'right' || r.align === 'center' ? r.align : 'left',
      zIndex: Number(r.zIndex ?? index),
      style: normalizePdfElementStyle(type, isRecord(r.style) ? r.style : {}),
    });
  }
  const type = isPdfElementType(r.type) ? r.type : 'field';
  const style = normalizePdfElementStyle(type, isRecord(r.style) ? r.style : {});
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
    style,
  });
}

function normalizePdfElementStyle(type: PdfTemplateElementType, style: Record<string, unknown>): Record<string, unknown> {
  return type === 'sheet_thumbnail' ? { ...style, fit: 'stretch' } : style;
}

function compactPdfElementPatch(patch: Partial<PdfTemplateElement>): Partial<PdfTemplateElement> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<PdfTemplateElement>;
}

function isPdfTextElement(element: PdfTemplateElement): boolean {
  return element.type === 'text' || element.type === 'field' || element.type === 'custom';
}

function pdfElementGroupId(element: PdfTemplateElement): string | null {
  const value = element.style.groupId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function withPdfElementGroupId(element: PdfTemplateElement, groupId: string | null): PdfTemplateElement {
  const style = { ...element.style };
  if (groupId) style.groupId = groupId;
  else delete style.groupId;
  return { ...element, style };
}

function selectPdfElements(elements: PdfTemplateElement[], currentIds: string[], elementId: string, additive: boolean): string[] {
  const unit = pdfSelectionUnit(elements, elementId);
  if (!additive) return unit;
  const selected = new Set(currentIds);
  const remove = unit.length > 0 && unit.every((id) => selected.has(id));
  for (const id of unit) {
    if (remove) selected.delete(id);
    else selected.add(id);
  }
  return elements.map((element) => element.id).filter((id) => selected.has(id));
}

function expandPdfSelectionIds(elements: PdfTemplateElement[], ids: string[]): Set<string> {
  const expanded = new Set<string>();
  for (const id of ids) {
    for (const unitId of pdfSelectionUnit(elements, id)) expanded.add(unitId);
  }
  return expanded;
}

function cleanupSingletonPdfGroups(elements: PdfTemplateElement[]): PdfTemplateElement[] {
  const counts = new Map<string, number>();
  for (const element of elements) {
    const groupId = pdfElementGroupId(element);
    if (groupId) counts.set(groupId, (counts.get(groupId) ?? 0) + 1);
  }
  return elements.map((element) => {
    const groupId = pdfElementGroupId(element);
    return groupId && counts.get(groupId) === 1 ? withPdfElementGroupId(element, null) : element;
  });
}

function pdfSelectionUnit(elements: PdfTemplateElement[], elementId: string): string[] {
  const target = elements.find((element) => element.id === elementId);
  if (!target) return [];
  const groupId = pdfElementGroupId(target);
  return groupId
    ? elements.filter((element) => pdfElementGroupId(element) === groupId).map((element) => element.id)
    : [elementId];
}

function pdfElementsBounds(elements: PdfTemplateElement[]): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } | null {
  if (elements.length === 0) return null;
  const boxes = elements.map(pdfElementAabb);
  const minX = Math.min(...boxes.map((box) => box.minX));
  const minY = Math.min(...boxes.map((box) => box.minY));
  const maxX = Math.max(...boxes.map((box) => box.maxX));
  const maxY = Math.max(...boxes.map((box) => box.maxY));
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function pdfElementAabb(element: PdfTemplateElement): { minX: number; minY: number; maxX: number; maxY: number } {
  const width = Math.max(element.w, 0);
  const height = Math.max(element.h, 0);
  const radians = (element.rotation ?? 0) * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const corners = [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ].map(([dx, dy]) => ({ x: element.x + dx * cos - dy * sin, y: element.y + dx * sin + dy * cos }));
  return {
    minX: Math.min(...corners.map((corner) => corner.x)),
    minY: Math.min(...corners.map((corner) => corner.y)),
    maxX: Math.max(...corners.map((corner) => corner.x)),
    maxY: Math.max(...corners.map((corner) => corner.y)),
  };
}

function pdfElementContextTitle(element: PdfTemplateElement, fieldLabels: Map<string, string>): string {
  const source = element.source ? fieldLabels.get(element.source) ?? element.source : null;
  return source ? `${element.label} · ${source}` : element.label;
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
  if (type === 'sheet_thumbnail') return { label: 'Миниатюра листа', source: 'sheet.thumbnail', text: null, x: 18, y: 32, w: 150, h: 95, align: 'center', style: { color: '#111111', strokeWidth: 0.25, fit: 'stretch' } };
  if (type === 'detail_table') return { label: 'Таблица деталей', source: 'detail.table', text: null, x: 180, y: 32, w: 88, h: 72, align: 'center', style: { color: '#111111', strokeWidth: 0.25, fontSize: 7, columns: DEFAULT_PDF_DETAIL_TABLE_COLUMNS, sort: { field: 'detail.order', direction: 'asc' } } };
  if (type === 'machine_files_table') return { label: 'Файлы станка', source: 'sheet.machine_files', text: null, x: 180, y: 108, w: 88, h: 28, align: 'center', style: { color: '#111111', strokeWidth: 0.25, fontSize: 7 } };
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
    machine_files_table: 'Файлы станка',
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
    || value === 'machine_files_table'
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
  return upgradeDefaultPdfDetailTableColumns(rawColumns
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
    .filter((column): column is PdfDetailTableColumn => Boolean(column) && (includeHidden || column.visible)));
}

const LEGACY_DEFAULT_PDF_DETAIL_TABLE_COLUMN_FIELDS = [
  'detail.row_number',
  'detail.order',
  'detail.position',
  'detail.lengthMm',
  'detail.widthMm',
  'detail.quantity',
];

function upgradeDefaultPdfDetailTableColumns(columns: PdfDetailTableColumn[]): PdfDetailTableColumn[] {
  const fields = columns.map((column) => column.field);
  const isLegacyDefault =
    fields.length === LEGACY_DEFAULT_PDF_DETAIL_TABLE_COLUMN_FIELDS.length &&
    LEGACY_DEFAULT_PDF_DETAIL_TABLE_COLUMN_FIELDS.every((field, index) => fields[index] === field);
  if (!isLegacyDefault) return columns;
  return [
    ...columns,
    { field: 'detail.doweling', label: 'Присадка', width: 0.95, visible: true },
    { field: 'detail.machine_file', label: 'Файл станка', width: 1.8, visible: true },
  ];
}

function upgradeDefaultPdfElements(elements: PdfTemplateElement[]): PdfTemplateElement[] {
  if (elements.some((element) => element.type === 'machine_files_table')) return elements;
  const ids = new Set(elements.map((element) => element.id));
  const isLegacyDefault = ['field-order', 'field-client', 'field-film', 'line-header', 'sheet-thumbnail', 'detail-table']
    .every((id) => ids.has(id));
  if (!isLegacyDefault) return elements;
  const detailTable = elements.find((element) => element.id === 'detail-table' && element.type === 'detail_table');
  if (!detailTable) return elements;
  return [
    ...elements,
    makePdfElement('machine_files_table', {
      id: 'machine-files-table',
      label: 'Файлы станка',
      source: 'sheet.machine_files',
      x: detailTable.x,
      y: detailTable.y + detailTable.h + 4,
      w: detailTable.w,
      h: 32,
      zIndex: Math.max(...elements.map((element) => element.zIndex), detailTable.zIndex) + 1,
    }),
  ];
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

function estimatePdfFieldPaletteColumnWidth(fields: PdfFieldCatalogItem[]): number {
  const longestLabelLength = Math.max(
    'Поля карты раскроя PDF'.length,
    ...fields.map((field) => field.label.trim().length),
  );
  return Math.ceil(clamp(
    longestLabelLength * PDF_FIELD_PALETTE_LABEL_AVG_WIDTH + PDF_FIELD_PALETTE_COLUMN_CHROME,
    PDF_FIELD_PALETTE_DESKTOP_MIN_WIDTH,
    PDF_FIELD_PALETTE_DESKTOP_MAX_WIDTH,
  ));
}

function isPdfDetailTableField(field: PdfFieldCatalogItem): boolean {
  return field.id !== 'detail.table' && (field.source === 'detail' || field.id.startsWith('detail.'));
}

function uniquePdfFields(fields: PdfFieldCatalogItem[]): PdfFieldCatalogItem[] {
  const seen = new Set<string>();
  return fields.filter((field) => {
    if (seen.has(field.id)) return false;
    seen.add(field.id);
    return true;
  });
}

function pdfDetailTablePreviewValue(field: string, rowIndex: number): string {
  const suffix = rowIndex === 0 ? '' : rowIndex === 1 ? '-2' : '-3';
  const values: Record<string, string> = {
    'detail.row_number': String(rowIndex + 1),
    'detail.order': `11380${suffix}`,
    'detail.position': String(12 + rowIndex),
    'detail.detail_number': String(12 + rowIndex),
    'detail.detail_name': `Фасад ${rowIndex + 1}`,
    'detail.lengthMm': String(800 - rowIndex * 20),
    'detail.widthMm': String(240 + rowIndex * 15),
    'detail.height': String(800 - rowIndex * 20),
    'detail.width': String(240 + rowIndex * 15),
    'detail.quantity': String(rowIndex + 1),
    'detail.doweling': rowIndex === 1 ? '' : '✓',
    'detail.machine_file': rowIndex === 1 ? 'CNC#2_11380.TXT' : 'CNC#1_11380.TXT',
    'detail.machine_files': 'CNC#1_11380.TXT, CNC#2_11380.TXT',
    'detail.area': String(((800 - rowIndex * 20) * (240 + rowIndex * 15) / 1_000_000).toFixed(3)),
    'detail.material': 'Ванна',
    'detail.material_name': 'Ванна',
    'detail.film': 'Крем',
    'detail.film_name': 'Крем',
    'detail.client': 'Клиент',
    'detail.orderDate': '03.07.2026',
    'detail.readyDate': '10.07.2026',
    'detail.thickness': '16',
    'detail.note': 'Примечание',
    'detail.production_status_name': 'К раскрою',
    'detail.milling_type_name': 'Стандарт',
    'detail.edge_type_name': 'Кромка 2мм',
  };
  const detailField = field.startsWith('detail.') ? field : `detail.${field}`;
  return values[field] ?? values[detailField] ?? PDF_PREVIEW_VALUES[field] ?? PDF_PREVIEW_VALUES[detailField] ?? '';
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
