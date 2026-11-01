import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Form, Input, InputNumber, Modal, Space, Switch, Tag, Typography, message } from 'antd';
import { Table } from '../../../ui/tooltipDelay';
import { orderReworkApi, type OrderReworkReasonCatalogItem } from '../../../api/orderReworkApi';

const { Text } = Typography;

const errorText = (error: unknown) =>
  (error as { message?: string } | null)?.message ?? 'Не удалось сохранить причину';

/** /configuration → «Причины переделки»: reasons offered when an order goes back to production. */
export const ReworkReasonsConfigTab: React.FC = () => {
  const [items, setItems] = useState<OrderReworkReasonCatalogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<OrderReworkReasonCatalogItem | 'new' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems((await orderReworkApi.reasonCatalog()).data);
      setLoadError(null);
    } catch (error) {
      setLoadError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const toggleActive = async (item: OrderReworkReasonCatalogItem, isActive: boolean) => {
    try {
      await orderReworkApi.updateReason(item.reasonId, { expectedUpdatedAt: item.updatedAt, isActive });
      await load();
    } catch (error) {
      message.error(errorText(error));
      await load();
    }
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Text type="secondary">
        Причины выбираются при возврате заказа или деталей в переделку. Системная причина «Уточнить» не редактируется;
        неиспользуемую причину можно отключить — уже начатые круги сохранят её.
      </Text>
      {loadError ? <Alert type="error" showIcon message={loadError} /> : null}
      <Button type="primary" onClick={() => setEditing('new')}>Добавить причину</Button>
      <Table
        size="small"
        rowKey="reasonId"
        loading={loading}
        pagination={false}
        dataSource={items}
        columns={[
          { title: 'Название', dataIndex: 'name', render: (name: string, item) => (
            <Space>{name}{item.isSystem ? <Tag>системная</Tag> : null}</Space>
          ) },
          { title: 'Комментарий', dataIndex: 'requiresComment', width: 140, render: (value: boolean) => (value ? 'обязателен' : '—') },
          { title: 'Порядок', dataIndex: 'sortOrder', width: 90 },
          { title: 'Кругов', dataIndex: 'usedRounds', width: 80 },
          {
            title: 'Активна', dataIndex: 'isActive', width: 90,
            render: (value: boolean, item) => (
              <Switch size="small" checked={value} disabled={item.isSystem} onChange={(next) => void toggleActive(item, next)} />
            ),
          },
          {
            title: '', width: 110,
            render: (_: unknown, item) => (item.isSystem ? null : (
              <Button size="small" onClick={() => setEditing(item)}>Изменить</Button>
            )),
          },
        ]}
      />
      {editing ? (
        <ReasonEditModal
          item={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
        />
      ) : null}
    </Space>
  );
};

const ReasonEditModal: React.FC<{
  item: OrderReworkReasonCatalogItem | null;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}> = ({ item, onCancel, onSaved }) => {
  const [name, setName] = useState(item?.name ?? '');
  const [requiresComment, setRequiresComment] = useState(item?.requiresComment ?? false);
  const [sortOrder, setSortOrder] = useState<number>(item?.sortOrder ?? 100);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      if (item) {
        await orderReworkApi.updateReason(item.reasonId, { expectedUpdatedAt: item.updatedAt, name: name.trim(), requiresComment, sortOrder });
      } else {
        await orderReworkApi.createReason({ name: name.trim(), requiresComment, sortOrder });
      }
      message.success('Причина сохранена');
      await onSaved();
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      title={item ? 'Изменить причину переделки' : 'Новая причина переделки'}
      okText="Сохранить"
      cancelText="Отмена"
      confirmLoading={saving}
      okButtonProps={{ disabled: name.trim() === '' }}
      onCancel={onCancel}
      onOk={() => void save()}
    >
      <Form layout="vertical">
        <Form.Item label="Название" required>
          <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </Form.Item>
        <Form.Item>
          <Checkbox checked={requiresComment} onChange={(e) => setRequiresComment(e.target.checked)}>
            Комментарий обязателен
          </Checkbox>
        </Form.Item>
        <Form.Item label="Порядок в списке">
          <InputNumber min={0} max={100000} value={sortOrder} onChange={(value) => setSortOrder(Number(value ?? 0))} />
        </Form.Item>
      </Form>
    </Modal>
  );
};
