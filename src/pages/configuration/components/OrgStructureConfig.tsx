import { Table } from '../../../ui/tooltipDelay';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Drawer, Empty, Input, Modal, Select, Space, Switch, Tag, Typography, message } from 'antd';
import { ApartmentOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useGetIdentity } from '@refinedev/core';
import { ApiError } from '../../../api/apiError';
import {
  orgApi,
  type OrgAssignableUser,
  type OrgDirectionDetail,
  type OrgDirectionSummary,
  type OrgWorkCenterLookup,
  type OrgWorkshopLookup,
  type ReplaceIdSetPayload,
} from '../../../api/orgApi';
import { PAGE_SIZE_OPTIONS, usePageSizePreference } from '../../../hooks/usePageSizePreference';

const { Title, Text } = Typography;

interface OrgStructureConfigProps {
  /** Test/SSR seam: bypass useGetIdentity when provided. */
  initialPermissions?: string[];
}

function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `org-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function reportError(error: unknown, fallback: string): void {
  if (error instanceof ApiError) {
    message.error(error.message || fallback);
    return;
  }
  message.error(fallback);
}

export const OrgStructureConfig: React.FC<OrgStructureConfigProps> = ({ initialPermissions }) => {
  const { pageSize, setPageSize } = usePageSizePreference('configuration:org-directions', 10);
  const [currentPage, setCurrentPage] = useState(1);
  const { data: identity } = useGetIdentity<{ permissions?: string[] }>();
  const permissions = initialPermissions ?? identity?.permissions ?? [];
  const canManage = permissions.includes('org.manage');

  const [directions, setDirections] = useState<OrgDirectionSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const [workshops, setWorkshops] = useState<OrgWorkshopLookup[]>([]);
  const [workCenters, setWorkCenters] = useState<OrgWorkCenterLookup[]>([]);
  const [users, setUsers] = useState<OrgAssignableUser[]>([]);

  const [detail, setDetail] = useState<OrgDirectionDetail | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [savingDetail, setSavingDetail] = useState(false);

  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editActive, setEditActive] = useState(true);
  const [selectedWorkshops, setSelectedWorkshops] = useState<number[]>([]);
  const [selectedWorkCenters, setSelectedWorkCenters] = useState<number[]>([]);
  const [selectedHeads, setSelectedHeads] = useState<number[]>([]);

  const [workshopForHeads, setWorkshopForHeads] = useState<number | undefined>(undefined);
  const [workshopHeads, setWorkshopHeads] = useState<number[]>([]);
  const [savingWorkshopHeads, setSavingWorkshopHeads] = useState(false);

  const loadDirections = useCallback(async () => {
    setLoading(true);
    try {
      const res = await orgApi.listDirections();
      setDirections(res.directions);
    } catch (error) {
      reportError(error, 'Не удалось загрузить направления');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLookups = useCallback(async () => {
    try {
      const [w, wc, u] = await Promise.all([
        orgApi.getWorkshops(),
        orgApi.getWorkCenters(),
        orgApi.getAssignableUsers(),
      ]);
      setWorkshops(w.workshops);
      setWorkCenters(wc.workCenters);
      setUsers(u.users);
    } catch (error) {
      reportError(error, 'Не удалось загрузить справочники');
    }
  }, []);

  useEffect(() => {
    void loadDirections();
    void loadLookups();
  }, [loadDirections, loadLookups]);

  const userOptions = useMemo(
    () => users.map((u) => ({ value: u.userId, label: u.displayName ?? `#${u.userId}` })),
    [users],
  );
  const workshopOptions = useMemo(
    () => workshops.map((w) => ({ value: w.workshopId, label: w.name })),
    [workshops],
  );
  const workCenterOptions = useMemo(
    () => workCenters.map((wc) => ({ value: wc.workcenterId, label: wc.name })),
    [workCenters],
  );

  const openDetail = useCallback(async (directionId: number) => {
    try {
      const d = await orgApi.getDirection(directionId);
      setDetail(d);
      setEditName(d.directionName);
      setEditDescription(d.description ?? '');
      setEditActive(d.isActive);
      setSelectedWorkshops(d.workshops.map((w) => w.workshopId));
      setSelectedWorkCenters(d.workCenters.map((w) => w.workcenterId));
      setSelectedHeads(d.heads.map((h) => h.userId));
      setDrawerOpen(true);
    } catch (error) {
      reportError(error, 'Не удалось открыть направление');
    }
  }, []);

  const handleCreate = useCallback(async () => {
    const name = (await promptName()) ?? '';
    if (!name.trim()) return;
    try {
      const created = await orgApi.createDirection({ name: name.trim() });
      message.success('Направление создано');
      await loadDirections();
      void openDetail(created.directionId);
    } catch (error) {
      reportError(error, 'Не удалось создать направление');
    }
  }, [loadDirections, openDetail]);

  const handleSaveDetail = useCallback(async () => {
    if (!detail) return;
    setSavingDetail(true);
    try {
      await orgApi.updateDirection(detail.directionId, {
        name: editName.trim(),
        description: editDescription.trim() || null,
        isActive: editActive,
      });
      await orgApi.replaceDirectionWorkshops(detail.directionId, idSet(selectedWorkshops));
      await orgApi.replaceDirectionWorkCenters(detail.directionId, idSet(selectedWorkCenters));
      await orgApi.replaceDirectionHeads(detail.directionId, idSet(selectedHeads));
      message.success('Направление сохранено');
      setDrawerOpen(false);
      await loadDirections();
    } catch (error) {
      reportError(error, 'Не удалось сохранить направление');
    } finally {
      setSavingDetail(false);
    }
  }, [detail, editName, editDescription, editActive, selectedWorkshops, selectedWorkCenters, selectedHeads, loadDirections]);

  const handleDelete = useCallback(
    (direction: OrgDirectionSummary) => {
      Modal.confirm({
        title: `Удалить направление «${direction.directionName}»?`,
        content: 'Действие необратимо. Связи с цехами/участками и руководители будут удалены.',
        okText: 'Удалить',
        okButtonProps: { danger: true },
        cancelText: 'Отмена',
        onOk: async () => {
          try {
            await orgApi.deleteDirection(direction.directionId);
            message.success('Направление удалено');
            await loadDirections();
          } catch (error) {
            reportError(error, 'Не удалось удалить направление');
          }
        },
      });
    },
    [loadDirections],
  );

  const loadWorkshopHeads = useCallback(async (workshopId: number) => {
    try {
      const heads = await orgApi.listWorkshopHeads(workshopId);
      setWorkshopHeads(heads.map((h) => h.userId));
    } catch (error) {
      reportError(error, 'Не удалось загрузить руководителей цеха');
    }
  }, []);

  const handleSaveWorkshopHeads = useCallback(async () => {
    if (workshopForHeads === undefined) return;
    setSavingWorkshopHeads(true);
    try {
      await orgApi.replaceWorkshopHeads(workshopForHeads, idSet(workshopHeads));
      message.success('Руководители цеха сохранены');
    } catch (error) {
      reportError(error, 'Не удалось сохранить руководителей цеха');
    } finally {
      setSavingWorkshopHeads(false);
    }
  }, [workshopForHeads, workshopHeads]);

  const columns = [
    { title: 'Направление', dataIndex: 'directionName', key: 'directionName' },
    {
      title: 'Статус',
      dataIndex: 'isActive',
      key: 'isActive',
      render: (active: boolean) => (active ? <Tag color="green">Активно</Tag> : <Tag>Архив</Tag>),
    },
    { title: 'Цехов', dataIndex: 'workshopCount', key: 'workshopCount' },
    { title: 'Участков', dataIndex: 'workCenterCount', key: 'workCenterCount' },
    { title: 'Руководителей', dataIndex: 'headCount', key: 'headCount' },
    ...(canManage
      ? [
          {
            title: 'Действия',
            key: 'actions',
            render: (_: unknown, row: OrgDirectionSummary) => (
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(row);
                }}
              >
                Удалить
              </Button>
            ),
          },
        ]
      : []),
  ];

  return (
    <div style={{ padding: '16px 0' }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Title level={5} style={{ margin: 0 }}>
            <ApartmentOutlined /> Направления
          </Title>
          {canManage && (
            <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
              Добавить направление
            </Button>
          )}
        </div>

        <Table<OrgDirectionSummary>
          rowKey="directionId"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={directions}
          pagination={{
            current: currentPage,
            pageSize,
            pageSizeOptions: PAGE_SIZE_OPTIONS,
            showSizeChanger: true,
            onChange: (nextPage, nextPageSize) => {
              if (nextPageSize !== pageSize) {
                setPageSize(nextPageSize);
                setCurrentPage(1);
                return;
              }
              setCurrentPage(nextPage);
            },
          }}
          locale={{ emptyText: <Empty description="Нет направлений" /> }}
          onRow={(row) => ({ onClick: () => openDetail(row.directionId), style: { cursor: 'pointer' } })}
        />

        <div>
          <Title level={5}>Руководители цехов</Title>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Select
              style={{ minWidth: 320 }}
              placeholder="Выберите цех"
              options={workshopOptions}
              value={workshopForHeads}
              onChange={(value: number) => {
                setWorkshopForHeads(value);
                void loadWorkshopHeads(value);
              }}
            />
            <Select
              mode="multiple"
              style={{ minWidth: 320, width: '100%' }}
              placeholder="Руководители (активные пользователи)"
              options={userOptions}
              value={workshopHeads}
              onChange={setWorkshopHeads}
              disabled={!canManage || workshopForHeads === undefined}
            />
            {canManage && (
              <Button
                type="primary"
                onClick={handleSaveWorkshopHeads}
                loading={savingWorkshopHeads}
                disabled={workshopForHeads === undefined}
              >
                Сохранить руководителей цеха
              </Button>
            )}
          </Space>
        </div>
      </Space>

      <Drawer
        title={detail ? `Направление: ${detail.directionName}` : 'Направление'}
        width={520}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        extra={
          canManage ? (
            <Button type="primary" onClick={handleSaveDetail} loading={savingDetail}>
              Сохранить
            </Button>
          ) : null
        }
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div>
            <Text strong>Название</Text>
            <Input value={editName} onChange={(e) => setEditName(e.target.value)} disabled={!canManage} maxLength={128} />
          </div>
          <div>
            <Text strong>Описание</Text>
            <Input.TextArea
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              disabled={!canManage}
              rows={2}
            />
          </div>
          <div>
            <Text strong style={{ marginRight: 8 }}>
              Активно
            </Text>
            <Switch checked={editActive} onChange={setEditActive} disabled={!canManage} />
          </div>
          <div>
            <Text strong>Цеха</Text>
            <Select
              mode="multiple"
              style={{ width: '100%' }}
              options={workshopOptions}
              value={selectedWorkshops}
              onChange={setSelectedWorkshops}
              disabled={!canManage}
            />
          </div>
          <div>
            <Text strong>Участки</Text>
            <Select
              mode="multiple"
              style={{ width: '100%' }}
              options={workCenterOptions}
              value={selectedWorkCenters}
              onChange={setSelectedWorkCenters}
              disabled={!canManage}
            />
          </div>
          <div>
            <Text strong>Руководители направления</Text>
            <Select
              mode="multiple"
              style={{ width: '100%' }}
              options={userOptions}
              value={selectedHeads}
              onChange={setSelectedHeads}
              disabled={!canManage}
            />
          </div>
        </Space>
      </Drawer>
    </div>
  );
};

function idSet(ids: number[]): ReplaceIdSetPayload {
  return { idempotencyKey: newIdempotencyKey(), ids };
}

async function promptName(): Promise<string | null> {
  return new Promise((resolve) => {
    let value = '';
    Modal.confirm({
      title: 'Новое направление',
      content: (
        <Input
          placeholder="Название направления"
          onChange={(e) => {
            value = e.target.value;
          }}
        />
      ),
      okText: 'Создать',
      cancelText: 'Отмена',
      onOk: () => resolve(value),
      onCancel: () => resolve(null),
    });
  });
}

export default OrgStructureConfig;
