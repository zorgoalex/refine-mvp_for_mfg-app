import React from 'react';
import { Button, Form, Input, Select, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type {
  ProjectParticipantDto,
  ProjectParticipantRoleDto,
  ProjectParticipantsResponse,
  ProjectParticipantType,
  ReplaceProjectParticipant,
} from '../../api/types/groupApi.types';

const PARTICIPANT_TYPE_OPTIONS: Array<{ label: string; value: ProjectParticipantType }> = [
  { label: 'Пользователь', value: 'user' },
  { label: 'Сотрудник', value: 'employee' },
];

interface ProjectParticipantsFormValues {
  participantType: ProjectParticipantType;
  participantId: string;
  roleCode: string;
}

interface ProjectParticipantsPanelProps {
  response: ProjectParticipantsResponse | null;
  roles: ProjectParticipantRoleDto[];
  loading?: boolean;
  canManage?: boolean;
  onReplace: (participants: ReplaceProjectParticipant[]) => void;
}

export const ProjectParticipantsPanel: React.FC<ProjectParticipantsPanelProps> = ({
  response,
  roles,
  loading = false,
  canManage = false,
  onReplace,
}) => {
  const [form] = Form.useForm<ProjectParticipantsFormValues>();
  const canSubmitReplacement = canManage && response !== null && roles.length > 0;
  const columns: ColumnsType<ProjectParticipantDto> = [
    { title: 'Тип', dataIndex: 'participantType', key: 'participantType', width: 140 },
    {
      title: 'Участник',
      key: 'participant',
      render: (_, row) => row.displayName || `${row.participantType} #${row.participantId ?? ''}`,
    },
    { title: 'Роль', key: 'role', render: (_, row) => row.role.label || row.role.code, width: 180 },
  ];

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Typography.Text strong>Участники проекта</Typography.Text>
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={response?.participants ?? []}
        pagination={false}
      />
      {canSubmitReplacement ? (
        <Form
          form={form}
          layout="inline"
          onFinish={(values) => {
            onReplace(upsertParticipant(response?.participants ?? [], mapParticipantForm(values)));
            form.resetFields();
          }}
        >
          <Form.Item name="participantType" rules={[{ required: true }]}>
            <Select options={PARTICIPANT_TYPE_OPTIONS} style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="participantId" rules={[{ required: true, pattern: /^[1-9]\d*$/ }]}>
            <Input placeholder="ID" style={{ width: 140 }} />
          </Form.Item>
          <Form.Item name="roleCode" rules={[{ required: true }]}>
            <Select
              options={roles.map((role) => ({ label: role.label, value: role.code }))}
              style={{ width: 180 }}
            />
          </Form.Item>
          <Form.Item>
            <Button htmlType="submit">Сохранить участников</Button>
          </Form.Item>
        </Form>
      ) : null}
    </Space>
  );
};

export function upsertParticipant(
  existing: ProjectParticipantDto[],
  next: ReplaceProjectParticipant,
): ReplaceProjectParticipant[] {
  if (existing.some((participant) => participant.participantId === null)) {
    throw new Error('Cannot replace participants while a current participant id is unavailable');
  }

  const preserved = existing
    .filter((participant) => (
      participant.participantType !== next.participantType ||
      participant.participantId !== next.participantId
    ))
    .map((participant) => ({
      participantType: participant.participantType,
      participantId: participant.participantId,
      roleCode: participant.role.code,
      metadata: participant.metadata ?? {},
    }));

  return [...preserved, { ...next, metadata: next.metadata ?? {} }];
}

function mapParticipantForm(values: ProjectParticipantsFormValues): ReplaceProjectParticipant {
  return {
    participantType: values.participantType,
    participantId: values.participantId.trim(),
    roleCode: values.roleCode,
    metadata: {},
  };
}
