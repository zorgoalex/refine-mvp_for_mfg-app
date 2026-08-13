import { Table, Tooltip } from '../../../ui/tooltipDelay';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Checkbox, Col, Empty, Form, Input, List, Popconfirm, Row, Select, Space, Spin, Tag, Typography, message } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, CopyOutlined, DeleteOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import {
  exportTemplateCommandKey, exportTemplatesApi,
  type ExportTemplateCatalog, type ExportTemplateColumn, type ExportTemplateDraft, type ExportTemplateDto,
  type ExportTemplateTarget,
} from '../../../api/exportTemplatesApi';
import { can } from '../../../utils/permissions';
import { ExportExpressionEditor, expressionReferencesColumn } from './ExportExpressionEditor';
import './ExportTemplatesConfigTab.css';

const { Paragraph, Text, Title } = Typography;

export const ExportTemplatesConfigTab: React.FC = () => {
  const canManage = can('settings.manage');
  const [catalog, setCatalog] = useState<ExportTemplateCatalog | null>(null);
  const [templates, setTemplates] = useState<ExportTemplateDto[]>([]);
  const [selectedId, setSelectedId] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<ExportTemplateDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Array<{ columnKey: string; header: string; value: unknown; valueType: string }>>([]);

  const reload = useCallback(async (preferredId?: number) => {
    setLoading(true); setError(null);
    try {
      const [nextCatalog, nextTemplates] = await Promise.all([exportTemplatesApi.catalog(), exportTemplatesApi.list(true)]);
      setCatalog(nextCatalog); setTemplates(nextTemplates);
      const id = preferredId ?? (selectedId === 'new' ? undefined : selectedId ?? undefined) ?? nextTemplates[0]?.exportTemplateId;
      const selected = nextTemplates.find((template) => template.exportTemplateId === id) ?? nextTemplates[0];
      setSelectedId(selected?.exportTemplateId ?? null);
      setDraft(selected ? toDraft(selected) : null);
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить шаблоны'); }
    finally { setLoading(false); }
  }, [selectedId]);

  useEffect(() => { void reload(); }, []); // first load only

  const selected = useMemo(() => typeof selectedId === 'number'
    ? templates.find((template) => template.exportTemplateId === selectedId) ?? null : null, [selectedId, templates]);

  const selectTemplate = (template: ExportTemplateDto) => {
    setSelectedId(template.exportTemplateId); setDraft(toDraft(template)); setPreview([]);
  };
  const createDraft = (source?: ExportTemplateDto) => {
    const target = source?.targetScreen ?? 'bazis_cut_set';
    setSelectedId('new'); setDraft(source ? { ...toDraft(source), name: `${source.name} — копия` } : blankDraft(target, catalog)); setPreview([]);
  };
  const save = async () => {
    if (!draft || !canManage) return;
    setSaving(true);
    try {
      const saved = selected
        ? await exportTemplatesApi.update(selected.exportTemplateId, draft, selected.version, exportTemplateCommandKey('update'))
        : await exportTemplatesApi.create(draft, exportTemplateCommandKey('create'));
      message.success('Шаблон сохранён'); await reload(saved.exportTemplateId);
    } catch (saveError) { message.error(saveError instanceof Error ? saveError.message : 'Не удалось сохранить шаблон'); }
    finally { setSaving(false); }
  };
  const setDefault = async () => {
    if (!selected) return;
    try { const saved = await exportTemplatesApi.setDefault(selected.exportTemplateId, selected.version, exportTemplateCommandKey('default'));
      message.success('Шаблон назначен по умолчанию'); await reload(saved.exportTemplateId); }
    catch (actionError) { message.error(actionError instanceof Error ? actionError.message : 'Не удалось сменить шаблон по умолчанию'); }
  };
  const remove = async () => {
    if (!selected) return;
    try { await exportTemplatesApi.remove(selected.exportTemplateId, selected.version, exportTemplateCommandKey('delete'));
      message.success('Шаблон удалён'); setSelectedId(null); await reload(); }
    catch (actionError) { message.error(actionError instanceof Error ? actionError.message : 'Не удалось удалить шаблон'); }
  };
  const runPreview = async () => {
    if (!draft) return;
    try { setPreview(await exportTemplatesApi.preview(draft)); message.success('Формулы корректны'); }
    catch (previewError) { message.error(previewError instanceof Error ? previewError.message : 'Формула содержит ошибку'); }
  };

  if (loading && !catalog) return <Spin />;
  if (error) return <Alert type="error" showIcon message="Шаблоны экспорта недоступны" description={error} action={<Button onClick={() => void reload()}>Повторить</Button>} />;
  if (!catalog) return <Empty />;

  return <Space direction="vertical" size={16} style={{ width: '100%' }}>
    <div><Title level={4} style={{ marginBottom: 4 }}>Шаблоны экспорта</Title>
      <Paragraph type="secondary" style={{ margin: 0, maxWidth: 820 }}>
        Настройте колонки, порядок и безопасные формулы XLS. Шаблон явно связан с экраном и источником данных.
      </Paragraph></div>
    {!canManage && <Alert type="info" showIcon message="Режим просмотра" description="Для изменения нужен доступ settings.manage." />}
    <Row gutter={[16, 16]} align="top">
      <Col xs={24} className="export-templates-list-pane"><Card size="small" title="Шаблоны" extra={canManage && <Tooltip title="Создать шаблон"><Button
        aria-label="Создать шаблон" icon={<PlusOutlined />} style={{ minWidth: 40, minHeight: 40 }} onClick={() => createDraft()} /></Tooltip>}>
        <List dataSource={templates} locale={{ emptyText: 'Шаблонов пока нет' }} renderItem={(template) => <List.Item
          style={{ cursor: 'pointer', borderRadius: 8, paddingInline: 10, background: selectedId === template.exportTemplateId ? '#e6f4ff' : undefined }}
          onClick={() => selectTemplate(template)}>
          <List.Item.Meta title={<Space wrap>{template.name}{template.isDefault && <Tag color="blue">По умолчанию</Tag>}{!template.isActive && <Tag>Отключён</Tag>}</Space>}
            description={`${targetLabel(template.targetScreen)} · XLS`} />
        </List.Item>} />
      </Card></Col>
      <Col xs={24} className="export-templates-editor-pane">{draft ? <Card title={selected ? 'Редактирование шаблона' : 'Новый шаблон'} extra={<Space wrap>
        {selected && <Button icon={<CopyOutlined />} disabled={!canManage} style={{ minHeight: 40 }} onClick={() => createDraft(selected)}>Дублировать</Button>}
        <Button type="primary" icon={<SaveOutlined />} loading={saving} disabled={!canManage} style={{ minHeight: 40 }} onClick={() => void save()}>Сохранить</Button>
      </Space>}>
        <Form layout="vertical">
          <Row gutter={12}>
            <Col xs={24} md={12}><Form.Item label="Название" required><Input value={draft.name} maxLength={200} disabled={!canManage}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item label="Лист XLS" required><Input value={draft.sheetName} maxLength={31} disabled={!canManage}
              onChange={(event) => setDraft({ ...draft, sheetName: event.target.value })} /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item label="Экран"><Select value={draft.targetScreen} disabled={!canManage || Boolean(selected)} style={{ width: '100%' }}
              options={catalog.targets.map((target) => ({ value: target.code, label: target.label }))}
              onChange={(targetScreen: ExportTemplateTarget) => { const target = catalog.targets.find((item) => item.code === targetScreen)!;
                setDraft({ ...draft, targetScreen, sourceType: target.sourceType }); }} /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item label="Источник"><Input value={catalog.targets.find((target) => target.code === draft.targetScreen)?.label ?? draft.sourceType} disabled /></Form.Item></Col>
            <Col span={24}><Form.Item label="Описание"><Input.TextArea value={draft.description ?? ''} maxLength={2000} disabled={!canManage} autoSize={{ minRows: 2, maxRows: 5 }}
              onChange={(event) => setDraft({ ...draft, description: event.target.value || null })} /></Form.Item></Col>
            <Col span={24}><Checkbox checked={draft.isActive} disabled={!canManage || Boolean(selected?.isDefault)}
              onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })}>Активен</Checkbox></Col>
          </Row>
        </Form>
        <Space className="export-template-columns" direction="vertical" size={2} style={{ width: '100%' }}>
          <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}><Title level={5} style={{ margin: 0 }}>Колонки <Text type="secondary">({draft.columns.length})</Text></Title>
            <Button icon={<PlusOutlined />} disabled={!canManage || draft.columns.length >= 100} style={{ minHeight: 40 }}
              onClick={() => setDraft({ ...draft, columns: [...draft.columns, newColumn(draft.columns.length, catalog)] })}>Добавить колонку</Button></Space>
          {draft.columns.map((column, index) => <div key={column.columnKey} className="export-template-column-row">
            <Text type="secondary" className="export-template-column-index" style={{ fontVariantNumeric: 'tabular-nums' }}>{index + 1}</Text>
            <Input className="export-template-column-header" aria-label={`Название колонки ${index + 1}`} value={column.header} maxLength={200} disabled={!canManage}
              onChange={(event) => updateColumn(index, { ...column, header: event.target.value }, draft, setDraft)} />
            <div className="export-template-column-expression"><ExportExpressionEditor value={column.expression} catalog={catalog}
              columns={draft.columns} currentColumnKey={column.columnKey} disabled={!canManage}
              onChange={(expression) => updateColumn(index, { ...column, expression }, draft, setDraft)} /></div>
            <Space className="export-template-column-actions" size={2}><Button size="small" aria-label="Поднять колонку" icon={<ArrowUpOutlined />} disabled={!canManage || index === 0}
              onClick={() => setDraft({ ...draft, columns: moveColumn(draft.columns, index, index - 1) })} />
              <Button size="small" aria-label="Опустить колонку" icon={<ArrowDownOutlined />} disabled={!canManage || index === draft.columns.length - 1}
                onClick={() => setDraft({ ...draft, columns: moveColumn(draft.columns, index, index + 1) })} />
              <Button size="small" aria-label="Удалить колонку" danger icon={<DeleteOutlined />} disabled={!canManage || draft.columns.length === 1}
                onClick={() => removeColumn(index, draft, setDraft)} /></Space>
          </div>)}
          <Space wrap><Button onClick={() => void runPreview()} style={{ minHeight: 40 }}>Проверить и показать пример</Button>
            {selected && !selected.isDefault && <Button disabled={!canManage} style={{ minHeight: 40 }} onClick={() => void setDefault()}>Сделать по умолчанию</Button>}
            {selected && <Popconfirm title="Удалить шаблон?" description="Это действие скроет шаблон из экспорта." disabled={selected.isDefault}
              onConfirm={() => void remove()}><Button danger icon={<DeleteOutlined />} disabled={!canManage || selected.isDefault} style={{ minHeight: 40 }}>Удалить</Button></Popconfirm>}</Space>
          {preview.length > 0 && <Table size="small" pagination={false} rowKey="columnKey" dataSource={preview} columns={[
            { title: 'Колонка', dataIndex: 'header' }, { title: 'Пример', dataIndex: 'value', render: (value) => value == null ? <Text type="secondary">пусто</Text> : String(value) },
            { title: 'Тип', dataIndex: 'valueType', width: 110 },
          ]} />}
        </Space>
      </Card> : <Empty description="Выберите или создайте шаблон" />}</Col>
    </Row>
  </Space>;
};

function toDraft(template: ExportTemplateDto): ExportTemplateDraft { return JSON.parse(JSON.stringify({
  name: template.name, description: template.description, targetScreen: template.targetScreen,
  sourceType: template.sourceType, format: template.format, sheetName: template.sheetName,
  schemaVersion: template.schemaVersion, columns: template.columns, isActive: template.isActive,
})) as ExportTemplateDraft; }
function blankDraft(targetScreen: ExportTemplateTarget, catalog: ExportTemplateCatalog | null): ExportTemplateDraft {
  const sourceType = catalog?.targets.find((target) => target.code === targetScreen)?.sourceType ?? 'bazis_cut_set_detail';
  return { name: 'Новый шаблон', description: null, targetScreen, sourceType, format: 'xls_biff8', sheetName: 'Детали для раскроя', schemaVersion: 1,
    columns: [newColumn(0, catalog)], isActive: true };
}
function newColumn(index: number, catalog: ExportTemplateCatalog | null): ExportTemplateColumn {
  return { columnKey: `column-${Date.now()}-${index}`, header: `Колонка ${index + 1}`,
    expression: { type: 'field', field: catalog?.fields[0]?.key ?? 'row.number' } };
}
function updateColumn(index: number, column: ExportTemplateColumn, draft: ExportTemplateDraft, setDraft: (value: ExportTemplateDraft) => void) {
  setDraft({ ...draft, columns: draft.columns.map((item, itemIndex) => itemIndex === index ? column : item) });
}
function removeColumn(index: number, draft: ExportTemplateDraft, setDraft: (value: ExportTemplateDraft) => void) {
  const column = draft.columns[index];
  const referencedBy = draft.columns.filter((candidate) => candidate.columnKey !== column.columnKey
    && expressionReferencesColumn(candidate.expression, column.columnKey));
  if (referencedBy.length > 0) {
    message.warning(`Колонка «${column.header}» используется: ${referencedBy.map((item) => `«${item.header}»`).join(', ')}`);
    return;
  }
  setDraft({ ...draft, columns: draft.columns.filter((_, itemIndex) => itemIndex !== index) });
}
function moveColumn(columns: ExportTemplateColumn[], from: number, to: number): ExportTemplateColumn[] {
  const next = [...columns]; const [column] = next.splice(from, 1); next.splice(to, 0, column); return next;
}
function targetLabel(target: ExportTemplateTarget): string { return target === 'bazis_cut_set' ? 'Базис-раскрой' : 'Базис-проект'; }
