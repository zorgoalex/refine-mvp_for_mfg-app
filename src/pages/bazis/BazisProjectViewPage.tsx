import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftOutlined,
  CheckOutlined,
  CloseOutlined,
  DownloadOutlined,
  EditOutlined,
  HistoryOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { Alert, Button, Card, Col, Descriptions, Empty, Input, Row, Select, Space, Spin, Tabs, Tooltip, Typography, message } from 'antd';
import type { BazisProjectCard } from '../../api/types/bazisApi.types';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { bazisApi } from '../../api/bazisApi';
import { featureFlags } from '../../config/featureFlags';
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
import { saveBazisCutFile, type BazisCutSaveHandle } from '../bazis-cut/bazisCutSaveFile';
import {
  OperationalPageHeader,
  useOperationalUi,
} from '../../ui-operational/OperationalPrimitives';

const { Title, Text } = Typography;

export const BazisProjectViewPage: React.FC = () => {
  const isOperational = useOperationalUi();
  const { bazisProjectId: bazisProjectIdParam } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [projectCard, setProjectCard] = useState<BazisProjectCard | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameErrorText, setRenameErrorText] = useState<string | null>(null);
  const setTabTitle = useTabStore((state) => state.setTabTitle);

  useEffect(() => {
    if (projectCard?.name) {
      // Префикс отличает карточку Базис-проекта от заказа/проекта с тем же именем.
      setTabTitle(`/bazis/projects/${projectCard.bazisProjectId}`, `БП ${projectCard.name.trim()}`);
    }
  }, [projectCard, setTabTitle]);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  const [treeHeight] = useState(() => Math.max(400, window.innerHeight - 360));
  const viewerTreeRef = useRef<ViewerTreeHandle>(null);
  const [activeTab, setActiveTab] = useState('panels');
  const [selectedPanelId, setSelectedPanelId] = useState<number | null>(null);
  const [selectedPanelNodeIds, setSelectedPanelNodeIds] = useState<number[]>([]);
  const [exportingCutXls, setExportingCutXls] = useState(false);
  const canManage = can('bazis.manage');
  const canExportBazisCut = can('cut.view');
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
    setSelectedPanelNodeIds([]);
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

  const startRename = () => {
    if (!projectCard) return;
    setRenameDraft(projectCard.name);
    setRenameErrorText(null);
    setRenaming(true);
  };

  const cancelRename = () => {
    if (renameSaving) return;
    setRenameErrorText(null);
    setRenaming(false);
  };

  const saveProjectName = async () => {
    if (!projectCard || renameSaving) return;
    const name = renameDraft.trim();
    if (!name) {
      setRenameErrorText('Введите название Базис-проекта');
      return;
    }
    if (name === projectCard.name) {
      setRenaming(false);
      setRenameErrorText(null);
      return;
    }

    setRenameSaving(true);
    setRenameErrorText(null);
    try {
      const renamed = await bazisApi.renameProject(projectCard.bazisProjectId, name);
      setProjectCard((current) => current ? { ...current, name: renamed.name } : current);
      setRenaming(false);
      message.success('Название Базис-проекта обновлено');
    } catch (error) {
      setRenameErrorText(error instanceof Error ? error.message : 'Не удалось изменить название');
    } finally {
      setRenameSaving(false);
    }
  };

  const exportProjectSnapshot = () => {
    if (!projectCard) return;

    const blob = new Blob([JSON.stringify(projectCard, null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `bazis-project-${projectCard.bazisProjectId}.json`;
    anchor.click();
    URL.revokeObjectURL(href);
  };

  const exportSelectedPanelsXls = async (nodeIds: number[]) => {
    if (!selectedRevision || !projectCard || nodeIds.length === 0 || exportingCutXls) return;
    const picker = (window as PickerWindow).showSaveFilePicker;
    try {
      await saveBazisCutFile({
        suggestedName: directCutExportFileName(projectCard.name, selectedRevision.bazisRevisionId),
        picker: picker ? (options) => picker.call(window, options) : undefined,
        fetchFile: () => bazisApi.exportCutXls(selectedRevision.bazisRevisionId, nodeIds),
        fallbackDownload: downloadBlob,
        onGenerationStart: () => setExportingCutXls(true),
      });
      message.success('XLS для Базис-раскроя сформирован');
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        message.error(error instanceof Error ? error.message : 'Не удалось экспортировать XLS');
      }
    } finally {
      setExportingCutXls(false);
    }
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

  const projectTitle = (
    <Space direction="vertical" size={4}>
      <Space align="center" size={12}>
        {!isOperational ? (
          <Link to="/bazis">
            <Button size="small" icon={<ArrowLeftOutlined />}>К списку</Button>
          </Link>
        ) : null}
        {renaming ? (
          <Space.Compact>
            <Input
              autoFocus
              aria-label="Название Базис-проекта"
              value={renameDraft}
              maxLength={300}
              style={{ width: 'min(420px, 48vw)', height: 40 }}
              onChange={(event) => setRenameDraft(event.target.value)}
              onPressEnter={() => void saveProjectName()}
              onKeyDown={(event) => {
                if (event.key === 'Escape') cancelRename();
              }}
            />
            <Tooltip title="Сохранить">
              <Button
                aria-label="Сохранить название"
                icon={<CheckOutlined />}
                type="primary"
                loading={renameSaving}
                disabled={!renameDraft.trim()}
                style={{ minWidth: 40, height: 40 }}
                onClick={() => void saveProjectName()}
              />
            </Tooltip>
            <Tooltip title="Отмена">
              <Button
                aria-label="Отменить редактирование"
                icon={<CloseOutlined />}
                disabled={renameSaving}
                style={{ minWidth: 40, height: 40 }}
                onClick={cancelRename}
              />
            </Tooltip>
          </Space.Compact>
        ) : (
          <Space align="center" size={4}>
            <Title level={3} style={{ margin: 0 }}>
              {projectCard.name}
            </Title>
            {canManage ? (
              <Tooltip title="Изменить название">
                <Button
                  aria-label="Изменить название Базис-проекта"
                  type="text"
                  icon={<EditOutlined />}
                  style={{ width: 40, height: 40 }}
                  onClick={startRename}
                />
              </Tooltip>
            ) : null}
          </Space>
        )}
      </Space>
      {renameErrorText ? <Text type="danger">{renameErrorText}</Text> : null}
      <Space size={12} wrap>
        <Link to={`/projects/show/${projectCard.projectId}`}>
          {projectCard.projectName?.trim()
            ? `ERP-проект: ${projectCard.projectName.trim()} · #${projectCard.projectId}`
            : `ERP-проект #${projectCard.projectId}`}
        </Link>
        {projectCard.bazisOrderNo?.trim() ? (
          <Text type="secondary">{`Заказ Базис: ${projectCard.bazisOrderNo.trim()}`}</Text>
        ) : null}
      </Space>
    </Space>
  );
  const tabLabel = (label: string, count?: number | null) => isOperational ? (
    <span className="bazis-project-tab-label">
      <span>{label}</span>
      {count != null ? <small>{count}</small> : null}
    </span>
  ) : `${label}${count != null ? ` · ${count}` : ''}`;

  return (
    <div className="bazis-project-workspace">
      {isOperational ? (
        <OperationalPageHeader
          breadcrumbs={(
            <Space split={<span>›</span>} size={6}>
              <Link to="/orders">Заказы</Link>
              <Link to="/bazis">Базис-проекты</Link>
              <span>{projectCard.name}</span>
            </Space>
          )}
          title={`Базис-проект ${projectCard.name}`}
          description="Ревизия, панели и производственная готовность проекта в одном рабочем пространстве."
          actions={(
            <>
              <Button
                icon={<HistoryOutlined />}
                onClick={() => document.querySelector('.bazis-project-modern-card')?.scrollIntoView({ behavior: 'smooth' })}
              >
                Изменения
              </Button>
              {featureFlags.bazisCut ? (
                <Tooltip
                  title={!canExportBazisCut
                    ? 'Нужно право cut.view'
                    : selectedPanelNodeIds.length === 0
                      ? 'Выберите панели в списке'
                      : undefined}
                >
                  <span>
                    <Button
                      icon={<DownloadOutlined />}
                      loading={exportingCutXls}
                      disabled={!canExportBazisCut || selectedPanelNodeIds.length === 0}
                      onClick={() => void exportSelectedPanelsXls(selectedPanelNodeIds)}
                    >
                      Экспорт XLS
                    </Button>
                  </span>
                </Tooltip>
              ) : (
                <Button icon={<DownloadOutlined />} onClick={exportProjectSnapshot}>
                  Экспорт JSON
                </Button>
              )}
              <Button type="primary" icon={<PlusOutlined />} disabled>
                Создать заказ
              </Button>
            </>
          )}
        />
      ) : null}
      <Card
        className="bazis-project-modern-card"
        title={isOperational ? (
          <div className="bazis-project-workspace__revision-title">
            <Text className="bazis-project-workspace__eyebrow">Активная ревизия</Text>
            <Title level={2}>
              {projectCard.bazisOrderNo?.trim()
                ? `${projectCard.bazisOrderNo.trim()} · ${selectedRevision?.productName?.trim() || projectCard.name}`
                : selectedRevision?.productName?.trim() || projectCard.name}
            </Title>
            <Text type="secondary">
              {selectedRevision
                ? `Базис #${selectedRevision.bazisRevisionId} · обновлено ${formatRevisionDate(selectedRevision.importedAt)}`
                : 'Ревизия не выбрана'}
            </Text>
          </div>
        ) : projectTitle}
        extra={selectedRevision ? (
          <Space align="center" className="bazis-project-workspace__revision-select">
            <Text strong>Ревизия</Text>
            <Select<number>
              style={{ width: '100%', minWidth: 0 }}
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
                label: tabLabel('Панели', selectedRevision.summary.panels),
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
                    onSelectionChange={setSelectedPanelNodeIds}
                    onExportXls={featureFlags.bazisCut ? exportSelectedPanelsXls : undefined}
                    canExportXls={canExportBazisCut}
                    exportingXls={exportingCutXls}
                  />
                ),
              },
              {
                key: 'hardware',
                label: tabLabel('Фурнитура', selectedRevision.summary.hardware),
                children: revisionData.loading ? <Spin /> : (
                  <HardwareTab data={revisionData} onGoToTree={goToTree} onGoToPanel={goToPanel} />
                ),
              },
              {
                key: 'operations',
                label: tabLabel('Операции'),
                children: revisionData.loading ? <Spin /> : (
                  <OperationsTab data={revisionData} onGoToTree={goToTree} onGoToPanel={goToPanel} />
                ),
              },
              {
                key: 'estimate',
                label: tabLabel('Смета'),
                children: revisionData.loading ? <Spin /> : (
                  <EstimateTab data={revisionData} onGoToTree={goToTree} onGoToPanel={goToPanel} />
                ),
              },
              {
                key: 'tree',
                label: tabLabel('Дерево'),
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
                label: tabLabel('Материалы', selectedRevision.summary.uniqueMaterials),
                children: (
                  <MaterialsSummaryTab
                    revisionId={selectedRevision.bazisRevisionId}
                    canManage={canManage}
                  />
                ),
              },
              {
                key: 'orders',
                label: tabLabel('Заказы'),
                children: <RevisionOrdersTab revisionId={selectedRevision.bazisRevisionId} />,
              },
            ]}
          />
        )}
      </Card>
    </div>
  );
};

function directCutExportFileName(projectName: string, revisionId: number): string {
  const safe = projectName.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '').slice(0, 120) || 'проект';
  return `Базис-раскрой-${safe}-${revisionId}.xls`;
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

interface PickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<BazisCutSaveHandle>;
}

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
