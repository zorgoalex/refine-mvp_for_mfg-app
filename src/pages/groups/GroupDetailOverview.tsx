import React from 'react';
import { Descriptions, Space, Statistic, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type {
  OrderGroupRelationType,
  GroupDeadlineStatusCountsResponse,
  GroupOverviewResponse,
  GroupStatus,
} from '../../api/types/groupApi.types';

const { Text, Title } = Typography;

const GROUP_STATUS_LABELS: Record<GroupStatus, string> = {
  draft: 'Черновик',
  active: 'Активен',
  paused: 'Пауза',
  completed: 'Завершен',
  archived: 'Архив',
};

interface GroupDetailOverviewProps {
  overview: GroupOverviewResponse;
  deadlineStatusCounts?: GroupDeadlineStatusCountsResponse | null;
}

type StatusCountRow = GroupOverviewResponse['orders']['statusCounts'][number];
type RelationCountRow = GroupOverviewResponse['orders']['relationCounts'][number];
type CreatedMonthCountRow = GroupOverviewResponse['orders']['createdMonthCounts'][number];
type LinkedEntityCountRow = GroupOverviewResponse['linkedEntityCounts'][number];
type ParticipantSummaryRow = GroupOverviewResponse['participants']['currentSummary'][number];
type DeadlineStatusCountRow = GroupDeadlineStatusCountsResponse['data'][number];

const statusColumns: ColumnsType<StatusCountRow> = [
  {
    title: 'Статус',
    dataIndex: 'statusName',
    key: 'statusName',
  },
  {
    title: 'Количество',
    dataIndex: 'orderCount',
    key: 'orderCount',
    width: 140,
    align: 'right',
  },
];

const relationLabels: Record<OrderGroupRelationType, string> = {
  main: 'main',
  secondary: 'secondary',
  reporting: 'reporting',
  billing: 'billing',
  derived: 'derived',
};

const relationColumns: ColumnsType<RelationCountRow> = [
  {
    title: 'Тип',
    dataIndex: 'relationType',
    key: 'relationType',
    render: (relationType: OrderGroupRelationType) => relationLabels[relationType] ?? relationType,
  },
  {
    title: 'Основная',
    dataIndex: 'isPrimary',
    key: 'isPrimary',
    width: 120,
    render: (isPrimary: boolean) => (isPrimary ? 'Да' : 'Нет'),
  },
  {
    title: 'Количество',
    dataIndex: 'orderCount',
    key: 'orderCount',
    width: 140,
    align: 'right',
  },
];

const createdMonthColumns: ColumnsType<CreatedMonthCountRow> = [
  {
    title: 'Месяц',
    dataIndex: 'month',
    key: 'month',
  },
  {
    title: 'Количество',
    dataIndex: 'orderCount',
    key: 'orderCount',
    width: 140,
    align: 'right',
  },
];

const linkedEntityColumns: ColumnsType<LinkedEntityCountRow> = [
  {
    title: 'Тип',
    dataIndex: 'entityType',
    key: 'entityType',
  },
  {
    title: 'Количество',
    dataIndex: 'currentCount',
    key: 'currentCount',
    width: 140,
    align: 'right',
  },
];

const participantColumns: ColumnsType<ParticipantSummaryRow> = [
  {
    title: 'Роль',
    dataIndex: 'roleLabel',
    key: 'roleLabel',
  },
  {
    title: 'Количество',
    dataIndex: 'participantCount',
    key: 'participantCount',
    width: 140,
    align: 'right',
  },
];

const deadlineStatusColumns: ColumnsType<DeadlineStatusCountRow> = [
  {
    title: 'Статус',
    dataIndex: 'deadlineStatus',
    key: 'deadlineStatus',
  },
  {
    title: 'Количество',
    dataIndex: 'deadlineCount',
    key: 'deadlineCount',
    width: 140,
    align: 'right',
  },
];

export const GroupDetailOverview: React.FC<GroupDetailOverviewProps> = ({
  overview,
  deadlineStatusCounts = null,
}) => {
  const { group, orders } = overview;
  const dateRange = [group.startsAt, group.endsAt].filter(Boolean).join(' - ') || '-';

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space direction="vertical" size={4}>
        <Title level={4} style={{ margin: 0 }}>
          {group.code} · {group.name}
        </Title>
        <Tag>{GROUP_STATUS_LABELS[group.status] ?? group.status}</Tag>
      </Space>

      <Descriptions size="small" bordered column={2}>
        <Descriptions.Item label="Код">{group.code}</Descriptions.Item>
        <Descriptions.Item label="Название">{group.name}</Descriptions.Item>
        <Descriptions.Item label="Статус">
          {GROUP_STATUS_LABELS[group.status] ?? group.status}
        </Descriptions.Item>
        <Descriptions.Item label="Даты">{dateRange}</Descriptions.Item>
        {group.description ? (
          <Descriptions.Item label="Описание" span={2}>
            {group.description}
          </Descriptions.Item>
        ) : null}
      </Descriptions>

      <Statistic title="Всего заказов" value={orders.totalCount} />

      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Text strong>Связанные сущности</Text>
        <Table
          rowKey="entityType"
          size="small"
          columns={linkedEntityColumns}
          dataSource={overview.linkedEntityCounts}
          pagination={false}
        />
      </Space>

      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Text strong>Участники</Text>
        <Table
          rowKey="roleCode"
          size="small"
          columns={participantColumns}
          dataSource={overview.participants.currentSummary}
          pagination={false}
        />
      </Space>

      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Text strong>По статусам</Text>
        <Table
          rowKey={(row) => String(row.statusId)}
          size="small"
          columns={statusColumns}
          dataSource={orders.statusCounts}
          pagination={false}
        />
      </Space>

      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Text strong>По связям</Text>
        <Table
          rowKey={(row) => `${row.relationType}-${String(row.isPrimary)}`}
          size="small"
          columns={relationColumns}
          dataSource={orders.relationCounts}
          pagination={false}
        />
      </Space>

      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Text strong>По месяцам создания</Text>
        <Table
          rowKey="month"
          size="small"
          columns={createdMonthColumns}
          dataSource={orders.createdMonthCounts}
          pagination={false}
        />
      </Space>

      {deadlineStatusCounts ? (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Text strong>Deadline status counts</Text>
          <Table
            rowKey="deadlineStatus"
            size="small"
            columns={deadlineStatusColumns}
            dataSource={deadlineStatusCounts.data}
            pagination={false}
          />
        </Space>
      ) : null}
    </Space>
  );
};
