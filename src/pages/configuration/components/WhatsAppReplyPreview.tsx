import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Input, Space, Typography } from 'antd';
import { whatsappApi } from '../../../api/whatsappApi';
import type { WhatsAppReplyPreview as Preview, WhatsAppRuleInput } from '../../../api/types/whatsappApi.types';

export function splitWhatsAppKeywords(text: string, mode: WhatsAppRuleInput['matchMode']) {
  return text.split(mode.startsWith('pattern_') ? /\n/ : /[,\n]/).map(v => v.trim()).filter(Boolean);
}

export function WhatsAppReplyPreview({ matchMode, keywordText, body, bodyMode = 'text' }: {
  matchMode: WhatsAppRuleInput['matchMode']; keywordText: string; body?: string; bodyMode?: 'text' | 'template';
}) {
  const [text, setText] = useState(''), [result, setResult] = useState<Preview>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => { generation.current++; setResult(undefined); setError(''); setBusy(false); }, [matchMode, keywordText, body, bodyMode, text]);
  useEffect(() => () => { generation.current++; }, []);
  const run = async () => {
    const request = ++generation.current;
    setBusy(true); setError(''); setResult(undefined);
    try {
      const value = await whatsappApi.preview({ matchMode, keywords: splitWhatsAppKeywords(keywordText, matchMode), body: body ?? '', bodyMode, text });
      if (request === generation.current) setResult(value);
    } catch (e) { if (request === generation.current) setError(e instanceof Error ? e.message : 'Не удалось проверить шаблон'); }
    finally { if (request === generation.current) setBusy(false); }
  };
  return <Card size="small" title="Проверить на примере">
    <Space direction="vertical" style={{ width: '100%' }}>
      <Typography.Text type="secondary">Ничего не отправляет и не расходует счётчик. Номер 1 — пример. Дата и время: Asia/Almaty. Проверяется только это правило, без приоритетов других правил.</Typography.Text>
      <Input.TextArea aria-label="Пример входящего сообщения" placeholder="Заказ 2222 готов" value={text} onChange={e => setText(e.target.value)} maxLength={4096} rows={3} />
      <Button style={{ minHeight: 40 }} loading={busy} disabled={!text.trim() || !body || !keywordText.trim()} onClick={() => void run()}>Проверить шаблон</Button>
      {error && <Alert type="error" showIcon message={error} />}
      {result && <Alert type={result.matched ? 'success' : 'warning'} showIcon message={result.matched ? 'Совпадение найдено' : 'Сообщение не совпало с правилом'} />}
      {result?.matched && <>
        <Typography.Text strong>Извлечённые значения</Typography.Text>
        {Object.entries(result.captures ?? {}).map(([key, value]) => <div key={key} style={{ overflowWrap: 'anywhere' }}><Typography.Text code>{key}</Typography.Text>: {value}</div>)}
        {!Object.keys(result.captures ?? {}).length && <Typography.Text type="secondary">Именованных полей нет</Typography.Text>}
        <Typography.Text strong>Готовый ответ</Typography.Text>
        <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{result.body}</div>
      </>}
    </Space>
  </Card>;
}
