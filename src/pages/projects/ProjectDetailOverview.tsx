import React from 'react';
import { Descriptions, Space, Statistic, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type {
  OrderProjectRelationType,
  ProjectOverviewResponse,
  ProjectStatus,
} from '../../api/types/projectApi.types';

const { Text, Title } = Typography;

const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  draft: 'Черновик',
  active: 'Активен',
  paused: 'Пауза',
  completed: 'Завершен',
  archived: 'Архив',
};

interface ProjectDetailOverviewProps {
  overview: ProjectOverviewResponse;
}

type StatusCountRow = ProjectOverviewResponse['orders']['statusCounts'][number];
type RelationCountRow = ProjectOverviewResponse['orders']['relationCounts'][number];
type CreatedMonthCountRow = ProjectOverviewResponse['orders']['createdMonthCounts'][number];

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

const relationLabels: Record<OrderProjectRelationType, string> = {
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
    render: (relationType: OrderProjectRelationType) => relationLabels[relationType] ?? relationType,
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

export const ProjectDetailOverview: React.FC<ProjectDetailOverviewProps> = ({ overview }) => {
  const { project, orders } = overview;
  const dateRange = [project.startsAt, project.endsAt].filter(Boolean).join(' - ') || '-';

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space direction="vertical" size={4}>
        <Title level={4} style={{ margin: 0 }}>
          {project.code} · {project.name}
        </Title>
        <Tag>{PROJECT_STATUS_LABELS[project.status] ?? project.status}</Tag>
      </Space>

      <Descriptions size="small" bordered column={2}>
        <Descriptions.Item label="Код">{project.code}</Descriptions.Item>
        <Descriptions.Item label="Название">{project.name}</Descriptions.Item>
        <Descriptions.Item label="Статус">
          {PROJECT_STATUS_LABELS[project.status] ?? project.status}
        </Descriptions.Item>
        <Descriptions.Item label="Даты">{dateRange}</Descriptions.Item>
        {project.description ? (
          <Descriptions.Item label="Описание" span={2}>
            {project.description}
          </Descriptions.Item>
        ) : null}
      </Descriptions>

      <Statistic title="Всего заказов" value={orders.totalCount} />

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
    </Space>
  );
};
