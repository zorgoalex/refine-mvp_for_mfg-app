import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Form, Input, InputNumber, Select, Space, Switch, Tabs, Typography } from 'antd';
import { inboundSignalsApi as api, type SignalConfiguration } from '../../../api/inboundSignalsApi';
import { can } from '../../../utils/permissions';

const codeRules = [{ required: true, pattern: /^[a-z][a-z0-9_.-]{1,63}$/, message: 'Код: 2–64 символа, латиница, цифры, точка, дефис или подчёркивание' }];
const required = [{ required: true, message: 'Заполните поле' }];
const empty: SignalConfiguration = { version: 1, sources: [], signals: [], resolvers: [], rules: [] };
export function MessageProcessingConfig() {
  const [form] = Form.useForm<SignalConfiguration>();
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const [sample, setSample] = useState(''), [source, setSource] = useState<string>(), [testResult, setTestResult] = useState<Awaited<ReturnType<typeof api.test>>>();
  const values = Form.useWatch([], form) as SignalConfiguration | undefined;
  const sources = (values?.sources ?? []).filter(Boolean), signals = (values?.signals ?? []).filter(Boolean), resolvers = (values?.resolvers ?? []).filter(Boolean);
  const allowed = can('message_signals.manage_config');
  const load = async () => { setBusy(true); try { form.setFieldsValue(await api.configuration()); setReady(true); setError(''); } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось загрузить настройки'); } finally { setBusy(false); } };
  useEffect(() => { if (allowed) void load(); }, [allowed]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (form.isFieldsTouched()) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [form]);
  if (!allowed) return <Alert type="warning" message="Нет прав на настройку обработки сообщений" />;
  const identity = (index: number) => <Space wrap align="start">
    <Form.Item name={[index, 'code']} label="Код" rules={codeRules}><Input maxLength={64} /></Form.Item>
    <Form.Item name={[index, 'name']} label="Название" rules={required}><Input maxLength={120} /></Form.Item>
  </Space>;
  const tagField = (index: number, key: string, label: string, mandatory = false) => <Form.Item name={[index, key]} label={label} rules={mandatory ? required : []}><Select mode="tags" tokenSeparators={[';']} open={false} placeholder="Введите значение и нажмите Enter" /></Form.Item>;
  return <Space direction="vertical" size="middle" style={{ width: '100%' }}>
    <Alert type="info" showIcon message="Обработка сообщений" description="Подключайте только доверенные группы: сообщения любого участника могут запускать действия системы. Личные автоответы WhatsApp настраиваются отдельно. Тексты и подробная история удаляются через 90 дней." />
    {error && <Alert type="error" message={error} action={!ready ? <Button onClick={() => void load()}>Повторить</Button> : undefined} />}
    {saved && <Alert type="success" message="Настройки сохранены" />}
    <Form form={form} layout="vertical" initialValues={empty} disabled={!ready || busy} onValuesChange={() => { setSaved(false); setTestResult(undefined); }} onFinish={async data => {
      setBusy(true); setSaved(false);
      try { const next = await api.saveConfiguration(data); form.resetFields(); form.setFieldsValue(next); setError(''); setSaved(true); }
      catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить. Обновите настройки перед повтором.'); }
      finally { setBusy(false); }
    }}>
      <Form.Item name="version" hidden><InputNumber /></Form.Item>
      <Tabs items={[
        { key: 'sources', label: 'Источники', children: <Form.List name="sources">{(fields, { add, remove }) => <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Paragraph>Новые сообщения принимаются после включения источника. История из группы не импортируется.</Typography.Paragraph>
          {fields.map(field => <Card key={field.key} title={`Источник ${field.name + 1}`} extra={<Button danger onClick={() => remove(field.name)}>Удалить</Button>}>
            {identity(field.name)}<Space wrap align="start">
              <Form.Item name={[field.name, 'channel']} label="Канал" rules={required}><Select style={{ width: 150 }} options={[{ value: 'whatsapp', label: 'WhatsApp' }]} /></Form.Item>
              <Form.Item name={[field.name, 'connection']} label="Имя сессии WAHA" rules={required}><Input /></Form.Item>
              <Form.Item name={[field.name, 'chatId']} label="ID группы" rules={[{ required: true, pattern: /^\d+(?:-\d+)?@g\.us$/, message: 'Нужен ID группы, заканчивающийся на @g.us' }]}><Input placeholder="120…@g.us" /></Form.Item>
              <Form.Item name={[field.name, 'enabled']} label="Принимать сообщения" valuePropName="checked"><Switch /></Form.Item>
            </Space>
          </Card>)}
          <Button onClick={() => add({ code: '', name: '', channel: 'whatsapp', connection: 'erp', chatId: '', enabled: false })}>Добавить источник</Button>
        </Space>}</Form.List> },
        { key: 'signals', label: 'Сигналы', children: <Form.List name="signals">{(fields, { add, remove }) => <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Paragraph>Стабильный код связывает сообщение с правилами автостатусов. Например: goods.ready — «Заказ готов».</Typography.Paragraph>
          {fields.map(field => <Card key={field.key} extra={<Button danger onClick={() => remove(field.name)}>Удалить</Button>}>{identity(field.name)}</Card>)}
          <Button onClick={() => add({ code: '', name: '' })}>Добавить сигнал</Button>
        </Space>}</Form.List> },
        { key: 'resolvers', label: 'Поиск заказа', children: <Form.List name="resolvers">{(fields, { add, remove }) => <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Paragraph>Шаблон ищет идентификатор после указанного слова. Например «заказ: 123». При нескольких заказах система попросит уточнение, автоматических действий не будет.</Typography.Paragraph>
          {fields.map(field => <Card key={field.key} extra={<Button danger onClick={() => remove(field.name)}>Удалить</Button>}>
            {identity(field.name)}
            <Form.Item name={[field.name, 'target']} label="По какому полю искать" rules={required}><Select options={[
              { value: 'order_id', label: 'Внутренний ID заказа' }, { value: 'order_name', label: 'Точное название заказа' },
              { value: 'cut_id', label: 'Внутренний ID раскроя → заказ' }, { value: 'project_code', label: 'Код проекта → заказ' },
            ]} /></Form.Item>
            {tagField(field.name, 'prefixes', 'Слова перед идентификатором', true)}
            <Form.Item name={[field.name, 'format']} label="Формат идентификатора" rules={required}><Select options={[{ value: 'digits', label: 'Только цифры' }, { value: 'code', label: 'Буквы, цифры, дефисы, точки и / без пробелов' }]} /></Form.Item>
          </Card>)}
          <Button onClick={() => add({ code: '', name: '', target: 'order_id', prefixes: [], format: 'digits' })}>Добавить шаблон</Button>
        </Space>}</Form.List> },
        { key: 'rules', label: 'Ключевые слова', children: <Form.List name="rules">{(fields, { add, remove }) => <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Paragraph>Все подходящие сигналы будут созданы. Несколько правил с одним кодом сигнала создадут один сигнал.</Typography.Paragraph>
          {fields.map(field => <Card key={field.key} extra={<Button danger onClick={() => remove(field.name)}>Удалить</Button>}>
            {identity(field.name)}
            <Form.Item name={[field.name, 'sourceCodes']} label="Источники" rules={required}><Select mode="multiple" options={sources.map(s => ({ value: s.code, label: s.name || s.code }))} /></Form.Item>
            <Form.Item name={[field.name, 'signalCode']} label="Какой сигнал создать" rules={required}><Select options={signals.map(s => ({ value: s.code, label: s.name || s.code }))} /></Form.Item>
            <Form.Item name={[field.name, 'resolverCode']} label="Шаблон поиска заказа" rules={required}><Select options={resolvers.map(s => ({ value: s.code, label: s.name || s.code }))} /></Form.Item>
            {tagField(field.name, 'keywords', 'Любое из ключевых слов / выражений', true)}
            {tagField(field.name, 'exclusions', 'Не срабатывать при этих выражениях')}
            <Space wrap align="start">
              <Form.Item name={[field.name, 'matchMode']} label="Совпадение" rules={required}><Select style={{ width: 230 }} options={[{ value: 'phrase', label: 'Целые слова / выражения' }, { value: 'contains', label: 'Любая часть текста' }, { value: 'exact', label: 'Сообщение целиком' }]} /></Form.Item>
              <Form.Item name={[field.name, 'priority']} label="Порядок проверки" rules={required}><InputNumber min={0} max={10000} /></Form.Item>
              <Form.Item name={[field.name, 'enabled']} label="Включено" valuePropName="checked"><Switch /></Form.Item>
            </Space>
          </Card>)}
          <Button onClick={() => add({ code: '', name: '', sourceCodes: [], signalCode: '', resolverCode: '', keywords: [], exclusions: [], matchMode: 'phrase', enabled: false, priority: 100 })}>Добавить правило</Button>
        </Space>}</Form.List> },
      ].map(item => ({ ...item, forceRender: true }))} />
      <Form.Item><Button type="primary" htmlType="submit" loading={busy} style={{ marginTop: 16, minHeight: 40 }}>Сохранить настройки</Button></Form.Item>
    </Form>
    <Card title="Проверить текст без создания событий"><Space direction="vertical" style={{ width: '100%' }}>
      <Select aria-label="Источник для проверки" placeholder="Источник" style={{ width: '100%' }} value={source} onChange={setSource} options={sources.map(s => ({ value: s.code, label: s.name || s.code }))} />
      <Input.TextArea aria-label="Текст для проверки" maxLength={16000} rows={3} value={sample} onChange={e => setSample(e.target.value)} placeholder="Вставьте пример сообщения" />
      <Button disabled={!source || !sample || !ready || busy} onClick={async () => { setBusy(true); try { const config = await form.validateFields(); setTestResult(await api.test(config, sample, source!)); setError(''); } catch (e) { setError(e instanceof Error ? e.message : 'Проверьте поля настройки'); } finally { setBusy(false); } }}>Проверить</Button>
      {testResult && (testResult.length ? testResult.map(r => <Alert key={r.ruleCode} type="success" message={`Сигнал: ${signals.find(s => s.code === r.signalCode)?.name ?? r.signalCode}`} description={`Правило: ${r.ruleCode}. Найденные идентификаторы: ${r.references.join(', ') || 'не найдены'}. Существование и однозначность заказа проверяются при приёме сообщения.`} />) : <Alert type="warning" message="Совпадений нет. Проверьте ключевые слова, исключения и включение правила." />)}
    </Space></Card>
  </Space>;
}
