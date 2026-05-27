import React from 'react';
import { Table, Tag } from 'antd';
import type { EntityProjectLink } from '../../../../api/types/projectApi.types';

export const ProjectHistoryTable: React.FC<{ links: EntityProjectLink[] }> = ({ links }) => (
  <Table
    size="small"
    rowKey={(record) => `${record.id}:${record.relationType}:${record.validFrom}`}
    dataSource={links}
    pagination={false}
  >
    <Table.Column<EntityProjectLink> title="Проект" render={(_, record) => `${record.code} · ${record.name}`} />
    <Table.Column<EntityProjectLink> title="Тип" dataIndex="relationType" width={110} />
    <Table.Column<EntityProjectLink>
      title="Роль"
      width={110}
      render={(_, record) => record.isPrimary ? <Tag color="gold">Главный</Tag> : <Tag>Связанный</Tag>}
    />
    <Table.Column<EntityProjectLink> title="С" dataIndex="validFrom" width={190} />
  </Table>
);
