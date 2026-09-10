import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Modal, Select, Space, Switch, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { LocalizedList } from '../../components/LocalizedList';
import { Table } from '../../ui/tooltipDelay';
import { catalogApi, type CatalogInput, type CatalogItem, type CatalogKind, type CatalogUnit } from '../../api/catalogApi';
import { can } from '../../utils/permissions';
import { CATALOG_KIND_OPTIONS, catalogDraft, catalogPayload, catalogFailureState, catalogCommandIdentity } from './catalogForm';

export function CatalogItemsList() {
  const canManage = can('references.manage');
  const canView = canManage || can('references.view');
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [units, setUnits] = useState<CatalogUnit[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState<{ q: string; kind?: CatalogKind; active: 'true' | 'false' | 'all'; offset: number; limit: number }>({ q: '', active: 'true', offset: 0, limit: 25 });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [formError, setFormError] = useState('');
  const [stale, setStale] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CatalogItem>();
  const [saving, setSaving] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [form] = Form.useForm<CatalogInput>();
  const [modal, contextHolder] = Modal.useModal();
  const sequence = useRef(0);
  const command = useRef<{ fingerprint: string; key: string }>();
  const savingRef = useRef(false);

  const load = useCallback(async () => {
    if (!canView) return;
    const current = ++sequence.current;
    setLoading(true); setLoadError('');
    try {
      const [page, unitList] = await Promise.all([catalogApi.list(query), catalogApi.units()]);
      if (current !== sequence.current) return;
      setItems(page.items); setTotal(page.total); setUnits(unitList);
    } catch (error) {
      if (current === sequence.current) setLoadError(error instanceof Error ? error.message : 'Не удалось загрузить справочник');
    } finally { if (current === sequence.current) setLoading(false); }
  }, [canView, query]);
  useEffect(() => { void load(); return () => { ++sequence.current; }; }, [load]);
  useEffect(() => {
    if (!open || (!dirty && !uncertain)) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [open, dirty, uncertain]);

  const start = (item?: CatalogItem) => {
    setEditing(item); setFormError(''); setStale(false); setDirty(false); setUncertain(false); command.current = undefined;
    form.resetFields(); form.setFieldsValue(catalogDraft(item)); setOpen(true);
  };
  const close = () => {
    if (savingRef.current || uncertain) return;
    if (!dirty) { setOpen(false); return; }
    modal.confirm({ title: 'Отменить несохранённые изменения?', okText: 'Отменить изменения', cancelText: 'Продолжить редактирование', onOk: () => setOpen(false) });
  };
  const reloadCard = () => {
    if (!editing) return;
    modal.confirm({ title: 'Загрузить актуальную версию?', content: 'Несохранённые изменения формы будут заменены.', okText: 'Загрузить', cancelText: 'Оставить форму', onOk: async () => {
      try { start(await catalogApi.get(editing.id)); } catch (error) { setFormError(error instanceof Error ? error.message : 'Не удалось загрузить карточку'); }
    } });
  };
  const save = async () => {
    if (!canManage || savingRef.current) return;
    savingRef.current = true; setSaving(true);
    let submitted = false;
    try {
      const input = catalogPayload(await form.validateFields());
      const payload = editing ? { ...input, expectedVersion: editing.version } : input;
      const fingerprint = JSON.stringify({ id: editing?.id ?? null, payload });
      command.current = catalogCommandIdentity(command.current, fingerprint);
      setFormError('');
      submitted = true;
      const saved = editing ? await catalogApi.update(editing.id, { ...input, expectedVersion: editing.version }, command.current.key)
        : await catalogApi.create(input, command.current.key);
      setUncertain(false); setDirty(false); setOpen(false);
      message.success(`«${saved.name}»: сохранено`); void load();
    } catch (error) {
      if (error && typeof error === 'object' && 'errorFields' in error) return;
      const failure = catalogFailureState(error, submitted);
      setFormError(failure.message);
      setStale(failure.stale);
      // Unknown server/network result: freeze payload until same-key retry resolves it.
      // Validation before the request must not put the form in this state.
      setUncertain(failure.uncertain);
    } finally { savingRef.current = false; setSaving(false); }
  };

  const columns: ColumnsType<CatalogItem> = [
    { title: 'Название / артикул', dataIndex: 'name', width: 270, render: (_, item) => <div style={{ overflowWrap: 'anywhere' }}><Typography.Text strong>{item.name}</Typography.Text><br /><Typography.Text type="secondary">{item.sku ?? 'Без артикула'}</Typography.Text></div> },
    { title: 'Тип', dataIndex: 'kind', width: 160, render: kind => CATALOG_KIND_OPTIONS.find(option => option.value === kind)?.label },
    { title: 'Единица', dataIndex: 'unitName', width: 130 },
    { title: 'Базовая цена, ₸', dataIndex: 'basePrice', align: 'right', width: 155, render: price => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{price === null ? 'Не задана' : Number(price).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span> },
    { title: 'Состояние', dataIndex: 'isActive', width: 125, render: active => <Tag color={active ? 'green' : undefined}>{active ? 'Активна' : 'В архиве'}</Tag> },
    { title: 'Действия', width: 130, render: (_, item) => <Button style={{ minHeight: 40 }} onClick={() => start(item)}>{canManage ? 'Изменить' : 'Просмотр'}</Button> },
  ];

  if (!canView) return <Alert type="warning" showIcon message="Нет доступа к справочнику «Товары и услуги»" />;
  return <LocalizedList title="Товары и услуги" canCreate={false}>
    {contextHolder}
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>Общий каталог продаваемых позиций. Базовая цена справочная — существующие заказы не пересчитываются. Сопоставление с Bitrix будет отдельным этапом.</Typography.Paragraph>
      <Space wrap>
        <Input.Search aria-label="Поиск товара или услуги" placeholder="Название или артикул" allowClear onSearch={q => setQuery(previous => ({ ...previous, q, offset: 0 }))} style={{ width: 260 }} />
        <Select aria-label="Тип позиции" placeholder="Все типы" allowClear options={CATALOG_KIND_OPTIONS} value={query.kind} onChange={kind => setQuery(previous => ({ ...previous, kind, offset: 0 }))} style={{ width: 185 }} />
        <Select aria-label="Состояние позиций" value={query.active} onChange={active => setQuery(previous => ({ ...previous, active, offset: 0 }))} options={[{ value: 'true', label: 'Активные' }, { value: 'false', label: 'Архив' }, { value: 'all', label: 'Все записи' }]} style={{ width: 145 }} />
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>Обновить</Button>
        {canManage && <Button type="primary" icon={<PlusOutlined />} disabled={loading || !!loadError || !units.length} onClick={() => start()}>Создать позицию</Button>}
      </Space>
      {loadError ? <Alert type="error" showIcon message="Не удалось загрузить справочник" description={loadError} action={<Button onClick={() => void load()}>Повторить</Button>} />
        : <Table<CatalogItem> rowKey="id" loading={loading} dataSource={items} columns={columns} scroll={{ x: 970 }} locale={{ emptyText: query.q || query.kind || query.active === 'false' ? 'По выбранным условиям позиций нет' : 'Каталог пока пуст. Создайте первый товар или услугу.' }} pagination={{ total, current: Math.floor(query.offset / query.limit) + 1, pageSize: query.limit, pageSizeOptions: [25, 50, 100], showSizeChanger: true, onChange: (page, limit) => setQuery(previous => ({ ...previous, limit, offset: (page - 1) * limit })) }} />}
      {!loading && !loadError && units.length === 0 && <Alert type="warning" showIcon message="Нет единиц измерения" description="Сначала добавьте единицу в справочнике «Единицы измерения», затем нажмите «Обновить»." />}
    </Space>
    <Modal open={open} title={editing ? (canManage ? 'Изменить позицию' : 'Карточка позиции') : 'Новая позиция'} onCancel={close} closable={!saving && !uncertain} maskClosable={false} keyboard={!saving && !uncertain} width={620} footer={<Space>
      <Button disabled={saving || uncertain} onClick={close}>{canManage ? 'Отмена' : 'Закрыть'}</Button>
      {canManage && <Button type="primary" loading={saving} disabled={stale} onClick={() => void save()}>{uncertain ? 'Проверить повтором' : 'Сохранить'}</Button>}
    </Space>}>
      {formError && <Alert style={{ marginBottom: 16 }} type="error" showIcon message={formError} action={stale ? <Button onClick={reloadCard}>Загрузить версию</Button> : undefined} />}
      {uncertain && <Alert style={{ marginBottom: 16 }} type="warning" message="Результат сохранения неизвестен" description="Повторите проверку этой же команды. Поля временно заблокированы, чтобы не создать дубль." />}
      <Form form={form} layout="vertical" disabled={!canManage || saving || uncertain} onValuesChange={() => setDirty(true)}>
        <Form.Item name="name" label="Название" rules={[{ required: true, whitespace: true, message: 'Введите название' }]}><Input maxLength={200} /></Form.Item>
        <Form.Item name="sku" label="Артикул" extra="Необязательно. Уникален также среди архивных записей."><Input maxLength={80} /></Form.Item>
        <Form.Item name="kind" label="Тип позиции" rules={[{ required: true }]}><Select options={CATALOG_KIND_OPTIONS} /></Form.Item>
        <Form.Item name="unitId" label="Единица измерения" rules={[{ required: true, message: 'Выберите единицу измерения' }]}><Select showSearch optionFilterProp="label" options={units.map(unit => ({ value: unit.id, label: `${unit.name}${unit.symbol ? ` (${unit.symbol})` : ''}` }))} /></Form.Item>
        <Form.Item name="basePrice" label="Базовая цена, ₸" extra="Пусто — цена не задана; 0 — бесплатная позиция."><InputNumber<string> stringMode controls={false} style={{ width: '100%' }} placeholder="Не задана" decimalSeparator="," /></Form.Item>
        <Form.Item name="description" label="Описание"><Input.TextArea rows={3} maxLength={2000} showCount /></Form.Item>
        <Form.Item name="isActive" label="Активна" valuePropName="checked" extra="Выключите, чтобы архивировать. Позже позицию можно восстановить."><Switch /></Form.Item>
      </Form>
    </Modal>
  </LocalizedList>;
}
