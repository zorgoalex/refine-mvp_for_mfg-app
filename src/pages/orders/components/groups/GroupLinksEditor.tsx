import React, { useEffect, useMemo, useState } from 'react';
import { Button, Modal, Space, Tag, Typography, Form, message } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { groupsApi } from '../../../../api/groupsApi';
import type { EntityGroupLink } from '../../../../api/types/groupApi.types';
import { featureFlags } from '../../../../config/featureFlags';
import { can } from '../../../../utils/permissions';
import { GroupSelect } from './GroupSelect';
import { GroupHistoryTable } from './GroupHistoryTable';
import {
  OrderLifecycleReadSurface,
  useOrderAsyncReadGuard,
} from '../../../../query/orderLifecycleQueries';

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
  const readGuard = useOrderAsyncReadGuard(`order-groups:${orderId}`);
  const readScopeKey = `${readGuard.authNamespace}|order:${orderId}`;
  const [groupState, setGroupState] = useState<{
    scopeKey: string;
    groups: EntityGroupLink[];
    version: number;
  } | null>(() => ({ scopeKey: readScopeKey, groups: initialGroups, version }));
  const groups = groupState?.scopeKey === readScopeKey ? groupState.groups : [];
  const linkVersion = groupState?.scopeKey === readScopeKey ? groupState.version : 0;
  const [openState, setOpenState] = useState<{
    scopeKey: string;
    value: boolean;
  } | null>(null);
  const open = openState?.scopeKey === readScopeKey && openState.value;
  const [savingState, setSavingState] = useState<{
    scopeKey: string;
    value: boolean;
  } | null>(null);
  const saving = savingState?.scopeKey === readScopeKey && savingState.value;
  const [form] = Form.useForm<{ groupIds: string[]; primaryGroupId?: string | null }>();
  const canManage = featureFlags.useBackendGroups && can('groups.manage_links');

  useEffect(() => {
    setGroupState({ scopeKey: readScopeKey, groups: initialGroups, version });
  }, [initialGroups, version]);

  useEffect(() => {
    if (!featureFlags.useBackendGroups || !orderId || !readGuard.active) return;
    const token = readGuard.capture();
    if (!token) return;
    void groupsApi.getOrderGroups(orderId).then((response) => {
      if (readGuard.isCurrent(token)) {
        setGroupState({
          scopeKey: readScopeKey,
          groups: response.groups,
          version: response.version,
        });
      }
    }).catch(() => undefined);
  }, [orderId, readGuard.active, readGuard.capture, readGuard.isCurrent, readScopeKey]);

  const primaryGroup = groups.find((group) => group.isPrimary) ?? null;
  const groupIds = useMemo(() => groups.map((group) => group.id), [groups]);

  const openEditor = () => {
    form.setFieldsValue({
      groupIds,
      primaryGroupId: primaryGroup?.id ?? null,
    });
    setOpenState({ scopeKey: readScopeKey, value: true });
  };

  const save = async () => {
    const values = await form.validateFields();
    const ids = values.groupIds ?? [];
    if (values.primaryGroupId && !ids.includes(values.primaryGroupId)) {
      message.error('Главная группа должна быть выбрана в списке групп');
      return;
    }
    const writeToken = readGuard.capture();
    if (!writeToken) return;
    setSavingState({ scopeKey: readScopeKey, value: true });
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
      if (!readGuard.isSameResource(writeToken)) return;
      setGroupState({
        scopeKey: readScopeKey,
        groups: response.groups,
        version: response.version,
      });
      setOpenState({ scopeKey: readScopeKey, value: false });
      message.success('Группы заказа обновлены');
    } catch (error) {
      if (readGuard.isSameResource(writeToken)) {
        message.error(error instanceof Error ? error.message : 'Не удалось сохранить группы заказа');
      }
    } finally {
      if (readGuard.isSameResource(writeToken)) {
        setSavingState({ scopeKey: readScopeKey, value: false });
      }
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

      <OrderLifecycleReadSurface active={open}>
        <Modal
          title="Группы заказа"
          open={open}
          onCancel={() => setOpenState({ scopeKey: readScopeKey, value: false })}
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
      </OrderLifecycleReadSurface>
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
