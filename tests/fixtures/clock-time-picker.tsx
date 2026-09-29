import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Form } from 'antd';
import type { Dayjs } from 'dayjs';
import { ClockTimePicker } from '../../src/ui/ClockTimePicker';

// Fixture only: no ERP/WhatsApp access. Submitted values are printed into the DOM.
interface Values { sendTime?: Dayjs; catchUp?: Dayjs }

function App() {
  const [formDisabled, setFormDisabled] = useState(false);
  const [submits, setSubmits] = useState<string[]>([]);
  return (
    <div style={{ padding: 24, width: 360 }}>
      <input id="before" aria-label="Поле перед временем" />
      <Form<Values> layout="vertical" disabled={formDisabled}
        onFinish={(values) => setSubmits((prev) => [...prev, JSON.stringify({
          sendTime: values.sendTime?.format('HH:mm') ?? null, catchUp: values.catchUp?.format('HH:mm') ?? null,
        })])}>
        <Form.Item name="sendTime" label="Время отправки" rules={[{ required: true, message: 'Укажите время' }]}>
          <ClockTimePicker minuteStep={5} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="catchUp" label="Контрольное время">
          <ClockTimePicker minuteStep={5} style={{ width: '100%' }} />
        </Form.Item>
        <Button htmlType="submit" type="primary">Сохранить</Button>
      </Form>
      <Button onClick={() => setFormDisabled((v) => !v)} style={{ marginTop: 12 }}>{formDisabled ? 'Включить форму' : 'Отключить форму'}</Button>
      <div data-testid="submits">{submits.length}</div>
      <pre data-testid="last-submit">{submits[submits.length - 1] ?? ''}</pre>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
