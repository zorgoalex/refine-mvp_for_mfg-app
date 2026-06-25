import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Col, Form, Input, InputNumber, Modal, Row, Select, Space, Table, Tag, Typography, message } from 'antd';
import { CopyOutlined, DeleteOutlined, EditOutlined, ImportOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
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
const CUSTOM_FIELD_TYPE_OPTIONS = ['string', 'number', 'boolean', 'date'].map((type) => ({ value: type, label: type }));
const PREVIEW_FIELD_VALUES: Record<string, string> = {
  'bazis.order_number': '548-16мм МДФ',
  'bazis.detail_id': '2590',
  'bazis.position': '27',
  'bazis.quantity': '1',
  'bazis.name': 'Фасад левый',
  'bazis.detail_length': '902',
  'bazis.detail_width': '596',
  'bazis.material': 'МДФ 16 мм',
  'bazis.comment': '',
  'date.today': '24.06.2026',
  'label.counter_text': 'Бир.№    1 / 0',
};

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

interface CustomFieldSchemaRow {
  fieldId: string;
  label: string;
  type: string;
  sourceField: string | null;
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
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsName, setSaveAsName] = useState('');
  const [selectedElementKey, setSelectedElementKey] = useState<string | null>(null);
  const previewWidthMm = Form.useWatch('canvasWidthMm', form);
  const previewHeightMm = Form.useWatch('canvasHeightMm', form);

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
  const customSchemaRows = useMemo(() => parseCustomSchemaRows(customSchemaText), [customSchemaText]);
  const sourceFields = useMemo<LabelFieldCatalogItem[]>(
    () => [
      ...fields,
      ...customSchemaRows.rows.map((row) => ({
        id: row.fieldId,
        source: 'dynamic' as const,
        sourceColumn: null,
        label: row.label || row.fieldId,
        type: (CUSTOM_FIELD_TYPE_OPTIONS.some((option) => option.value === row.type) ? row.type : 'string') as LabelFieldCatalogItem['type'],
        category: 'Кастомные',
      })),
    ],
    [customSchemaRows.rows, fields],
  );

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
      canvasWidthMm: 85,
      canvasHeightMm: 88,
      dpi: 203,
      defaultExportFormats: ['bmp', 'png', 'emf'],
    });
  };

  const buildTemplatePayload = (values: TemplateFormValues, name = values.name): LabelTemplateInput => {
    const customFieldSchema = parseCustomSchema(customSchemaText);
    return {
      name: name.trim(),
      description: values.description?.trim() || null,
      canvasWidthMm: values.canvasWidthMm,
      canvasHeightMm: values.canvasHeightMm,
      dpi: values.dpi,
      defaultExportFormats: values.defaultExportFormats,
      customFieldSchema,
      elements: toTemplateElementInput(elements),
      idempotencyKey: `label-template-${Date.now()}`,
    };
  };

  const saveTemplate = async (values: TemplateFormValues) => {
    if (!canManage) return;
    setSaving(true);
    try {
      const payload = buildTemplatePayload(values);
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

  const openSaveAs = async () => {
    if (!canManage) return;
    const values = await form.validateFields();
    setSaveAsName(`${values.name.trim() || selectedTemplate?.name || 'Шаблон'} — копия`);
    setSaveAsOpen(true);
  };

  const saveTemplateAs = async () => {
    if (!canManage) return;
    const name = saveAsName.trim();
    if (!name) {
      message.error('Введите название копии');
      return;
    }
    setSaving(true);
    try {
      const values = await form.validateFields();
      const created = await labelsApi.createTemplate(buildTemplatePayload(values, name));
      message.success('Копия шаблона создана');
      setSaveAsOpen(false);
      setSaveAsName('');
      await load();
      setSelectedTemplate(created);
      setElements(created.elements);
      setCustomSchemaText(JSON.stringify(created.customFieldSchema ?? {}, null, 2));
    } catch {
      message.error('Не удалось создать копию шаблона');
    } finally {
      setSaving(false);
    }
  };

  const addElement = (kind: LabelElementKind) => {
    const elementKey = `${kind}-${Date.now()}`;
    setElements((current) => [
      ...current,
      {
        elementKey,
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
    setSelectedElementKey(elementKey);
  };

  const patchElement = (index: number, patch: Partial<LabelTemplateElement>) => {
    setElements((current) => current.map((element, i) => (i === index ? { ...element, ...patch } : element)));
  };

  const addCustomField = () => {
    const schema = parseEditableCustomSchema(customSchemaText);
    const fieldId = `custom.field_${Date.now()}`;
    schema[fieldId] = { type: 'string', label: 'Новое поле', sourceField: 'detail.detail_name' };
    setCustomSchemaText(JSON.stringify(schema, null, 2));
  };

  const patchCustomField = (fieldId: string, patch: Partial<CustomFieldSchemaRow>) => {
    const schema = parseEditableCustomSchema(customSchemaText);
    const current = normalizeCustomFieldSchemaEntry(schema[fieldId]);
    const next = { ...current, ...patch };
    if (!next.sourceField) delete next.sourceField;
    schema[fieldId] = next;
    setCustomSchemaText(JSON.stringify(schema, null, 2));
  };

  const deleteCustomField = (fieldId: string) => {
    const schema = parseEditableCustomSchema(customSchemaText);
    delete schema[fieldId];
    setCustomSchemaText(JSON.stringify(schema, null, 2));
  };

  const moveElement = (elementKey: string, xMm: number, yMm: number) => {
    setElements((current) =>
      current.map((element) =>
        element.elementKey === elementKey
          ? { ...element, xMm: roundMm(xMm), yMm: roundMm(yMm) }
          : element,
      ),
    );
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

      <Card size="small" title="Шаблоны">
        <Table
          rowKey="labelTemplateId"
          loading={loading}
          dataSource={templates}
          pagination={false}
          size="small"
          scroll={{ y: 430 }}
          rowClassName={(template) => (selectedTemplate?.labelTemplateId === template.labelTemplateId ? 'ant-table-row-selected' : '')}
          onRow={(template) => ({
            onClick: () => setSelectedTemplate(template),
            style: { cursor: 'pointer' },
          })}
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
      </Card>

      <Card size="small" title="Просмотр текущего шаблона">
        <LabelTemplatePreview
          widthMm={Number(previewWidthMm ?? selectedTemplate?.canvasWidthMm ?? 85)}
          heightMm={Number(previewHeightMm ?? selectedTemplate?.canvasHeightMm ?? 88)}
          elements={elements}
          fields={sourceFields}
          selectedElementKey={selectedElementKey}
          canDrag={false}
        />
      </Card>

      <Row gutter={16} align="top">
        <Col xs={24} lg={9}>
          <Card size="small" title={selectedTemplate ? 'Редактирование шаблона' : 'Новый шаблон'} style={{ marginBottom: 16 }}>
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
              <Table
                rowKey="fieldId"
                size="small"
                pagination={false}
                dataSource={customSchemaRows.rows}
                title={() => (
                  <Space wrap>
                    <Text strong>Кастомные поля</Text>
                    <Button size="small" icon={<PlusOutlined />} disabled={!canManage || !customSchemaRows.valid} onClick={addCustomField}>
                      Поле
                    </Button>
                    {!customSchemaRows.valid && <Text type="danger">JSON некорректен</Text>}
                  </Space>
                )}
                columns={[
                  { title: 'Ключ', dataIndex: 'fieldId', width: 170 },
                  {
                    title: 'Название',
                    width: 170,
                    render: (_, row) => (
                      <Input
                        value={row.label}
                        disabled={!canManage}
                        onChange={(event) => patchCustomField(row.fieldId, { label: event.target.value })}
                      />
                    ),
                  },
                  {
                    title: 'Тип',
                    width: 110,
                    render: (_, row) => (
                      <Select
                        value={row.type}
                        disabled={!canManage}
                        style={{ width: '100%' }}
                        options={CUSTOM_FIELD_TYPE_OPTIONS}
                        onChange={(type) => patchCustomField(row.fieldId, { type })}
                      />
                    ),
                  },
                  {
                    title: 'Источник',
                    width: 220,
                    render: (_, row) => (
                      <Select
                        showSearch
                        allowClear
                        value={row.sourceField ?? undefined}
                        disabled={!canManage}
                        style={{ width: '100%' }}
                        options={fields.map((field) => ({ value: field.id, label: `${field.category}: ${field.label}` }))}
                        onChange={(sourceField) => patchCustomField(row.fieldId, { sourceField: sourceField ?? null })}
                      />
                    ),
                  },
                  {
                    title: '',
                    width: 48,
                    render: (_, row) => (
                      <Button danger size="small" icon={<DeleteOutlined />} disabled={!canManage} onClick={() => deleteCustomField(row.fieldId)} />
                    ),
                  },
                ]}
              />
              <Space wrap>
                <Button htmlType="submit" type="primary" icon={<SaveOutlined />} loading={saving} disabled={!canManage}>
                  Сохранить шаблон
                </Button>
                <Button icon={<CopyOutlined />} loading={saving} disabled={!canManage || !selectedTemplate || elements.length === 0} onClick={() => void openSaveAs()}>
                  Сохранить как
                </Button>
              </Space>
            </Form>
          </Card>
          <Table
            rowKey="elementKey"
            title={() => (
              <Space wrap>
                <Text strong>Элементы</Text>
                <Button disabled={!canManage} onClick={() => addElement('text')}>Текст</Button>
                <Button disabled={!canManage} onClick={() => addElement('line')}>Линия</Button>
                <Button disabled={!canManage} onClick={() => addElement('rect')}>Прямоугольник</Button>
              </Space>
            )}
            size="small"
            pagination={false}
            dataSource={elements}
            scroll={{ y: 360, x: 720 }}
            rowClassName={(element) => (selectedElementKey === element.elementKey ? 'ant-table-row-selected' : '')}
            onRow={(element) => ({
              onClick: () => setSelectedElementKey(element.elementKey),
              style: { cursor: 'pointer' },
            })}
            columns={[
              {
                title: 'Тип',
                width: 120,
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
                width: 220,
                render: (_, element, index) => (
                  <Select
                    showSearch
                    allowClear
                    value={element.sourceField ?? undefined}
                    disabled={!canManage || element.kind !== 'text'}
                    style={{ width: '100%' }}
                    onChange={(sourceField) => patchElement(index, { sourceField: sourceField ?? null })}
                    options={sourceFields.map((field) => ({ value: field.id, label: `${field.category}: ${field.label}` }))}
                  />
                ),
              },
              {
                title: 'Текст',
                width: 180,
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
                width: 95,
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
        </Col>
        <Col xs={24} lg={15}>
          <Card size="small" title="Визуал бирки">
            <LabelTemplatePreview
              widthMm={Number(previewWidthMm ?? selectedTemplate?.canvasWidthMm ?? 85)}
              heightMm={Number(previewHeightMm ?? selectedTemplate?.canvasHeightMm ?? 88)}
              elements={elements}
              fields={sourceFields}
              selectedElementKey={selectedElementKey}
              canDrag={canManage}
              onSelectElement={setSelectedElementKey}
              onMoveElement={moveElement}
            />
          </Card>
        </Col>
      </Row>

      <div>
        <Text type="secondary">Доступно полей: {fields.length}; категорий: {fieldCategories}</Text>
      </div>

      <Modal
        title="Сохранить шаблон как"
        open={saveAsOpen}
        okText="Создать копию"
        cancelText="Отмена"
        confirmLoading={saving}
        onOk={() => void saveTemplateAs()}
        onCancel={() => setSaveAsOpen(false)}
      >
        <Input
          autoFocus
          value={saveAsName}
          placeholder="Новое название шаблона"
          onChange={(event) => setSaveAsName(event.target.value)}
          onPressEnter={() => void saveTemplateAs()}
        />
      </Modal>
    </Space>
  );
};

function LabelTemplatePreview({
  widthMm,
  heightMm,
  elements,
  fields,
  selectedElementKey,
  canDrag,
  onSelectElement,
  onMoveElement,
}: {
  widthMm: number;
  heightMm: number;
  elements: LabelTemplateElement[];
  fields: LabelFieldCatalogItem[];
  selectedElementKey?: string | null;
  canDrag?: boolean;
  onSelectElement?: (elementKey: string) => void;
  onMoveElement?: (elementKey: string, xMm: number, yMm: number) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{ elementKey: string; offsetX: number; offsetY: number } | null>(null);
  const safeWidth = Number.isFinite(widthMm) && widthMm > 0 ? widthMm : 85;
  const safeHeight = Number.isFinite(heightMm) && heightMm > 0 ? heightMm : 88;
  const fieldLabels = new Map(fields.map((field) => [field.id, field.label]));
  const sorted = elements.slice().sort((a, b) => Number(a.zIndex ?? 0) - Number(b.zIndex ?? 0));
  const previewWidth = Math.min(680, Math.max(360, safeWidth * 6));
  const pointFromEvent = (event: React.MouseEvent<Element>) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * safeWidth,
      y: ((event.clientY - rect.top) / rect.height) * safeHeight,
    };
  };

  const handleMove = (event: React.MouseEvent<SVGSVGElement>) => {
    if (!drag || !onMoveElement) return;
    const point = pointFromEvent(event);
    const element = elements.find((item) => item.elementKey === drag.elementKey);
    if (!element) return;
    const maxX = Math.max(0, safeWidth - Number(element.widthMm ?? 0));
    const maxY = Math.max(0, safeHeight - Number(element.heightMm ?? 0));
    onMoveElement(drag.elementKey, clamp(point.x - drag.offsetX, 0, maxX), clamp(point.y - drag.offsetY, 0, maxY));
  };

  return (
    <div
      style={{
        width: '100%',
        maxWidth: previewWidth,
        aspectRatio: `${safeWidth} / ${safeHeight}`,
        border: '1px solid #d9d9d9',
        background: '#fff',
        overflow: 'hidden',
        touchAction: 'none',
      }}
    >
      <svg
        ref={svgRef}
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`0 0 ${safeWidth} ${safeHeight}`}
        width="100%"
        height="100%"
        onMouseMove={handleMove}
        onMouseUp={() => setDrag(null)}
        onMouseLeave={() => setDrag(null)}
      >
        <rect x={0} y={0} width={safeWidth} height={safeHeight} fill="#fff" />
        {sorted.map((element) =>
          renderPreviewElement({
            element,
            fieldLabels,
            selected: selectedElementKey === element.elementKey,
            draggable: Boolean(canDrag),
            onMouseDown: (event) => {
              if (!canDrag) return;
              event.preventDefault();
              event.stopPropagation();
              const point = pointFromEvent(event);
              onSelectElement?.(element.elementKey);
              setDrag({
                elementKey: element.elementKey,
                offsetX: point.x - Number(element.xMm ?? 0),
                offsetY: point.y - Number(element.yMm ?? 0),
              });
            },
          }),
        )}
      </svg>
    </div>
  );
}

function renderPreviewElement({
  element,
  fieldLabels,
  selected,
  draggable,
  onMouseDown,
}: {
  element: LabelTemplateElement;
  fieldLabels: Map<string, string>;
  selected: boolean;
  draggable: boolean;
  onMouseDown: (event: React.MouseEvent<SVGGElement>) => void;
}) {
  const x = Number(element.xMm ?? 0);
  const y = Number(element.yMm ?? 0);
  const w = Number(element.widthMm ?? 0);
  const h = Number(element.heightMm ?? 0);
  const key = element.elementKey;
  const transform = Number(element.rotationDeg ?? 0)
    ? `rotate(${Number(element.rotationDeg ?? 0)} ${x} ${y})`
    : undefined;

  const clipId = `label-preview-clip-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const selectionBox = selected ? (
    <rect x={x} y={y} width={Math.max(w, 2)} height={Math.max(h, 2)} fill="none" stroke="#1677ff" strokeWidth={0.45} strokeDasharray="1 1" />
  ) : null;
  const common = {
    transform,
    onMouseDown,
    style: { cursor: draggable ? 'move' : 'default' },
  };
  if (element.kind === 'line') {
    return (
      <g key={key} {...common}>
        <line x1={x} y1={y} x2={x + w} y2={y + h} stroke="black" strokeWidth={0.45} />
        {selectionBox}
      </g>
    );
  }
  if (element.kind === 'rect') {
    return (
      <g key={key} {...common}>
        <rect x={x} y={y} width={w} height={h} fill="none" stroke="black" strokeWidth={Number(element.style?.strokeWidth ?? 0.45)} />
        {selectionBox}
      </g>
    );
  }

  const fontSize = Math.max(1.8, Number(element.style?.fontSize ?? 10) * 0.35);
  const text = element.sourceField
    ? PREVIEW_FIELD_VALUES[element.sourceField] ?? fieldLabels.get(element.sourceField) ?? element.sourceField
    : element.staticText ?? '';
  return (
    <g key={key} {...common}>
      <defs>
        <clipPath id={clipId}>
          <rect x={x} y={y} width={Math.max(w, 1)} height={Math.max(h, fontSize + 1)} />
        </clipPath>
      </defs>
      <text
        x={x}
        y={y + fontSize}
        fontFamily="Arial, sans-serif"
        fontSize={fontSize}
        fontWeight={String(element.style?.fontWeight ?? 'normal')}
        fill="black"
        clipPath={`url(#${clipId})`}
      >
        {text}
      </text>
      {selectionBox}
    </g>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundMm(value: number): number {
  return Math.round(value * 10) / 10;
}

function toTemplateElementInput(elements: LabelTemplateElement[]): LabelTemplateElement[] {
  return elements.map(({ labelTemplateElementId: _labelTemplateElementId, ...element }) => element);
}

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
    text('detail-id-label', null, '№:', 2, 4, 14, 8, 13, 1),
    text('detail-id-value', 'bazis.detail_id', null, 36, 6, 30, 10, 18, 2),
    text('order-label', null, 'Заказ№:', 2, 18, 22, 7, 11, 3),
    text('order-value', 'bazis.order_number', null, 24, 18, 56, 7, 11, 4),
    text('position-label', null, 'Поз.', 2, 28, 13, 7, 11, 5),
    text('position-value', 'bazis.position', null, 15, 28, 20, 7, 11, 6),
    text('material-value', 'bazis.material', null, 31, 38, 34, 6, 9, 7),
    text('length-value', 'bazis.detail_length', null, 27, 47, 18, 8, 16, 8),
    text('size-x', null, 'x', 45, 47, 7, 8, 16, 9),
    text('width-value', 'bazis.detail_width', null, 52, 47, 18, 8, 16, 10),
    text('date-value', 'date.today', null, 2, 80, 29, 7, 10, 11),
    text('counter-value', 'label.counter_text', null, 41, 80, 38, 7, 10, 12),
  ];
}

function parseCustomSchemaRows(value: string): { valid: boolean; rows: CustomFieldSchemaRow[] } {
  try {
    const schema = parseCustomSchema(value);
    return {
      valid: true,
      rows: Object.entries(schema).map(([fieldId, entry]) => ({
        fieldId,
        ...normalizeCustomFieldSchemaEntry(entry),
      })),
    };
  } catch {
    return { valid: false, rows: [] };
  }
}

function parseEditableCustomSchema(value: string): Record<string, unknown> {
  try {
    return parseCustomSchema(value);
  } catch {
    message.error('Сначала исправьте JSON пользовательских полей');
    return {};
  }
}

function normalizeCustomFieldSchemaEntry(entry: unknown): Omit<CustomFieldSchemaRow, 'fieldId'> {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { label: '', type: 'string', sourceField: null };
  }
  const value = entry as Record<string, unknown>;
  return {
    label: typeof value.label === 'string' ? value.label : '',
    type: typeof value.type === 'string' ? value.type : 'string',
    sourceField: typeof value.sourceField === 'string' && value.sourceField ? value.sourceField : null,
  };
}

function parseCustomSchema(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value || '{}') as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('custom schema must be object');
  }
  return parsed as Record<string, unknown>;
}
