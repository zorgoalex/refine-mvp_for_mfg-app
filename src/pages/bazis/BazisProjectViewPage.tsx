import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Col, Descriptions, Empty, Row, Select, Space, Spin, Tabs, Typography } from 'antd';
import type { BazisProjectCard } from '../../api/types/bazisApi.types';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { bazisApi } from '../../api/bazisApi';
import { useTabStore } from '../../stores/tabStore';
import { can } from '../../utils/permissions';
import { EstimateTab } from './EstimateTab';
import { HardwareTab } from './HardwareTab';
import { MaterialsSummaryTab } from './MaterialsSummaryTab';
import { NodeCard } from './NodeCard';
import { OperationsTab } from './OperationsTab';
import { PanelsTab } from './PanelsTab';
import { NodeSearch } from './NodeSearch';
import { RevisionOrdersTab } from './RevisionOrdersTab';
import { buildSubtreeSummaries, useRevisionData } from './useRevisionData';
import { ViewerTree, type ViewerTreeHandle } from './ViewerTree';

const { Title, Text } = Typography;

export const BazisProjectViewPage: React.FC = () => {
  const { bazisProjectId: bazisProjectIdParam } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [projectCard, setProjectCard] = useState<BazisProjectCard | null>(null);
  const setTabTitle = useTabStore((state) => state.setTabTitle);

  useEffect(() => {
    if (projectCard?.name) {
      // Название базис-проекта в заголовок workspace-вкладки
      setTabTitle(`/bazis/projects/${projectCard.bazisProjectId}`, projectCard.name);
    }
  }, [projectCard, setTabTitle]);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  const [treeHeight] = useState(() => Math.max(400, window.innerHeight - 360));
  const viewerTreeRef = useRef<ViewerTreeHandle>(null);
  const [activeTab, setActiveTab] = useState('panels');
  const [selectedPanelId, setSelectedPanelId] = useState<number | null>(null);
  const canManage = can('bazis.manage');
  // Счётчик внешних переходов «к панели»: PanelsTab по нему форсирует
  // авто-раскрытие группы даже при повторном переходе на ту же панель
  const [panelFocusToken, setPanelFocusToken] = useState(0);
  const [pendingTreeNodeId, setPendingTreeNodeId] = useState<number | null>(null);

  const bazisProjectId = Number(bazisProjectIdParam);
  const revisionParam = searchParams.get('revision');

  useEffect(() => {
    if (!can('bazis.view')) {
      return;
    }

    if (!Number.isFinite(bazisProjectId) || bazisProjectId <= 0) {
      return;
    }

    let cancelled = false;

    const loadProjectCard = async () => {
      setLoading(true);
      setErrorText(null);
      setProjectCard(null);
      try {
        const response = await bazisApi.getProject(bazisProjectId);
        if (!cancelled) {
          setProjectCard(response);
        }
      } catch (error) {
        if (!cancelled) {
          setErrorText(error instanceof Error ? error.message : 'Не удалось загрузить Базис-проект');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadProjectCard();

    return () => {
      cancelled = true;
    };
  }, [bazisProjectId]);

  const selectedRevision = useMemo(() => {
    if (!projectCard || projectCard.revisions.length === 0) {
      return null;
    }

    if (revisionParam != null) {
      const revisionId = Number(revisionParam);
      if (Number.isFinite(revisionId)) {
        const matchedRevision = projectCard.revisions.find((revision) => revision.bazisRevisionId === revisionId);
        if (matchedRevision) {
          return matchedRevision;
        }
      }
    }

    return projectCard.revisions[0];
  }, [projectCard, revisionParam]);

  const selectedRevisionId = selectedRevision?.bazisRevisionId ?? null;

  useEffect(() => {
    if (!selectedRevision) {
      return;
    }

    const nextRevisionValue = String(selectedRevision.bazisRevisionId);
    if (revisionParam === nextRevisionValue) {
      return;
    }

    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.set('revision', nextRevisionValue);
    setSearchParams(nextSearchParams, { replace: true });
  }, [revisionParam, searchParams, selectedRevision, setSearchParams]);

  useEffect(() => {
    setSelectedNodeId(null);
    setSelectedPanelId(null);
    setPendingTreeNodeId(null);
    setActiveTab('panels');
  }, [selectedRevisionId]);

  const revisionData = useRevisionData(selectedRevisionId ?? 0);

  // «Показать в дереве» из любых вкладок: переключаем вкладку и, когда
  // ViewerTree смонтирован (ref может появиться на следующих кадрах),
  // раскрываем путь к узлу.
  useEffect(() => {
    if (activeTab !== 'tree' || pendingTreeNodeId == null) {
      return;
    }

    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      const handle = viewerTreeRef.current;
      if (handle) {
        window.clearInterval(timer);
        const path = revisionData
          .ancestorsOf(pendingTreeNodeId)
          .map((ancestor) => ancestor.bazisNodeId)
          .reverse(); // root-first для revealNode
        void handle.revealNode(path, pendingTreeNodeId);
        setPendingTreeNodeId(null);
      } else if (attempts > 30) {
        window.clearInterval(timer);
        setPendingTreeNodeId(null);
      }
    }, 100);

    return () => window.clearInterval(timer);
  }, [activeTab, pendingTreeNodeId, revisionData]);

  const subtreeSummaries = useMemo(
    () => buildSubtreeSummaries(revisionData.nodes, revisionData.estimate),
    [revisionData.estimate, revisionData.nodes],
  );

  // Бейджи-счётчики: со 2-го уровня (корень-изделие без них)
  const getNodeSummary = (nodeId: number) => {
    const node = revisionData.byId.get(nodeId);
    if (!node || node.parentNodeId == null) {
      return null;
    }
    return subtreeSummaries.get(nodeId) ?? null;
  };

  const goToTree = (nodeId: number) => {
    setPendingTreeNodeId(nodeId);
    setActiveTab('tree');
  };

  const goToPanel = (panelNodeId: number) => {
    setSelectedPanelId(panelNodeId);
    setPanelFocusToken((token) => token + 1);
    setActiveTab('panels');
  };

  if (!can('bazis.view')) {
    return <Alert type="error" message="Недостаточно прав" showIcon />;
  }

  if (!Number.isFinite(bazisProjectId) || bazisProjectId <= 0) {
    return <Alert type="error" message="Некорректный идентификатор Базис-проекта" showIcon />;
  }

  if (loading) {
    return <Spin />;
  }

  if (errorText) {
    return <Alert type="warning" message={errorText} showIcon />;
  }

  if (!projectCard) {
    return <Spin />;
  }


  const handleRevisionChange = (nextRevisionId: number) => {
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.set('revision', String(nextRevisionId));
    setSearchParams(nextSearchParams, { replace: true });
    setSelectedNodeId(null);
  };

  const revisionOptions = projectCard.revisions.map((revision) => ({
    value: revision.bazisRevisionId,
    label: buildRevisionLabel(revision),
  }));

  return (
    <Card
      title={(
        <Space direction="vertical" size={4}>
          <Space align="center" size={12}>
            <Link to="/bazis">
              <Button size="small" icon={<ArrowLeftOutlined />}>К списку</Button>
            </Link>
            <Title level={3} style={{ margin: 0 }}>
              {projectCard.name}
            </Title>
          </Space>
          <Space size={12} wrap>
            <Link to={`/projects/show/${projectCard.projectId}`}>Проект ERP #{projectCard.projectId}</Link>
            {projectCard.bazisOrderNo?.trim() ? (
              <Text type="secondary">{`Заказ Базис: ${projectCard.bazisOrderNo.trim()}`}</Text>
            ) : null}
          </Space>
        </Space>
      )}
      extra={selectedRevision ? (
        <Space align="center" wrap>
          <Text strong>Ревизия</Text>
          <Select<number>
            style={{ minWidth: 320 }}
            value={selectedRevision.bazisRevisionId}
            options={revisionOptions}
            onChange={handleRevisionChange}
          />
        </Space>
      ) : null}
    >
      {projectCard.revisions.length === 0 || !selectedRevision ? (
        <Empty description="У проекта пока нет ревизий" />
      ) : (
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              key: 'panels',
              label: 'Панели',
              children: revisionData.errorText ? (
                <Alert type="warning" showIcon message={revisionData.errorText} />
              ) : revisionData.loading ? (
                <Spin />
              ) : (
                <PanelsTab
                  // remount при смене ревизии: сбрасывает expandedRowKeys —
                  // групповые ключи (материал+размеры) могут совпасть в другой ревизии
                  key={selectedRevision.bazisRevisionId}
                  revisionId={selectedRevision.bazisRevisionId}
                  data={revisionData}
                  bazisOrderNo={projectCard.bazisOrderNo}
                  canManage={canManage}
                  selectedId={selectedPanelId}
                  focusToken={panelFocusToken}
                  onSelect={setSelectedPanelId}
                  onGoToTree={goToTree}
                />
              ),
            },
            {
              key: 'hardware',
              label: 'Фурнитура',
              children: revisionData.loading ? <Spin /> : (
                <HardwareTab data={revisionData} onGoToTree={goToTree} onGoToPanel={goToPanel} />
              ),
            },
            {
              key: 'operations',
              label: 'Операции',
              children: revisionData.loading ? <Spin /> : (
                <OperationsTab data={revisionData} onGoToTree={goToTree} onGoToPanel={goToPanel} />
              ),
            },
            {
              key: 'estimate',
              label: 'Смета',
              children: revisionData.loading ? <Spin /> : (
                <EstimateTab data={revisionData} onGoToTree={goToTree} onGoToPanel={goToPanel} />
              ),
            },
            {
              key: 'tree',
              label: 'Дерево',
              children: (
                <Space direction="vertical" size="large" style={{ width: '100%' }}>
                  <Descriptions bordered size="small" column={6}>
                    <Descriptions.Item label="Всего узлов">{selectedRevision.summary.totalNodes ?? '—'}</Descriptions.Item>
                    <Descriptions.Item label="Панели">{selectedRevision.summary.panels ?? '—'}</Descriptions.Item>
                    <Descriptions.Item label="Фурнитура">{selectedRevision.summary.hardware ?? '—'}</Descriptions.Item>
                    <Descriptions.Item label="Сборки">{selectedRevision.summary.assemblies ?? '—'}</Descriptions.Item>
                    <Descriptions.Item label="Блоки">{selectedRevision.summary.blocks ?? '—'}</Descriptions.Item>
                    <Descriptions.Item label="Уникальных материалов">{selectedRevision.summary.uniqueMaterials ?? '—'}</Descriptions.Item>
                  </Descriptions>
                  <NodeSearch
                    // key заставляет пересоздать компонент при смене ревизии — гарантированно сбрасывает
                    // внутреннее состояние поиска, не полагаясь только на internal useEffect
                    key={selectedRevision.bazisRevisionId}
                    revisionId={selectedRevision.bazisRevisionId}
                    onPick={(item) => (
                      viewerTreeRef.current?.revealNode(item.pathNodeIds, item.bazisNodeId) ?? Promise.resolve()
                    )}
                  />
                  <Row gutter={[16, 16]}>
                    <Col span={14} xs={24} lg={14}>
                      <ViewerTree
                        ref={viewerTreeRef}
                        revisionId={selectedRevision.bazisRevisionId}
                        height={treeHeight}
                        selectedNodeId={selectedNodeId}
                        onSelectNode={setSelectedNodeId}
                        getNodeSummary={getNodeSummary}
                      />
                    </Col>
                    <Col span={10} xs={24} lg={10}>
                      <NodeCard nodeId={selectedNodeId} />
                    </Col>
                  </Row>
                </Space>
              ),
            },
            {
              key: 'materials',
              label: 'Материалы',
              children: (
                <MaterialsSummaryTab
                  revisionId={selectedRevision.bazisRevisionId}
                  canManage={canManage}
                />
              ),
            },
            {
              key: 'orders',
              label: 'Заказы',
              children: <RevisionOrdersTab revisionId={selectedRevision.bazisRevisionId} />,
            },
          ]}
        />
      )}
    </Card>
  );
};

function buildRevisionLabel(revision: BazisProjectCard['revisions'][number]): string {
  const parts = [`Ревизия #${revision.revisionNo}`];

  if (revision.productName) {
    parts.push(revision.productName);
  }

  parts.push(formatRevisionDate(revision.importedAt));
  return parts.join(' · ');
}

function formatRevisionDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
  }).format(date);
}
