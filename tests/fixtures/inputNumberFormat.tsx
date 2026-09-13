import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Form, InputNumber } from 'antd';
import { formatNumber, numberFormatter, numberParser } from '../../src/utils/numberFormat';
import { formatInputNumber, optionalInputNumberFormatter } from '../../src/utils/inputNumberFormat';

function Fields({ legacy }: { legacy: boolean }) {
  const [saved, setSaved] = useState<unknown>(null);
  const [amount, setAmount] = useState(1234.5);
  return <section data-testid={legacy ? 'legacy' : 'current'}>
    <Form name={legacy ? 'legacy' : 'current'} initialValues={{ sort_order: 100, priority: 50 }} onFinish={setSaved}>
      <Form.Item name="sort_order" label="Сортировка">
        <InputNumber min={1} max={32767} parser={numberParser}
          formatter={value => legacy ? Reflect.apply(numberFormatter, undefined, [value, 0]) : optionalInputNumberFormatter(value, 0)} />
      </Form.Item>
      <Form.Item name="priority" label="Приоритет">
        <InputNumber min={1} max={100} parser={numberParser}
          formatter={value => legacy ? Reflect.apply(numberFormatter, undefined, [value, 0]) : optionalInputNumberFormatter(value, 0)} />
      </Form.Item>
      <button type="submit">Сохранить тестовые значения</button>
    </Form>
    <label>Сумма<InputNumber readOnly value={amount} precision={2} parser={numberParser}
      formatter={value => legacy ? Reflect.apply(formatNumber, undefined, [value, 2]) : formatInputNumber(value, 2)} /></label>
    <button onClick={() => setAmount(0)}>Нулевая сумма</button>
    <button onClick={() => setAmount(1234.56)}>Дробная сумма</button>
    <output>{JSON.stringify(saved)}</output>
  </section>;
}
createRoot(document.getElementById('root')!).render(<><Fields legacy /><Fields legacy={false} /></>);
