import { Alert, Button, Select, Space, Typography } from 'antd';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { inboundSignalsApi, type SignalOption } from '../../../api/inboundSignalsApi';

interface Props {
  value: string[];
  onChange: (value: string[]) => void;
}

export function IncomingSignalSelect({ value, onChange }: Props) {
  const [signals, setSignals] = useState<SignalOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError(false);
    try {
      const result = await inboundSignalsApi.signalOptions();
      if (current === generation.current) { setSignals(result); setLoaded(true); }
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
    return () => { generation.current++; };
  }, [reload]);

  const missing = loaded && !loading && !error
    ? value.filter(code => !signals.some(signal => signal.code === code)) : [];
  const options = [
    ...signals.map(signal => ({ value: signal.code, label: `${signal.name} (${signal.code})` })),
    ...value.filter(code => !signals.some(signal => signal.code === code)).map(code => ({
      value: code, label: missing.includes(code) ? `${code} — нет в справочнике` : code,
    })),
  ];

  return <Space direction="vertical" style={{ width: '100%' }}>
    <Select<string[]>
      aria-label="Входящий сигнал — один из"
      mode="multiple"
      size="large"
      value={value}
      onChange={onChange}
      options={options}
      loading={loading}
      disabled={loading || error}
      showSearch
      optionFilterProp="label"
      placeholder="Выберите один или несколько сигналов"
      notFoundContent={signals.length ? 'Сигнал не найден' : 'Сигналы ещё не настроены'}
      style={{ width: '100%' }}
    />
    {error && <Alert type="error" showIcon message="Не удалось загрузить список сигналов. Повторите загрузку. Выбранные значения сохранены." />}
    {loaded && !loading && !error && signals.length === 0 && <Alert type="info" showIcon
      message="Сначала добавьте и сохраните сигналы: Конфигурация → Обработка сообщений → Сигналы. Затем обновите список." />}
    {missing.length > 0 && <Alert type="warning" showIcon
      message={`В справочнике больше нет выбранных сигналов: ${missing.join(', ')}. Они не удалены из правила автоматически.`} />}
    <Button onClick={() => void reload()} loading={loading} style={{ minHeight: 40 }}>Обновить список сигналов</Button>
    <Typography.Text type="secondary">Можно выбрать несколько сигналов — подойдёт любой из них. Лишние убираются крестиком. В скобках — код сигнала; вручную вводить его не нужно.</Typography.Text>
  </Space>;
}
