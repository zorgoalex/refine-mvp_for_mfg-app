import React, { useEffect, useMemo, useState } from 'react';
import { Button, Modal, Space, Tag, Typography, Form, message } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { groupsApi } from '../../../../api/groupsApi';
import type { EntityGroupLink } from '../../../../api/types/groupApi.types';
import { featureFlags } from '../../../../config/featureFlags';
import { can } from '../../../../utils/permissions';
import { GroupSelect } from './GroupSelect';
import { GroupHistoryTable } from './GroupHistoryTable';

const { Text } = Typography;

interface GroupLinksEditorProps {
  orderId: number;
  version: number;
  initialGroups?: EntityGroupLink[];
}

export const GroupLinksEditor: React.FC<GroupLinksEditorProps> = ({
  orderId,
  version,
  initialGroups = [],
}) => {
  const [groups, setGroups] = useState<EntityGroupLink[]>(initialGroups);
  const [linkVersion, setLinkVersion] = useState(version);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<{ groupIds: string[]; primaryGroupId?: string | null }>();
  const canManage = featureFlags.useBackendGroups && can('groups.manage_links');

  useEffect(() => {
    setGroups(initialGroups);
  }, [initialGroups]);

  useEffect(() => {
    setLinkVersion(version);
  }, [version]);

  useEffect(() => {
    if (!featureFlags.useBackendGroups || !orderId) return;
    let cancelled = false;
    void groupsApi.getOrderGroups(orderId).then((response) => {
      if (!cancelled) {
        setGroups(response.groups);
        setLinkVersion(response.version);
      }
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  const primaryGroup = groups.find((group) => group.isPrimary) ?? null;
  const groupIds = useMemo(() => groups.map((group) => group.id), [groups]);

  const openEditor = () => {
    form.setFieldsValue({
      groupIds,
      primaryGroupId: primaryGroup?.id ?? null,
    });
    setOpen(true);
  };

  const save = async () => {
    const values = await form.validateFields();
    const ids = values.groupIds ?? [];
    if (values.primaryGroupId && !ids.includes(values.primaryGroupId)) {
      message.error('Главная группа должна быть выбрана в списке групп');
      return;
    }
    setSaving(true);
    try {
      const response = await groupsApi.replaceOrderGroups(orderId, {
        idempotencyKey: createIdempotencyKey(orderId),
        version: linkVersion,
        primaryGroupId: values.primaryGroupId ?? null,
        groups: ids.map((groupId) => {
          const existing = groups.find((group) => group.id === groupId);
          return {
            groupId,
            relationType: existing?.relationType ?? 'main',
            isPrimary: groupId === values.primaryGroupId,
          };
        }),
        reason: 'frontend-order-group-links-editor',
      });
      setGroups(response.groups);
      setLinkVersion(response.version);
      setOpen(false);
      message.success('Группы заказа обновлены');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ marginBottom: 8 }}>
      <Space wrap>
        <Text type="secondary">Группы:</Text>
        {groups.length === 0 ? (
          <Tag>Группа не указана</Tag>
        ) : groups.map((group) => (
          <Tag key={`${group.id}:${group.relationType}`} color={group.isPrimary ? 'gold' : undefined}>
            {group.code} · {group.name}
          </Tag>
        ))}
        {canManage && (
          <Button size="small" icon={<EditOutlined />} onClick={openEditor}>
            Изменить
          </Button>
        )}
      </Space>

      <Modal
        title="Группы заказа"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={save}
        confirmLoading={saving}
        okText="Сохранить"
        cancelText="Отмена"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="groupIds" label="Группы">
            <GroupSelect mode="multiple" selectedGroups={groups} />
          </Form.Item>
          <Form.Item name="primaryGroupId" label="Главная группа">
            <GroupSelect selectedGroups={groups} />
          </Form.Item>
        </Form>
        <GroupHistoryTable links={groups} />
      </Modal>
    </div>
  );
};

function createIdempotencyKey(orderId: number): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return `order-groups:${orderId}:${uuid}`;
}
