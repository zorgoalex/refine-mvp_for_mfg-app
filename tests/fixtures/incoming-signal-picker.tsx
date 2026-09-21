import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider } from 'antd';
import ruRU from 'antd/locale/ru_RU';
import { inboundSignalsApi } from '../../src/api/inboundSignalsApi';
import { IncomingSignalSelect } from '../../src/pages/configuration/components/IncomingSignalSelect';

inboundSignalsApi.signalOptions = async () => {
  const response = await fetch('/fixture-signals');
  if (!response.ok) throw new Error('E2E-Test unavailable');
  return response.json();
};
function Fixture() {
  const [value, setValue] = useState<string[]>([]);
  return <ConfigProvider locale={ruRU}><main style={{ padding: 24, maxWidth: 700 }}>
    <h1>Тест: выбор входящего сигнала</h1>
    <IncomingSignalSelect value={value} onChange={setValue} />
    <output aria-label="Выбранные коды">{value.join(',')}</output>
  </main></ConfigProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
