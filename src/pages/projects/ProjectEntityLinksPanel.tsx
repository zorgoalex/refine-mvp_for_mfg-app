import React, { useMemo } from 'react';
import { Button, Form, Input, Select, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { PermissionName } from '../../api/types/authApi.types';
import type {
  ProjectEntityLinkDto,
  ProjectEntityLinksResponse,
  ProjectEntityTypeCode,
  ReplaceProjectEntityLink,
} from '../../api/types/projectApi.types';
import { featureFlags } from '../../config/featureFlags';
import { can, type PermissionCarrier } from '../../utils/permissions';

const PROJECT_ENTITY_TYPE_OPTIONS: Array<{ label: string; value: ProjectEntityTypeCode }> = [
  { label: 'order', value: 'order' },
  { label: 'user', value: 'user' },
  { label: 'employee', value: 'employee' },
  { label: 'client', value: 'client' },
  { label: 'workshop', value: 'workshop' },
  { label: 'deadline_instance', value: 'deadline_instance' },
];

const PROJECT_ENTITY_REQUIRED_PERMISSIONS: Record<ProjectEntityTypeCode, PermissionName> = {
  order: 'orders.view',
  user: 'users.view',
  employee: 'employees.view',
  client: 'clients.view',
  workshop: 'workshops.view',
  deadline_instance: 'deadlines.view',
};

interface ProjectEntityLinksFormValues {
  entityType: ProjectEntityTypeCode;
  entityId: string;
  relationType?: string;
}

interface ProjectEntityLinksPanelProps {
  response: ProjectEntityLinksResponse | null;
  currentUser: PermissionCarrier | null;
  loading?: boolean;
  canManage?: boolean;
  onAppend: (link: ReplaceProjectEntityLink) => void;
}

export const ProjectEntityLinksPanel: React.FC<ProjectEntityLinksPanelProps> = ({
  response,
  currentUser,
  loading = false,
  canManage = false,
  onAppend,
}) => {
  const [form] = Form.useForm<ProjectEntityLinksFormValues>();
  const entityTypeOptions = useMemo(
    () => PROJECT_ENTITY_TYPE_OPTIONS.filter((option) => canViewEntityType(option.value, currentUser)),
    [currentUser],
  );
  const rows = useMemo(
    () => (response?.links ?? []).filter((link) => canViewEntityType(link.entityType, currentUser)),
    [currentUser, response?.links],
  );

  const columns: ColumnsType<ProjectEntityLinkDto> = [
    { title: 'Тип', dataIndex: 'entityType', key: 'entityType', width: 160 },
    {
      title: 'Сущность',
      key: 'entity',
      render: (_, row) => row.displayLabel || `${row.entityType} #${row.entityId}`,
    },
    { title: 'Связь', dataIndex: 'relationType', key: 'relationType', width: 140 },
  ];

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Typography.Text strong>Связанные сущности</Typography.Text>
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={false}
      />
      {canManage ? (
        <Form
          form={form}
          layout="inline"
          onFinish={(values) => {
            onAppend(mapLinkForm(values));
            form.resetFields();
          }}
        >
          <Form.Item name="entityType" rules={[{ required: true }]}>
            <Select options={entityTypeOptions} style={{ width: 180 }} />
          </Form.Item>
          <Form.Item name="entityId" rules={[{ required: true, pattern: /^[1-9]\d*$|^[0-9a-f-]{36}$/i }]}>
            <Input placeholder="ID" style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="relationType" initialValue="related">
            <Input style={{ width: 140 }} />
          </Form.Item>
          <Form.Item>
            <Button htmlType="submit">Добавить связь</Button>
          </Form.Item>
        </Form>
      ) : null}
    </Space>
  );
};

function mapLinkForm(values: ProjectEntityLinksFormValues): ReplaceProjectEntityLink {
  return {
    entityType: values.entityType,
    entityId: values.entityId.trim(),
    relationType: values.relationType?.trim() || 'related',
    metadata: {},
  };
}

function canViewEntityType(entityType: ProjectEntityTypeCode, user: PermissionCarrier | null): boolean {
  return !featureFlags.useBackendPermissions || can(PROJECT_ENTITY_REQUIRED_PERMISSIONS[entityType], user);
}
