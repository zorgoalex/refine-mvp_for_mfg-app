import React from 'react';
import { Table, Tag } from 'antd';
import type { EntityGroupLink } from '../../../../api/types/groupApi.types';

export const GroupHistoryTable: React.FC<{ links: EntityGroupLink[] }> = ({ links }) => (
  <Table
    size="small"
    rowKey={(record) => `${record.id}:${record.relationType}:${record.validFrom}`}
    dataSource={links}
    pagination={false}
  >
    <Table.Column<EntityGroupLink> title="Группа" render={(_, record) => `${record.code} · ${record.name}`} />
    <Table.Column<EntityGroupLink> title="Тип" dataIndex="relationType" width={110} />
    <Table.Column<EntityGroupLink>
      title="Роль"
      width={110}
      render={(_, record) => record.isPrimary ? <Tag color="gold">Главный</Tag> : <Tag>Связанный</Tag>}
    />
    <Table.Column<EntityGroupLink> title="С" dataIndex="validFrom" width={190} />
  </Table>
);
