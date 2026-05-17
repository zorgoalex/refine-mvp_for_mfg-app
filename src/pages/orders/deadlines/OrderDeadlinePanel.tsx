import { Alert, Collapse, Empty, Space, Spin, Table, Tag, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { deadlinesApi } from '../../../api/deadlinesApi';
import type {
  DeadlineDto,
  DeadlineEventDto,
  OrderDeadlineSummary,
} from '../../../api/types/deadlineApi.types';
import { featureFlags } from '../../../config/featureFlags';
import {
  buildDeadlineEventRows,
  buildDeadlineRows,
  formatDeadlineDate,
  formatDeadlineDuration,
  getDeadlineSeverityColor,
  summarizeDeadlineCounts,
} from './orderDeadlineView';

const { Panel } = Collapse;
const { Text } = Typography;

interface OrderDeadlinePanelProps {
  orderId: number | null | undefined;
}

interface DeadlinePanelState {
  loading: boolean;
  summary: OrderDeadlineSummary | null;
  deadlines: DeadlineDto[];
  events: DeadlineEventDto[];
  error: string | null;
}

const initialState: DeadlinePanelState = {
  loading: false,
  summary: null,
  deadlines: [],
  events: [],
  error: null,
};

export function OrderDeadlinePanel({ orderId }: OrderDeadlinePanelProps) {
  const [state, setState] = useState<DeadlinePanelState>(initialState);
  const enabled = featureFlags.useBackendDeadlines && !!orderId;

  useEffect(() => {
    let cancelled = false;

    async function loadDeadlines() {
      if (!enabled || !orderId) {
        setState(initialState);
        return;
      }

      setState({
        loading: true,
        summary: null,
        deadlines: [],
        events: [],
        error: null,
      });

      try {
        const [summary, deadlines, events] = await Promise.all([
          deadlinesApi.getSummaryForOrder(orderId),
          deadlinesApi.listForOrder(orderId),
          deadlinesApi.listEventsForOrder(orderId),
        ]);

        if (cancelled) return;

        setState({
          loading: false,
          summary,
          deadlines: deadlines.data,
          events: events.data,
          error: null,
        });
      } catch (error) {
        if (cancelled) return;
        setState({
          loading: false,
          summary: null,
          deadlines: [],
          events: [],
          error: error instanceof Error ? error.message : 'Не удалось загрузить дедлайны',
        });
      }
    }

    void loadDeadlines();

    return () => {
      cancelled = true;
    };
  }, [enabled, orderId]);

  const deadlineRows = useMemo(() => buildDeadlineRows(state.deadlines), [state.deadlines]);
  const eventRows = useMemo(() => buildDeadlineEventRows(state.events), [state.events]);
  const finalDeadlineColor = state.summary?.finalDeadline
    ? getDeadlineSeverityColor(state.summary.finalDeadline.severity)
    : undefined;
  const currentStageDeadlineColor = state.summary?.currentStageDeadline
    ? getDeadlineSeverityColor(state.summary.currentStageDeadline.severity)
    : undefined;

  if (!featureFlags.useBackendDeadlines) {
    return null;
  }

  return (
    <Collapse defaultActiveKey={['deadlines']} style={{ marginBottom: 4 }} className="compact-collapse">
      <Panel
        key="deadlines"
        header={<span style={{ fontSize: 12, fontWeight: 600, color: '#1677ff' }}>Дедлайны</span>}
      >
        {state.loading ? (
          <Spin />
        ) : state.error ? (
          <Alert type="error" message="Ошибка загрузки дедлайнов" description={state.error} showIcon />
        ) : (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Text>{summarizeDeadlineCounts(state.summary)}</Text>
            <Space wrap size={8}>
              <Tag color={finalDeadlineColor}>
                Финальный: {formatDeadlineDate(state.summary?.finalDeadline?.deadlineAt)}
              </Tag>
              <Tag color={currentStageDeadlineColor}>
                Текущий этап: {formatDeadlineDate(state.summary?.currentStageDeadline?.deadlineAt)}
              </Tag>
              <Tag>
                До текущего этапа: {formatDeadlineDuration(state.summary?.currentStageDeadline?.remainingMinutes ?? null)}
              </Tag>
            </Space>
            {deadlineRows.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Дедлайны не найдены" />
            ) : (
              <Table
                size="small"
                rowKey="key"
                pagination={false}
                dataSource={deadlineRows}
                columns={[
                  { title: 'Тип', dataIndex: 'entity', key: 'entity', width: 140 },
                  { title: 'Срок', dataIndex: 'deadlineAt', key: 'deadlineAt', width: 170 },
                  {
                    title: 'Статус',
                    dataIndex: 'status',
                    key: 'status',
                    width: 150,
                    render: (value, row) => <Tag color={row.severityColor}>{value}</Tag>,
                  },
                  { title: 'Источник', dataIndex: 'source', key: 'source', width: 120 },
                  { title: 'Обновлен', dataIndex: 'updatedAt', key: 'updatedAt', width: 170 },
                ]}
              />
            )}
            <Table
              size="small"
              rowKey="key"
              pagination={false}
              dataSource={eventRows}
              locale={{ emptyText: 'События дедлайнов не найдены' }}
              columns={[
                { title: 'Событие', dataIndex: 'eventType', key: 'eventType' },
                {
                  title: 'Важность',
                  dataIndex: 'severity',
                  key: 'severity',
                  width: 110,
                  render: (value, row) => <Tag color={row.severityColor}>{value}</Tag>,
                },
                { title: 'Дата', dataIndex: 'eventAt', key: 'eventAt', width: 170 },
                { title: 'Задержка', dataIndex: 'delay', key: 'delay', width: 120 },
              ]}
            />
          </Space>
        )}
      </Panel>
    </Collapse>
  );
}
