import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Descriptions, Empty, Radio, Select, Space, Spin, Tag, Typography } from 'antd';
import { Table } from '../../ui/tooltipDelay';
import { ApiError } from '../../api/apiError';
import { onecApi } from './onecApi';
import type { OnecAgentView } from './onecApi.types';
import {
  ONEC_STATE_LABELS,
  onecAlertKindLabel,
  onecCommandStatusLabel,
  onecCommandTypeLabel,
  onecEtlEntityLabel,
  onecEtlRunModeLabel,
  onecEtlRunStatusColor,
  onecEtlRunStatusLabel,
  onecIncidentKindLabel,
} from './onecFormat';
import { buildPlainJournal, formatBytes, type OnecDailyJournal } from './onecJournal';

const { Text, Paragraph } = Typography;

export type JournalView = 'plain' | 'technical';

export interface DailyJournalTabProps {
  agents: OnecAgentView[];
}

const dateTime = (value: string | null) => (value ? new Date(value).toLocaleString('ru-RU') : '—');
const stateLabel = (state: string) => ONEC_STATE_LABELS[state as keyof typeof ONEC_STATE_LABELS] ?? state;

/** Журнал связи с агентом 1С за последние сутки: простой вид и технический (те же данные таблицами). */
export function DailyJournalTab({ agents }: DailyJournalTabProps) {
  const [agentId, setAgentId] = useState<string>(agents[0]?.agentId ?? '');
  const [view, setView] = useState<JournalView>('plain');
  const [journal, setJournal] = useState<OnecDailyJournal | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Поколение запроса: ответ устаревшего запроса (другой агент / повторное «Обновить») не попадает на экран.
  const generation = useRef(0);
  const load = useCallback(async () => {
    if (!agentId) return;
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const result = await onecApi.dailyJournal(agentId);
      if (current === generation.current) setJournal(result);
    } catch (err) {
      if (current === generation.current) setError(err instanceof ApiError ? err.message : 'Не удалось загрузить журнал');
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    // Смена агента: прежний журнал не показываем до ответа по новому.
    setJournal(null);
    void load();
  }, [load]);

  const shown = journal && journal.agentId === agentId ? journal : null;
  const plain = useMemo(() => (shown ? buildPlainJournal(shown) : null), [shown]);

  if (agents.length === 0) return <Empty description="Агентов 1С нет" />;

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space wrap>
        <Select
          value={agentId}
          onChange={setAgentId}
          style={{ minWidth: 240 }}
          options={agents.map((agent) => ({ value: agent.agentId, label: agent.displayName || agent.agentId }))}
        />
        <Radio.Group
          optionType="button"
          buttonStyle="solid"
          value={view}
          onChange={(event) => setView(event.target.value as JournalView)}
          options={[{ label: 'Простой', value: 'plain' }, { label: 'Технический', value: 'technical' }]}
        />
        <Button onClick={() => void load()} loading={loading}>Обновить</Button>
        {shown && <Text type="secondary">За период {dateTime(shown.from)} — {dateTime(shown.to)}</Text>}
      </Space>
      {error && <Alert type="error" showIcon message={error} />}
      {loading && !shown && <Spin />}
      {shown && plain && view === 'plain' && (
        <Alert
          type={plain.tone}
          showIcon
          message={plain.headline}
          description={<ul style={{ margin: 0, paddingLeft: 18 }}>{plain.lines.map((line) => <li key={line}>{line}</li>)}</ul>}
        />
      )}
      {shown && view === 'technical' && <TechnicalJournal journal={shown} />}
      <Paragraph type="secondary" style={{ margin: 0 }}>
        Журнал считается по данным последних 24 часов. Отдельно не хранится: история связи старше суток удаляется автоматически.
      </Paragraph>
    </Space>
  );
}

function TechnicalJournal({ journal }: { journal: OnecDailyJournal }) {
  const { connection } = journal;
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Card size="small" title="Связь">
        <Descriptions size="small" column={2}>
          <Descriptions.Item label="Последний контакт">{dateTime(connection.lastSeenAt)}</Descriptions.Item>
          <Descriptions.Item label="Записей состояния (heartbeat)">{connection.heartbeats}</Descriptions.Item>
          <Descriptions.Item label="Время в состояниях">
            {connection.stateTime.map((s) => (
              <Tag key={s.state} color={s.state === 'healthy' ? 'green' : s.state === 'no_contact' ? 'red' : 'orange'}>
                {s.state === 'no_contact' ? 'Нет связи' : stateLabel(s.state)}: {Math.round(s.ms / 60_000)} мин
              </Tag>
            ))}
          </Descriptions.Item>
          <Descriptions.Item label="Состояния">
            {connection.states.length === 0 ? '—' : connection.states.map((s) => <Tag key={s.state}>{stateLabel(s.state)} ({s.state}): {s.count}</Tag>)}
          </Descriptions.Item>
        </Descriptions>
        <Table
          size="small"
          rowKey={(row) => `${row.accepted}-${row.agentVersion}-${row.firstAt}`}
          pagination={false}
          dataSource={connection.sessions}
          columns={[
            { title: 'Сессии', dataIndex: 'accepted', render: (value: boolean) => (value ? <Tag color="green">приняты</Tag> : <Tag color="red">отказ</Tag>) },
            { title: 'Версия агента', dataIndex: 'agentVersion', render: (value: string | null) => value ?? '—' },
            { title: 'Кол-во', dataIndex: 'count' },
            { title: 'Первая', dataIndex: 'firstAt', render: dateTime },
            { title: 'Последняя', dataIndex: 'lastAt', render: dateTime },
          ]}
        />
        {connection.stateChanges.length > 0 && (
          <Table
            size="small"
            style={{ marginTop: 8 }}
            rowKey={(row) => `${row.at}-${row.state}`}
            pagination={false}
            dataSource={connection.stateChanges}
            columns={[
              { title: 'Смена состояния', dataIndex: 'at', render: dateTime },
              { title: 'Состояние', dataIndex: 'state', render: (value: string) => `${stateLabel(value)} (${value})` },
              { title: 'Причина', dataIndex: 'reason', render: (value: string | null) => value ?? '—' },
            ]}
          />
        )}
      </Card>
      <Card size="small" title={`Выгрузки (${journal.runs.length})`}>
        <Table
          size="small"
          rowKey="runId"
          pagination={false}
          dataSource={journal.runs}
          columns={[
            { title: 'Run', dataIndex: 'runId', render: (value: string) => <Text code copyable={{ text: value }}>{value.slice(0, 8)}</Text> },
            { title: 'Режим', dataIndex: 'mode', render: (value: string | null) => onecEtlRunModeLabel(value) },
            { title: 'Статус', dataIndex: 'status', render: (value: string) => <Tag color={onecEtlRunStatusColor(value)}>{onecEtlRunStatusLabel(value)}</Tag> },
            { title: 'Начата', dataIndex: 'createdAt', render: dateTime },
            { title: 'Завершена', dataIndex: 'completedAt', render: dateTime },
            { title: 'Пакетов', dataIndex: 'batches' },
            { title: 'Строк', dataIndex: 'rows' },
            { title: 'Объём', dataIndex: 'bytes', render: formatBytes },
            { title: 'Сбоев сущностей', dataIndex: 'entitiesFailed', render: (value: number | null) => value ?? '—' },
          ]}
        />
      </Card>
      <Card size="small" title="Получено по наборам (сохранённые пакеты)">
        <Table
          size="small"
          rowKey="entity"
          pagination={false}
          dataSource={journal.entities}
          columns={[
            { title: 'Набор', dataIndex: 'entity', render: (value: string) => `${onecEtlEntityLabel(value)} (${value})` },
            { title: 'Выгрузок', dataIndex: 'runs' },
            { title: 'Пакетов', dataIndex: 'batches' },
            { title: 'Строк', dataIndex: 'rows' },
            { title: 'Объём', dataIndex: 'bytes', render: formatBytes },
            { title: 'Отклонено пакетов', dataIndex: 'invalidBatches' },
            { title: 'Не завершено', dataIndex: 'pendingBatches' },
          ]}
        />
      </Card>
      <Card size="small" title="Документы 1С (загрузчик ERP)">
        <Table
          size="small"
          rowKey={(row) => `${row.event}-${row.docKind}`}
          pagination={false}
          dataSource={journal.documents}
          columns={[
            { title: 'Событие', dataIndex: 'event' },
            { title: 'Вид документа', dataIndex: 'docKind', render: (value: string | null) => value ?? '—' },
            { title: 'Кол-во', dataIndex: 'count' },
          ]}
        />
      </Card>
      <Card size="small" title="Команды, конфигурация, алерты, инциденты">
        <Descriptions size="small" column={1}>
          <Descriptions.Item label="Команды">
            {journal.commands.length === 0 ? '—' : journal.commands.map((c) => (
              <Tag key={`${c.commandType}-${c.status}`}>{onecCommandTypeLabel(c.commandType)} · {onecCommandStatusLabel(c.status)}: {c.count}</Tag>
            ))}
          </Descriptions.Item>
          <Descriptions.Item label="Опубликованные версии конфигурации">
            {journal.configVersions.length === 0 ? '—' : journal.configVersions.map((c) => <Tag key={c.configVersion}>{c.configVersion} · {dateTime(c.publishedAt)}</Tag>)}
          </Descriptions.Item>
          <Descriptions.Item label="Алерты">
            {journal.alerts.length === 0 ? '—' : journal.alerts.map((a) => (
              <Tag key={a.kind} color={a.open > 0 ? 'orange' : undefined}>{onecAlertKindLabel(a.kind)}: открыто {a.opened}, закрыто {a.resolved}, сейчас {a.open}</Tag>
            ))}
          </Descriptions.Item>
          <Descriptions.Item label="Инциденты">
            {journal.incidents.length === 0 ? '—' : journal.incidents.map((i) => (
              <Tag key={i.kind} color={i.open > 0 ? 'orange' : undefined}>{onecIncidentKindLabel(i.kind)}: {i.count} (повторов {i.occurrences}, открыто {i.open})</Tag>
            ))}
          </Descriptions.Item>
        </Descriptions>
      </Card>
    </Space>
  );
}
