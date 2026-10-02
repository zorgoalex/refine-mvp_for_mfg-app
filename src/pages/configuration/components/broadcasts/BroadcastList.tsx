import React from 'react';
import { Tag, Typography } from 'antd';
import type { BroadcastSummary } from '../../../../api/broadcastsApiTypes';
import { Table } from '../../../../ui/tooltipDelay';
import {
  RUN_STATE_LABELS,
  formatTimestamp,
  offsetLabel,
  runStateColor,
  timeLabel,
  weekdaysLabel,
} from './broadcastModel';
import { WhatsAppGroupLabel } from '../WhatsAppGroupLabel';

const { Text } = Typography;

export interface BroadcastListProps {
  broadcasts: BroadcastSummary[];
  selectedId: number | null;
  loading?: boolean;
  onSelect: (id: number) => void;
}

export const BroadcastList: React.FC<BroadcastListProps> = ({ broadcasts, selectedId, loading, onSelect }) => {
  const columns = [
    { title: 'Название', dataIndex: 'name', ellipsis: true, render: (name: string, row: BroadcastSummary) => <Text strong={row.id === selectedId}>{name}</Text> },
    { title: 'Группа', dataIndex: 'groupChatId', width: 220, ellipsis: true, render: (id: string | null) => <WhatsAppGroupLabel id={id} /> },
    { title: 'Дни', dataIndex: 'weekdays', width: 130, render: (days: number[]) => weekdaysLabel(days) },
    { title: 'Время', width: 170, render: (_: unknown, row: BroadcastSummary) => timeLabel(row.sendTime, row.sendWindowMinutes) },
    { title: 'Заказы на', dataIndex: 'orderDateOffsetDays', width: 130, render: (offset: number) => offsetLabel(offset) },
    { title: 'Вкл', dataIndex: 'enabled', width: 90, render: (enabled: boolean) => <Tag color={enabled ? 'green' : 'default'}>{enabled ? 'Включена' : 'Выключена'}</Tag> },
    {
      title: 'Последняя отправка',
      width: 230,
      render: (_: unknown, row: BroadcastSummary) => row.lastRun
        ? <span><Tag color={runStateColor(row.lastRun.state)}>{RUN_STATE_LABELS[row.lastRun.state]}</Tag>{formatTimestamp(row.lastRun.createdAt)}</span>
        : '—',
    },
  ];
  return <Table<BroadcastSummary>
    rowKey="id"
    loading={loading}
    dataSource={broadcasts}
    columns={columns}
    pagination={false}
    scroll={{ x: 900 }}
    locale={{ emptyText: 'Рассылок пока нет. Создайте первую.' }}
    rowClassName={() => 'broadcast-row-clickable'}
    onRow={(row) => ({ onClick: () => onSelect(row.id) })}
  />;
};
