import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Checkbox, Col, Form, Input, InputNumber, Row, Select, Space, Table, Tag, Typography, message } from 'antd';
import { EditOutlined, ImportOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { labelsApi } from '../../../api/labelsApi';
import type {
  LabelElementKind,
  LabelExportFormat,
  LabelFieldCatalogItem,
  LabelTemplate,
  LabelTemplateElement,
  LabelTemplateInput,
} from '../../../api/types/labelsApi.types';
import { can } from '../../../utils/permissions';

const { Text } = Typography;
const EXPORT_FORMATS: LabelExportFormat[] = ['bmp', 'png', 'emf'];

interface TemplateFormValues {
  name: string;
  description?: string;
  canvasWidthMm: number;
  canvasHeightMm: number;
  dpi: number;
  defaultExportFormats: LabelExportFormat[];
}

interface BazisImportVariant {
  key: string;
  name: string;
  description: string;
  elements: LabelTemplateElement[];
  rowCount: number;
  templateFiles: string[];
}

export const LabelsConfigTab: React.FC = () => {
  const canManage = can('labels.manage_templates');
  const [form] = Form.useForm<TemplateFormValues>();
  const [templates, setTemplates] = useState<LabelTemplate[]>([]);
  const [fields, setFields] = useState<LabelFieldCatalogItem[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<LabelTemplate | null>(null);
  const [elements, setElements] = useState<LabelTemplateElement[]>([]);
  const [customSchemaText, setCustomSchemaText] = useState('{}');
  const [importVariants, setImportVariants] = useState<BazisImportVariant[]>([]);
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [nextTemplates, nextFields] = await Promise.all([
        labelsApi.listTemplates(true),
        labelsApi.listFields(),
      ]);
      setTemplates(nextTemplates);
      setFields(nextFields);
    } catch {
      message.error('Не удалось загрузить настройки бирок');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (selectedTemplate) {
      form.setFieldsValue({
        name: selectedTemplate.name,
        description: selectedTemplate.description ?? '',
        canvasWidthMm: selectedTemplate.canvasWidthMm,
        canvasHeightMm: selectedTemplate.canvasHeightMm,
        dpi: selectedTemplate.dpi,
        defaultExportFormats: selectedTemplate.defaultExportFormats,
      });
      setElements(selectedTemplate.elements);
      setCustomSchemaText(JSON.stringify(selectedTemplate.customFieldSchema ?? {}, null, 2));
    }
  }, [form, selectedTemplate]);

  const fieldCategories = useMemo(() => new Set(fields.map((field) => field.category)).size, [fields]);

  const startNew = () => {
    setSelectedTemplate(null);
    setElements([
      {
        elementKey: `text-${Date.now()}`,
        kind: 'text',
        sourceField: 'bazis.order_number',
        staticText: null,
        xMm: 2,
        yMm: 2,
        widthMm: 60,
        heightMm: 6,
        rotationDeg: 0,
        zIndex: 0,
        style: { fontSize: 12 },
        condition: {},
      },
    ]);
    setCustomSchemaText('{}');
    form.setFieldsValue({
      name: '',
      description: '',
      canvasWidthMm: 84,
      canvasHeightMm: 55,
      dpi: 203,
      defaultExportFormats: ['bmp', 'png', 'emf'],
    });
  };

  const saveTemplate = async (values: TemplateFormValues) => {
    if (!canManage) return;
    setSaving(true);
    try {
      const customFieldSchema = parseCustomSchema(customSchemaText);
      const payload: LabelTemplateInput = {
        name: values.name.trim(),
        description: values.description?.trim() || null,
        canvasWidthMm: values.canvasWidthMm,
        canvasHeightMm: values.canvasHeightMm,
        dpi: values.dpi,
        defaultExportFormats: values.defaultExportFormats,
        customFieldSchema,
        elements,
        idempotencyKey: `label-template-${Date.now()}`,
      };
      if (selectedTemplate) {
        await labelsApi.updateTemplate(selectedTemplate.labelTemplateId, { ...payload, version: selectedTemplate.version });
        message.success('Шаблон обновлён');
      } else {
        await labelsApi.createTemplate(payload);
        message.success('Шаблон создан');
      }
      await load();
      startNew();
    } catch {
      message.error('Не удалось сохранить шаблон');
    } finally {
      setSaving(false);
    }
  };

  const addElement = (kind: LabelElementKind) => {
    setElements((current) => [
      ...current,
      {
        elementKey: `${kind}-${Date.now()}`,
        kind,
        sourceField: kind === 'text' ? 'bazis.name' : null,
        staticText: kind === 'text' ? null : null,
        xMm: 2,
        yMm: 2 + current.length * 6,
        widthMm: kind === 'line' ? 60 : 40,
        heightMm: kind === 'line' ? 0 : 6,
        rotationDeg: 0,
        zIndex: current.length,
        style: { fontSize: 12 },
        condition: {},
      },
    ]);
  };

  const patchElement = (index: number, patch: Partial<LabelTemplateElement>) => {
    setElements((current) => current.map((element, i) => (i === index ? { ...element, ...patch } : element)));
  };

  const handleBazisImportFile = async (file: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      const variants = parseBazisTemplateVariants(text, file.name);
      setImportFileName(file.name);
      setImportVariants(variants);
      if (variants.length === 0) {
        message.warning('В файле не найдено вариантов шаблонов бирок');
      } else {
        message.success(`Найдено вариантов: ${variants.length}`);
      }
    } catch {
      message.error('Не удалось разобрать Bazis .xbir файл');
    }
  };

  const applyImportVariant = (variant: BazisImportVariant) => {
    setSelectedTemplate(null);
    setElements(variant.elements);
    setCustomSchemaText('{}');
    form.setFieldsValue({
      name: variant.name,
      description: variant.description,
      canvasWidthMm: 85,
      canvasHeightMm: 88,
      dpi: 203,
      defaultExportFormats: ['bmp', 'png', 'emf'],
    });
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space wrap>
        <Button icon={<ReloadOutlined />} onClick={load} loading={loading} />
        <Button type="primary" icon={<PlusOutlined />} disabled={!canManage} onClick={startNew}>
          Новый шаблон
        </Button>
      </Space>

      {!canManage && (
        <Alert
          type="info"
          showIcon
          message="Шаблоны доступны только для просмотра"
        />
      )}

      <Card size="small" title="Импорт из Bazis .xbir">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space wrap>
            <input
              type="file"
              accept=".xbir,.xml,text/xml,application/xml"
              disabled={!canManage}
              onChange={(event) => void handleBazisImportFile(event.target.files?.[0] ?? null)}
            />
            {importFileName && <Text type="secondary">{importFileName}</Text>}
          </Space>
          <Alert
            type="info"
            showIcon
            message="Импорт читает .xbir, группирует строки по полю «Шаблон бирки» и предлагает варианты ERP-шаблона. Файлы .brx пока не читаются напрямую."
          />
          {importVariants.length > 0 && (
            <Table
              rowKey="key"
              size="small"
              pagination={false}
              dataSource={importVariants}
              columns={[
                { title: 'Вариант', dataIndex: 'name' },
                { title: 'Строк', dataIndex: 'rowCount', width: 90 },
                {
                  title: 'Bazis файл',
                  dataIndex: 'templateFiles',
                  render: (files: string[]) => files.map((file) => <Tag key={file}>{file}</Tag>),
                },
                {
                  title: '',
                  width: 150,
                  render: (_, variant) => (
                    <Button icon={<ImportOutlined />} disabled={!canManage} onClick={() => applyImportVariant(variant)}>
                      В форму
                    </Button>
                  ),
                },
              ]}
            />
          )}
        </Space>
      </Card>

      <Row gutter={16}>
        <Col xs={24} lg={14}>
          <Table
            rowKey="labelTemplateId"
            loading={loading}
            dataSource={templates}
            pagination={false}
            size="small"
            onRow={(template) => ({ onClick: () => setSelectedTemplate(template) })}
            columns={[
              { title: 'Название', dataIndex: 'name' },
              { title: 'Версия', dataIndex: 'version', width: 90 },
              {
                title: 'Форматы',
                dataIndex: 'defaultExportFormats',
                width: 180,
                render: (formats: string[]) => formats.map((format) => <Tag key={format}>{format}</Tag>),
              },
              {
                title: 'Статус',
                dataIndex: 'isActive',
                width: 120,
                render: (active: boolean) => <Tag color={active ? 'green' : 'default'}>{active ? 'Активен' : 'Отключен'}</Tag>,
              },
              {
                title: '',
                width: 48,
                render: () => <Button icon={<EditOutlined />} size="small" disabled={!canManage} />,
              },
            ]}
          />
        </Col>
        <Col xs={24} lg={10}>
          <Card size="small" title={selectedTemplate ? 'Редактирование шаблона' : 'Новый шаблон'}>
            <Form form={form} layout="vertical" onFinish={saveTemplate} disabled={!canManage || saving}>
              <Form.Item name="name" label="Название" rules={[{ required: true, whitespace: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="description" label="Описание">
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} />
              </Form.Item>
              <Row gutter={8}>
                <Col span={8}>
                  <Form.Item name="canvasWidthMm" label="Ширина" rules={[{ required: true }]}>
                    <InputNumber min={1} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="canvasHeightMm" label="Высота" rules={[{ required: true }]}>
                    <InputNumber min={1} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="dpi" label="DPI" rules={[{ required: true }]}>
                    <InputNumber min={1} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>
              <Form.Item name="defaultExportFormats" label="Форматы" rules={[{ required: true }]}>
                <Checkbox.Group options={EXPORT_FORMATS.map((format) => ({ label: format, value: format }))} />
              </Form.Item>
              <Form.Item label="Пользовательские поля JSON">
                <Input.TextArea value={customSchemaText} onChange={(event) => setCustomSchemaText(event.target.value)} autoSize={{ minRows: 3, maxRows: 6 }} />
              </Form.Item>
              <Button htmlType="submit" type="primary" icon={<SaveOutlined />} loading={saving} disabled={!canManage}>
                Сохранить шаблон
              </Button>
            </Form>
          </Card>
        </Col>
      </Row>

      <Card size="small" title="Элементы шаблона">
        <Space wrap style={{ marginBottom: 12 }}>
          <Button disabled={!canManage} onClick={() => addElement('text')}>Текст</Button>
          <Button disabled={!canManage} onClick={() => addElement('line')}>Линия</Button>
          <Button disabled={!canManage} onClick={() => addElement('rect')}>Прямоугольник</Button>
        </Space>
        <Table
          rowKey="elementKey"
          size="small"
          pagination={false}
          dataSource={elements}
          columns={[
            {
              title: 'Тип',
              width: 150,
              render: (_, element, index) => (
                <Select
                  value={element.kind}
                  disabled={!canManage}
                  style={{ width: '100%' }}
                  onChange={(kind) => patchElement(index, { kind })}
                  options={[
                    { value: 'text', label: 'Текст' },
                    { value: 'line', label: 'Линия' },
                    { value: 'rect', label: 'Прямоугольник' },
                  ]}
                />
              ),
            },
            {
              title: 'Поле',
              render: (_, element, index) => (
                <Select
                  showSearch
                  allowClear
                  value={element.sourceField ?? undefined}
                  disabled={!canManage || element.kind !== 'text'}
                  style={{ width: '100%' }}
                  onChange={(sourceField) => patchElement(index, { sourceField: sourceField ?? null })}
                  options={fields.map((field) => ({ value: field.id, label: field.label }))}
                />
              ),
            },
            {
              title: 'Текст',
              render: (_, element, index) => (
                <Input
                  value={element.staticText ?? ''}
                  disabled={!canManage || element.kind !== 'text'}
                  onChange={(event) => patchElement(index, { staticText: event.target.value || null })}
                />
              ),
            },
            ...(['xMm', 'yMm', 'widthMm', 'heightMm'] as const).map((key) => ({
              title: key,
              width: 110,
              render: (_: unknown, element: LabelTemplateElement, index: number) => (
                <InputNumber
                  value={element[key]}
                  min={0}
                  disabled={!canManage}
                  style={{ width: '100%' }}
                  onChange={(value) => patchElement(index, { [key]: Number(value ?? 0) })}
                />
              ),
            })),
          ]}
        />
      </Card>

      <div>
        <Text type="secondary">Доступно полей: {fields.length}; категорий: {fieldCategories}</Text>
      </div>
    </Space>
  );
};

function parseBazisTemplateVariants(xmlText: string, fileName: string): BazisImportVariant[] {
  const document = new DOMParser().parseFromString(xmlText, 'application/xml');
  const parseError = document.querySelector('parsererror');
  if (parseError) throw new Error('invalid xbir xml');

  const columns = Array.from(document.querySelectorAll('Cols Col')).sort(
    (a, b) => Number(a.getAttribute('Index') ?? 0) - Number(b.getAttribute('Index') ?? 0),
  );
  const templateIndex = columns.findIndex((column) => column.getAttribute('Name') === 'Шаблон бирки');
  const rows = Array.from(document.querySelectorAll('Rows Row')).map((row) => row.textContent?.split('\t') ?? []);
  const grouped = new Map<string, string[][]>();

  for (const row of rows) {
    const templatePath = templateIndex >= 0 ? normalizeBazisTemplatePath(row[templateIndex]) : '';
    const key = templatePath || 'Встроенный стандарт';
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  return Array.from(grouped.entries()).map(([templatePath, templateRows], index) => {
    const templateName = templatePath === 'Встроенный стандарт' ? templatePath : templatePath.split(/[\\/]/).pop() ?? templatePath;
    const baseName = fileName.replace(/\.(xbir|xml)$/i, '');
    return {
      key: `${templatePath}-${index}`,
      name: `Импорт Bazis ${templateName}`,
      description: `Создано из ${baseName}: ${templateRows.length} строк, источник ${templatePath}.`,
      rowCount: templateRows.length,
      templateFiles: [templatePath],
      elements: buildStandardBazisElements(),
    };
  });
}

function normalizeBazisTemplatePath(value: string | undefined): string {
  return String(value ?? '').trim();
}

function buildStandardBazisElements(): LabelTemplateElement[] {
  const text = (
    elementKey: string,
    sourceField: string | null,
    staticText: string | null,
    xMm: number,
    yMm: number,
    widthMm: number,
    heightMm: number,
    fontSize = 10,
    zIndex = 1,
  ): LabelTemplateElement => ({
    elementKey,
    kind: 'text',
    sourceField,
    staticText,
    xMm,
    yMm,
    widthMm,
    heightMm,
    rotationDeg: 0,
    zIndex,
    style: { fontSize },
    condition: {},
  });

  return [
    {
      elementKey: 'border',
      kind: 'rect',
      sourceField: null,
      staticText: null,
      xMm: 1,
      yMm: 1,
      widthMm: 83,
      heightMm: 86,
      rotationDeg: 0,
      zIndex: 0,
      style: { strokeWidth: 1 },
      condition: {},
    },
    text('order-label', null, 'Заказ', 4, 4, 16, 5, 10, 1),
    text('order-value', 'bazis.order_number', null, 21, 4, 58, 5, 10, 2),
    text('position-label', null, 'Поз.', 4, 12, 14, 5, 10, 3),
    text('position-value', 'bazis.position', null, 18, 12, 20, 5, 12, 4),
    text('qty-label', null, 'Кол-во', 48, 12, 18, 5, 10, 5),
    text('qty-value', 'bazis.quantity', null, 67, 12, 12, 5, 12, 6),
    text('name-label', null, 'Деталь', 4, 21, 18, 5, 10, 7),
    text('name-value', 'bazis.name', null, 4, 27, 76, 10, 14, 8),
    text('size-label', null, 'Размер', 4, 42, 20, 5, 10, 9),
    text('length-value', 'bazis.detail_length', null, 25, 42, 18, 5, 12, 10),
    text('size-x', null, 'x', 44, 42, 4, 5, 12, 11),
    text('width-value', 'bazis.detail_width', null, 49, 42, 18, 5, 12, 12),
    text('material-label', null, 'Материал', 4, 51, 24, 5, 10, 13),
    text('material-value', 'bazis.material', null, 4, 57, 76, 8, 12, 14),
    text('comment-label', null, 'Комментарий', 4, 70, 32, 5, 10, 15),
    text('comment-value', 'bazis.comment', null, 4, 76, 76, 8, 10, 16),
  ];
}

function parseCustomSchema(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value || '{}') as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('custom schema must be object');
  }
  return parsed as Record<string, unknown>;
}
