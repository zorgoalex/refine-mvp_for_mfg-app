import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Drawer, Empty, Space, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Link, useNavigate } from 'react-router-dom';
import { bazisApi } from '../../api/bazisApi';
import type { BazisProjectCard, BazisProjectListItem } from '../../api/types/bazisApi.types';
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
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [expandedProjectIds, setExpandedProjectIds] = useState<number[]>([]);
  const [projectCards, setProjectCards] = useState<Record<number, BazisProjectCard>>({});
  const [projectCardsLoading, setProjectCardsLoading] = useState<Record<number, boolean>>({});
  const [treeRevisionId, setTreeRevisionId] = useState<number | null>(null);
  const [treeRevisionLabel, setTreeRevisionLabel] = useState<string>('');
  const [checkedNodeIds, setCheckedNodeIds] = useState<number[]>([]);
  const [createOrderOpen, setCreateOrderOpen] = useState(false);
  const canManage = can('bazis.manage');

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

  const openRevisionTree = useCallback((revisionId: number, label: string) => {
    setTreeRevisionId(revisionId);
    setTreeRevisionLabel(label);
    setCheckedNodeIds([]);
  }, []);

  const makeRevisionColumns = useCallback(
    (bazisProjectId: number): ColumnsType<BazisProjectCard['revisions'][number]> => [
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
              <Button size="small" onClick={() => openRevisionTree(revision.bazisRevisionId, label)}>
                Открыть дерево
              </Button>
              <Button
                size="small"
                type="primary"
                disabled={!canManage}
                onClick={() => {
                  openRevisionTree(revision.bazisRevisionId, label);
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
        dataIndex: 'linkedOrderIds',
        key: 'linkedOrderIds',
        render: (value: number[]) => (
          value.length > 0 ? (
            <Space wrap>
              {value.map((orderId) => (
                <Link key={orderId} to={`/orders/show/${orderId}`}>
                  #{orderId}
                </Link>
              ))}
            </Space>
          ) : '—'
        ),
      },
    ],
    [],
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
            <Button type="primary" onClick={() => setImportOpen(true)} disabled={!canManage}>
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
                      columns={makeRevisionColumns(record.bazisProjectId)}
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
        onClose={() => setImportOpen(false)}
        onImported={() => {
          void loadProjects();
        }}
        onOpenTree={(revisionId, label) => {
          openRevisionTree(revisionId, label);
          setImportOpen(false);
        }}
        onCreateOrder={(revisionId, label) => {
          openRevisionTree(revisionId, label);
          setCreateOrderOpen(true);
          setImportOpen(false);
        }}
      />

      <Drawer
        open={treeRevisionId != null}
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
