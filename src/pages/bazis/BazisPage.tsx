import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Drawer, Empty, Popconfirm, Space, Table, Tag, Tooltip, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Link, useNavigate } from 'react-router-dom';
import { bazisApi } from '../../api/bazisApi';
import type { BazisProjectCard, BazisProjectListItem } from '../../api/types/bazisApi.types';
import { OrderDeletedTag, hasDeletedOrderReference, orderDeletedReferenceClassName } from '../../components/OrderDeletedTag';
import { useKeepAlive } from '../../components/workspace/KeepAliveContext';
import { PAGE_SIZE_OPTIONS, usePageSizePreference } from '../../hooks/usePageSizePreference';
import { useTabStore } from '../../stores/tabStore';
import { can } from '../../utils/permissions';
import { CreateOrderModal } from './CreateOrderModal';
import { ImportWizardModal } from './ImportWizardModal';
import { RevisionTree } from './RevisionTree';

const { Text, Title } = Typography;

interface ProjectRow extends BazisProjectListItem {
  key: number;
}

export const BazisPage: React.FC = () => {
  const navigate = useNavigate();
  const { pageSize, setPageSize } = usePageSizePreference('bazis:projects', 10);
  const [currentPage, setCurrentPage] = useState(1);
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importRestoreSignal, setImportRestoreSignal] = useState(0);
  const [expandedProjectIds, setExpandedProjectIds] = useState<number[]>([]);
  const [projectCards, setProjectCards] = useState<Record<number, BazisProjectCard>>({});
  const [projectCardsLoading, setProjectCardsLoading] = useState<Record<number, boolean>>({});
  const [treeRevisionId, setTreeRevisionId] = useState<number | null>(null);
  const [treeProjectId, setTreeProjectId] = useState<number | null>(null);
  const [treeRevisionLabel, setTreeRevisionLabel] = useState<string>('');
  const [checkedNodeIds, setCheckedNodeIds] = useState<number[]>([]);
  const [createOrderOpen, setCreateOrderOpen] = useState(false);
  const canManage = can('bazis.manage');
  const { isActive: isTabActive } = useKeepAlive();
  const setTabDirty = useTabStore((state) => state.setDirty);

  // Открытая модалка/дерево = незавершённая работа: помечаем вкладку dirty,
  // чтобы keep-alive не размонтировал страницу при навигации (иначе state
  // визарда/выбора узлов пропадёт).
  useEffect(() => {
    const hasPendingWork = importOpen || createOrderOpen || treeRevisionId != null;
    setTabDirty('/bazis', hasPendingWork);
    return () => setTabDirty('/bazis', false);
  }, [createOrderOpen, importOpen, setTabDirty, treeRevisionId]);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setErrorText(null);
    try {
      const response = await bazisApi.listProjects();
      setRows(response.map((item) => ({ ...item, key: item.bazisProjectId })));
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Не удалось загрузить Базис-проекты';
      setErrorText(text);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const ensureProjectCard = useCallback(async (bazisProjectId: number) => {
    if (projectCards[bazisProjectId] || projectCardsLoading[bazisProjectId]) {
      return;
    }

    setProjectCardsLoading((prev) => ({ ...prev, [bazisProjectId]: true }));
    try {
      const response = await bazisApi.getProject(bazisProjectId);
      setProjectCards((prev) => ({ ...prev, [bazisProjectId]: response }));
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось загрузить ревизии');
    } finally {
      setProjectCardsLoading((prev) => ({ ...prev, [bazisProjectId]: false }));
    }
  }, [projectCards, projectCardsLoading]);

  const [deletingProjectIds, setDeletingProjectIds] = useState<Record<number, boolean>>({});

  const handleDeleteProject = useCallback(async (bazisProjectId: number) => {
    setDeletingProjectIds((prev) => ({ ...prev, [bazisProjectId]: true }));
    try {
      const response = await bazisApi.deleteProject(bazisProjectId);
      message.success(`Базис-проект «${response.name}» удалён (ревизий: ${response.revisionsDeleted})`);
      setExpandedProjectIds((prev) => prev.filter((id) => id !== bazisProjectId));
      setProjectCards((prev) => {
        const next = { ...prev };
        delete next[bazisProjectId];
        return next;
      });
      await loadProjects();
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось удалить Базис-проект');
    } finally {
      setDeletingProjectIds((prev) => ({ ...prev, [bazisProjectId]: false }));
    }
  }, [loadProjects]);

  const openRevisionTree = useCallback((revisionId: number, label: string, projectId: number | null = null) => {
    setTreeRevisionId(revisionId);
    setTreeProjectId(projectId);
    setTreeRevisionLabel(label);
    setCheckedNodeIds([]);
  }, []);

  const makeRevisionColumns = useCallback(
    (bazisProjectId: number, projectId: number | null): ColumnsType<BazisProjectCard['revisions'][number]> => [
      {
        title: 'Ревизия',
        dataIndex: 'revisionNo',
        key: 'revisionNo',
        width: 110,
        render: (value: number) => <Tag color="blue">#{value}</Tag>,
      },
      {
        title: 'Файл',
        dataIndex: 'fileName',
        key: 'fileName',
        render: (value: string | null) => value || '—',
      },
      {
        title: 'Изделие',
        dataIndex: 'productName',
        key: 'productName',
        render: (value: string | null) => value || '—',
      },
      {
        title: 'Импорт',
        dataIndex: 'importedAt',
        key: 'importedAt',
        width: 180,
        render: (value: string) => formatDateTime(value),
      },
      {
        title: 'Действия',
        key: 'actions',
        width: 420,
        render: (_, revision) => {
          const label = `Ревизия ${revision.revisionNo}${revision.productName ? ` · ${revision.productName}` : ''}`;
          return (
            <Space wrap>
              <Button
                size="small"
                onClick={() => navigate(`/bazis/projects/${bazisProjectId}?revision=${revision.bazisRevisionId}`)}
              >
                Форма просмотра
              </Button>
              <Button size="small" onClick={() => openRevisionTree(revision.bazisRevisionId, label, projectId)}>
                Открыть дерево
              </Button>
              <Button
                size="small"
                type="primary"
                disabled={!canManage}
                onClick={() => {
                  openRevisionTree(revision.bazisRevisionId, label, projectId);
                  setCreateOrderOpen(true);
                }}
              >
                Создать заказ
              </Button>
            </Space>
          );
        },
      },
    ],
    [canManage, navigate, openRevisionTree],
  );

  const columns = useMemo<ColumnsType<ProjectRow>>(
    () => [
      {
        title: 'Название',
        dataIndex: 'name',
        key: 'name',
        render: (value: string, record) => <Link to={`/bazis/projects/${record.bazisProjectId}`}>{value}</Link>,
      },
      {
        title: 'Заказ Базис',
        dataIndex: 'bazisOrderNo',
        key: 'bazisOrderNo',
        width: 140,
        render: (value: string | null) => value?.trim() || '—',
      },
      {
        title: 'Проект ERP',
        dataIndex: 'projectId',
        key: 'projectId',
        width: 130,
        render: (value: number) => <Link to={`/projects/show/${value}`}>#{value}</Link>,
      },
      {
        title: 'Ревизий',
        dataIndex: 'revisionsCount',
        key: 'revisionsCount',
        width: 110,
      },
      {
        title: 'Последний импорт',
        dataIndex: 'lastImportedAt',
        key: 'lastImportedAt',
        width: 180,
        render: (value: string | null) => value ? formatDateTime(value) : '—',
      },
      {
        title: 'Заказы',
        key: 'linkedOrders',
        render: (_, record) => (
          record.linkedOrders.length > 0 ? (
            <Space wrap>
              {record.linkedOrders.map((order) => (
                <Space key={order.orderId} size={4} wrap>
                  <Link to={`/orders/show/${order.orderId}`}>
                    {order.orderName?.trim() || `#${order.orderId}`}
                  </Link>
                  <OrderDeletedTag deleted={order.orderDeleted} />
                </Space>
              ))}
            </Space>
          ) : '—'
        ),
      },
      {
        title: 'ID заказа',
        dataIndex: 'linkedOrderIds',
        key: 'linkedOrderIds',
        width: 110,
        render: (value: number[], record) => (
          value.length > 0 ? (
            <Space wrap>
              {value.map((orderId) => (
                <Space key={orderId} size={4} wrap>
                  <Link to={`/orders/show/${orderId}`}>
                    #{orderId}
                  </Link>
                  <OrderDeletedTag deleted={record.linkedOrders.find((order) => order.orderId === orderId)?.orderDeleted} />
                </Space>
              ))}
            </Space>
          ) : '—'
        ),
      },
      {
        title: 'Действия',
        key: 'actions',
        width: 120,
        render: (_, record) => (
          <Tooltip
            title={
              !canManage
                ? 'Нужно право bazis.manage'
                : record.linkedOrderIds.length > 0
                  ? 'Из проекта созданы заказы — удаление запрещено'
                  : undefined
            }
          >
            <Popconfirm
              title="Удалить Базис-проект?"
              description={`«${record.name}» и все его ревизии будут удалены безвозвратно.`}
              okText="Удалить"
              okButtonProps={{ danger: true }}
              cancelText="Отмена"
              onConfirm={() => void handleDeleteProject(record.bazisProjectId)}
              disabled={!canManage || record.linkedOrderIds.length > 0}
            >
              <Button
                size="small"
                danger
                loading={Boolean(deletingProjectIds[record.bazisProjectId])}
                disabled={!canManage || record.linkedOrderIds.length > 0}
              >
                Удалить
              </Button>
            </Popconfirm>
          </Tooltip>
        ),
      },
    ],
    [canManage, deletingProjectIds, handleDeleteProject],
  );

  if (!can('bazis.view')) {
    return <Alert type="error" message="Недостаточно прав" showIcon />;
  }

  return (
    <>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Card
          title={<Title level={3} style={{ margin: 0 }}>Базис-проекты</Title>}
          extra={(
            <Button
              type="primary"
              onClick={() => {
                setImportOpen(true);
                // если визард свёрнут — разворачиваем вместо «ничего не произошло»
                setImportRestoreSignal((value) => value + 1);
              }}
              disabled={!canManage}
            >
              Импорт XML
            </Button>
          )}
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {errorText ? <Alert type="warning" message={errorText} showIcon /> : null}
            <Table<ProjectRow>
              rowKey="bazisProjectId"
              columns={columns}
              dataSource={rows}
              loading={loading}
              rowClassName={(record) => orderDeletedReferenceClassName(hasDeletedOrderReference(record.linkedOrders))}
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
              locale={{ emptyText: errorText ? <Text type="secondary">Нет данных</Text> : <Empty description="Базис-проекты не найдены" /> }}
              expandable={{
                expandedRowKeys: expandedProjectIds,
                onExpand: (expanded, record) => {
                  const next = expanded
                    ? [...expandedProjectIds, record.bazisProjectId]
                    : expandedProjectIds.filter((id) => id !== record.bazisProjectId);
                  setExpandedProjectIds(next);
                  if (expanded) {
                    void ensureProjectCard(record.bazisProjectId);
                  }
                },
                expandedRowRender: (record) => {
                  const card = projectCards[record.bazisProjectId];
                  const cardLoading = projectCardsLoading[record.bazisProjectId];

                  if (!card && cardLoading) {
                    return <Text type="secondary">Загрузка ревизий...</Text>;
                  }

                  if (!card || card.revisions.length === 0) {
                    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Ревизий пока нет" />;
                  }

                  return (
                    <Table
                      rowKey="bazisRevisionId"
                      size="small"
                      pagination={false}
                      columns={makeRevisionColumns(record.bazisProjectId, record.projectId)}
                      dataSource={card.revisions}
                    />
                  );
                },
              }}
            />
          </Space>
        </Card>
      </Space>

      <ImportWizardModal
        open={importOpen}
        restoreSignal={importRestoreSignal}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          void loadProjects();
        }}
        onOpenTree={(revisionId, label, projectId) => {
          openRevisionTree(revisionId, label, projectId);
          setImportOpen(false);
        }}
      />

      <Drawer
        open={treeRevisionId != null && isTabActive}
        onClose={() => setTreeRevisionId(null)}
        width={720}
        title={treeRevisionLabel || 'Дерево ревизии'}
        extra={canManage ? (
          <Button type="primary" disabled={checkedNodeIds.length === 0} onClick={() => setCreateOrderOpen(true)}>
            Создать заказ
          </Button>
        ) : null}
      >
        {treeRevisionId != null ? (
          <RevisionTree
            revisionId={treeRevisionId}
            checkedKeys={checkedNodeIds}
            onCheckedKeysChange={setCheckedNodeIds}
          />
        ) : null}
      </Drawer>

      <CreateOrderModal
        open={createOrderOpen}
        revisionId={treeRevisionId}
        projectId={treeProjectId}
        selectedNodeIds={checkedNodeIds}
        onClose={() => setCreateOrderOpen(false)}
      />
    </>
  );
};

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}
