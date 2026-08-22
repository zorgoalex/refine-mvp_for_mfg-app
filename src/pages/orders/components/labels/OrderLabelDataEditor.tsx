import { Table } from '../../../../ui/tooltipDelay';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Checkbox, Empty, Input, Select, Space, Typography, message } from 'antd';
import { SaveOutlined, SearchOutlined, ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons';
import { labelsApi } from '../../../../api/labelsApi';
import type { LabelTemplate, LatestOrderLabelsPreview, OrderLabelData } from '../../../../api/types/labelsApi.types';
import { canAny } from '../../../../utils/permissions';
import { parseBasisDataView } from './parseBasisDataView';
import { OrderLabelGenerateAction } from './OrderLabelGenerateAction';
import { LabelSvgPreviewFrame } from './LabelSvgPreviewFrame';
import { OrderLabelPagesViewer } from './OrderLabelPagesViewer';
import { firstLabelPageIndexForDetail } from './orderLabelPreviewIndex';
import { useOperationalUi } from '../../../../ui-operational/OperationalPrimitives';
import { useOrderAsyncReadGuard } from '../../../../query/orderLifecycleQueries';
import { useKeepAlive } from '../../../../components/workspace/KeepAliveContext';
import { acquireWorkspaceOperationPin } from '../../../../workspace/workspaceOperationPins';

const { Text } = Typography;

interface OrderLabelDataEditorProps {
  orderId?: number;
  isOrderDirty: boolean;
}

export const OrderLabelInlinePreviewSurface: React.FC<{ svg: string }> = ({ svg }) => (
  <div
    style={{
      alignItems: 'center',
      display: 'flex',
      justifyContent: 'center',
      minHeight: 180,
      overflow: 'hidden',
      padding: 12,
    }}
  >
    <LabelSvgPreviewFrame
      className="order-label-inline-preview-fit"
      svg={svg}
      style={{ display: 'inline-block', maxWidth: '100%' }}
    />
  </div>
);

export const OrderLabelDataEditor: React.FC<OrderLabelDataEditorProps> = ({ orderId, isOrderDirty }) => {
  const { tabKey } = useKeepAlive();
  const isOperational = useOperationalUi();
  const canWrite = canAny(['labels.generate', 'labels.manage_templates']);
  const readGuard = useOrderAsyncReadGuard(`labels:${orderId ?? 'unsaved'}`);
  const readScopeKey = `${readGuard.authNamespace}|order:${orderId ?? 'unsaved'}`;
  const [stateScopeKey, setStateScopeKey] = useState(readScopeKey);
  const stateIsCurrent = stateScopeKey === readScopeKey;
  const [storedTemplates, setTemplates] = useState<LabelTemplate[]>([]);
  const [storedTemplateId, setTemplateId] = useState<number | null>(null);
  const [storedData, setData] = useState<OrderLabelData | null>(null);
  const templates = stateIsCurrent ? storedTemplates : [];
  const templateId = stateIsCurrent ? storedTemplateId : null;
  const data = stateIsCurrent ? storedData : null;
  const [selectedDetailId, setSelectedDetailId] = useState<number | null>(null);
  const [commentsByDetailId, setCommentsByDetailId] = useState<Record<number, string>>({});
  const [dirtyDetailIds, setDirtyDetailIds] = useState<Set<number>>(new Set());
  const labelDataDirty = dirtyDetailIds.size > 0;
  const [loading, setLoading] = useState(false);
  const [storedLatestPreview, setLatestPreview] = useState<LatestOrderLabelsPreview | null>(null);
  const latestPreview = stateIsCurrent ? storedLatestPreview : null;
  const [latestPreviewLoading, setLatestPreviewLoading] = useState(false);
  const [latestPreviewRefreshKey, setLatestPreviewRefreshKey] = useState(0);
  const [selectedLatestPageIndex, setSelectedLatestPageIndex] = useState<number | null>(null);
  const [detailSearch, setDetailSearch] = useState('');
  const selectedTemplate = useMemo(
    () => templates.find((template) => template.labelTemplateId === templateId) ?? null,
    [templateId, templates],
  );

  useEffect(() => {
    if (stateScopeKey === readScopeKey) return;
    setStateScopeKey(readScopeKey);
    setTemplates([]);
    setTemplateId(null);
    setData(null);
    setSelectedDetailId(null);
    setCommentsByDetailId({});
    setDirtyDetailIds(new Set());
    setLoading(false);
    setLatestPreview(null);
    setLatestPreviewLoading(false);
    setSelectedLatestPageIndex(null);
    setDetailSearch('');
  }, [readScopeKey, stateScopeKey]);

  useEffect(() => {
    if (!orderId || !readGuard.active) return undefined;
    const token = readGuard.capture();
    if (!token) return undefined;
    let cancelled = false;
    setLoading(true);
    labelsApi.listTemplates(true)
      .then((next) => {
        if (cancelled || !readGuard.isCurrent(token)) return;
        setTemplates(next);
        setTemplateId((current) => current ?? next.find((template) => template.isActive)?.labelTemplateId ?? null);
      })
      .catch(() => {
        if (!cancelled && readGuard.isCurrent(token)) message.error('Не удалось загрузить шаблоны бирок');
      })
      .finally(() => {
        if (!cancelled && readGuard.isCurrent(token)) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orderId, readGuard.active, readGuard.authNamespace, readGuard.capture, readGuard.isCurrent]);

  useEffect(() => {
    if (!orderId || !templateId || !readGuard.active) return undefined;
    const token = readGuard.capture();
    if (!token) return undefined;
    let cancelled = false;
    setLoading(true);
    labelsApi.getOrderLabelData(orderId, templateId)
      .then((next) => {
        if (cancelled || !readGuard.isCurrent(token)) return;
        setData(next);
        setSelectedDetailId((current) =>
          current && next.details.some((detail) => detail.detailId === current)
            ? current
            : next.details[0]?.detailId ?? null,
        );
        setCommentsByDetailId(Object.fromEntries(
          next.details.map((detail) => [detail.detailId, String(detail.bazisFields['bazis.comment'] ?? detail.note ?? '')]),
        ));
        setDirtyDetailIds(new Set());
      })
      .catch(() => {
        if (!cancelled && readGuard.isCurrent(token)) message.error('Не удалось загрузить данные бирок');
      })
      .finally(() => {
        if (!cancelled && readGuard.isCurrent(token)) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orderId, readGuard.active, readGuard.authNamespace, readGuard.capture, readGuard.isCurrent, templateId]);

  useEffect(() => {
    if (!orderId) {
      setLatestPreview(null);
      return undefined;
    }
    if (!readGuard.active) return undefined;
    const token = readGuard.capture();
    if (!token) return undefined;
    let cancelled = false;
    setLatestPreviewLoading(true);
    labelsApi.getLatest(orderId)
      .then((latest) => {
        if (!cancelled && readGuard.isCurrent(token)) setLatestPreview(latest);
      })
      .catch(() => {
        if (!cancelled && readGuard.isCurrent(token)) setLatestPreview(null);
      })
      .finally(() => {
        if (!cancelled && readGuard.isCurrent(token)) setLatestPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    latestPreviewRefreshKey,
    orderId,
    readGuard.active,
    readGuard.authNamespace,
    readGuard.capture,
    readGuard.isCurrent,
  ]);

  const save = async () => {
    if (!orderId || !data || !templateId || isOrderDirty) return;
    const writeToken = readGuard.capture();
    if (!writeToken) return;
    const releaseOperationPin = acquireWorkspaceOperationPin(
      tabKey || `/orders/show/${orderId}`,
      'order-label-write',
    );
    setLoading(true);
    try {
      const next = await labelsApi.updateOrderLabelData(orderId, {
        templateId,
        rows: data.details
          .filter((detail) => dirtyDetailIds.has(detail.detailId))
          .map((detail) => ({
            detailId: detail.detailId,
            version: detail.version,
            bazisFields: {
              ...detail.bazisFields,
              'bazis.comment': commentsByDetailId[detail.detailId] ?? '',
            },
            customFields: detail.customFields,
          })),
        idempotencyKey: `order-label-data-${orderId}-${Date.now()}`,
      });
      if (!readGuard.isSameResource(writeToken)) return;
      setData(next);
      setDirtyDetailIds(new Set());
      message.success('Данные бирок сохранены');
    } catch {
      if (readGuard.isSameResource(writeToken)) message.error('Не удалось сохранить данные бирок');
    } finally {
      releaseOperationPin();
      if (readGuard.isSameResource(writeToken)) setLoading(false);
    }
  };

  if (!orderId) {
    return <Alert type="info" showIcon message="Бирки доступны после сохранения заказа" />;
  }

  const detailPreviewOptions = (data?.details ?? []).map((detail) => {
    const parsed = parseBasisDataView(detail.basisData);
    const position = parsed.position ?? detail.detailNumber ?? detail.detailId;
    const name = detail.detailName ?? parsed.name ?? 'Деталь';
    return {
      detailId: detail.detailId,
      label: `Позиция ${position}: ${name}`,
    };
  });
  const selectedDetailFirstPageIndex = firstLabelPageIndexForDetail(
    selectedDetailId,
    latestPreview?.rows,
    data?.details,
  );

  useEffect(() => {
    setSelectedLatestPageIndex(selectedDetailFirstPageIndex);
  }, [latestPreview?.generationId, selectedDetailId, selectedDetailFirstPageIndex]);
  const selectedDetail = data?.details.find((detail) => detail.detailId === selectedDetailId) ?? null;
  const selectedBasis = selectedDetail ? parseBasisDataView(selectedDetail.basisData) : null;
  const selectedPreviewIndex = selectedLatestPageIndex ?? selectedDetailFirstPageIndex;
  const selectedPreviewSvg = latestPreview?.svgPages[selectedPreviewIndex] ?? null;
  const labelCount = (data?.details ?? []).reduce(
    (total, detail) => total + Math.max(1, Number(detail.quantity) || 1),
    0,
  );
  const visibleDetails = (data?.details ?? []).filter((detail) => {
    const query = detailSearch.trim().toLocaleLowerCase('ru-RU');
    if (!query) return true;
    const parsed = parseBasisDataView(detail.basisData);
    return [
      detail.detailNumber,
      detail.detailName,
      parsed.position,
      parsed.name,
      parsed.designation,
      detail.materialName,
    ].some((value) => String(value ?? '').toLocaleLowerCase('ru-RU').includes(query));
  });

  return (
    <Card size="small" title="Бирки" className="order-label-data-editor">
      <style>{`
        .order-label-inline-preview-fit svg {
          display: block;
          max-width: 100%;
          max-height: 260px;
          width: auto;
          height: auto;
        }

        .order-label-editor-workspace {
          display: grid;
          grid-template-columns: minmax(190px, 220px) minmax(360px, 1fr) minmax(230px, 280px);
          gap: 12px;
          min-height: 540px;
        }

        .order-label-editor-panel {
          min-width: 0;
          overflow: hidden;
          border: 1px solid var(--app-border);
          border-radius: var(--operational-radius);
          background: var(--app-surface);
        }

        .order-label-editor-panel__head {
          padding: 13px;
          border-bottom: 1px solid var(--app-border);
        }

        .order-label-editor-panel__head h3.ant-typography {
          margin: 3px 0 0;
          font-size: 14px;
        }

        .order-label-editor-list {
          display: flex;
          max-height: 520px;
          flex-direction: column;
          gap: 5px;
          padding: 8px;
          overflow: auto;
        }

        .order-label-editor-list__item {
          display: flex;
          width: 100%;
          min-height: 52px;
          flex-direction: column;
          justify-content: center;
          padding: 7px 9px;
          border: 1px solid var(--app-border);
          border-radius: calc(var(--operational-radius) - 3px);
          background: var(--app-surface);
          color: inherit;
          font: inherit;
          text-align: left;
          cursor: pointer;
        }

        .order-label-editor-list__item.is-active {
          border-color: var(--operational-brand);
          background: var(--operational-brand-soft);
        }

        .order-label-editor-list__item small {
          color: var(--app-text-muted);
        }

        .order-label-editor-preview {
          display: flex;
          min-height: 0;
          flex-direction: column;
        }

        .order-label-editor-preview__toolbar {
          display: flex;
          min-height: 52px;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 8px 12px;
          border-bottom: 1px solid var(--app-border);
        }

        .order-label-editor-preview__toolbar-actions {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .order-label-editor-preview__canvas {
          display: flex;
          min-height: 0;
          flex: 1;
          align-items: center;
          justify-content: center;
          padding: 20px;
          overflow: auto;
          background: var(--app-bg);
        }

        .order-label-editor-preview__canvas svg {
          display: block;
          width: auto;
          max-width: 100%;
          max-height: 480px;
        }

        .order-label-editor-properties {
          display: flex;
          flex-direction: column;
        }

        .order-label-editor-properties__body {
          display: flex;
          flex: 1;
          flex-direction: column;
          gap: 12px;
          padding: 13px;
        }

        .order-label-editor-field {
          display: flex;
          flex-direction: column;
          gap: 5px;
        }

        .order-label-editor-field > label {
          color: var(--app-text-muted);
          font-size: 10px;
          font-weight: 700;
        }

        @media (max-width: 980px) {
          .order-label-editor-workspace {
            grid-template-columns: 200px minmax(0, 1fr);
          }

          .order-label-editor-properties {
            grid-column: 1 / -1;
          }
        }

        @media (max-width: 720px) {
          .order-label-editor-workspace {
            grid-template-columns: 1fr;
          }

          .order-label-editor-properties {
            grid-column: auto;
          }
        }
      `}</style>
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        {isOrderDirty && <Alert type="warning" showIcon message="Сначала сохраните заказ" />}
        {labelDataDirty && <Alert type="warning" showIcon message="Сначала сохраните данные бирок" />}
        {isOperational ? (
          <div className="order-label-editor-config">
            <label className="order-label-editor-config__template">
              <span>Шаблон бирок</span>
              <Select
                value={templateId}
                loading={loading}
                onChange={(value) => setTemplateId(value)}
                options={templates.map((template) => ({
                  value: template.labelTemplateId,
                  label: template.isActive ? template.name : `${template.name} (архив)`,
                }))}
                placeholder="Шаблон"
              />
            </label>
            <div className="order-label-editor-config__options" aria-label="Поля шаблона">
              <Checkbox defaultChecked>QR-код</Checkbox>
              <Checkbox defaultChecked>Схема детали</Checkbox>
              <Checkbox defaultChecked>Плёнка</Checkbox>
              <Checkbox>Операции</Checkbox>
            </div>
            <div className="order-label-editor-config__actions">
              <Button
                onClick={() => document.querySelector('.order-label-editor-list')?.scrollIntoView({ block: 'nearest' })}
              >
                Выбрать детали
              </Button>
              <OrderLabelGenerateAction
                orderId={orderId}
                isOrderDirty={isOrderDirty || labelDataDirty}
                initialDetailId={selectedDetailId}
                detailOptions={detailPreviewOptions}
                buttonLabel={`Сформировать ${labelCount || 0} бирок`}
                onGenerated={() => setLatestPreviewRefreshKey((current) => current + 1)}
              />
            </div>
          </div>
        ) : (
          <Space wrap>
            <Select
              style={{ minWidth: 260 }}
              value={templateId}
              loading={loading}
              onChange={(value) => setTemplateId(value)}
              options={templates.map((template) => ({
                value: template.labelTemplateId,
                label: template.isActive ? template.name : `${template.name} (архив)`,
              }))}
              placeholder="Шаблон"
            />
            <Button icon={<SaveOutlined />} onClick={save} loading={loading} disabled={!canWrite || isOrderDirty || !data || !labelDataDirty}>
              Сохранить данные бирок
            </Button>
            <OrderLabelGenerateAction
              orderId={orderId}
              isOrderDirty={isOrderDirty || labelDataDirty}
              compact
              initialDetailId={selectedDetailId}
              detailOptions={detailPreviewOptions}
              onGenerated={() => setLatestPreviewRefreshKey((current) => current + 1)}
            />
          </Space>
        )}
        {!isOperational && (latestPreview || latestPreviewLoading) && (
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {latestPreviewLoading ? (
              <Text type="secondary">Загрузка превью...</Text>
            ) : (
              latestPreview && (
                <OrderLabelPagesViewer
                  svgPages={latestPreview.svgPages}
                  rows={latestPreview.rows}
                  title={`Последняя генерация: ${latestPreview.labelCount} шт.`}
                  printTitle={`Заказ ${orderId} — последняя генерация бирок #${latestPreview.generationId}`}
                  selectedIndex={selectedLatestPageIndex ?? selectedDetailFirstPageIndex}
                  onSelectedIndexChange={setSelectedLatestPageIndex}
                />
              )
            )}
          </Space>
        )}
        {!isOperational && selectedDetailId && (
          <Text type="secondary">Выбрана для предпросмотра: {detailPreviewOptions.find((detail) => detail.detailId === selectedDetailId)?.label}</Text>
        )}
        {!isOperational ? <Table
          rowKey="detailId"
          size="small"
          loading={loading}
          dataSource={data?.details ?? []}
          pagination={false}
          rowClassName={(detail) => detail.detailId === selectedDetailId ? 'ant-table-row-selected' : ''}
          onRow={(detail) => ({
            onClick: () => setSelectedDetailId(detail.detailId),
            style: { cursor: 'pointer' },
          })}
          columns={[
            {
              title: 'Позиция',
              width: 120,
              render: (_, detail) => parseBasisDataView(detail.basisData).position ?? detail.detailNumber ?? '—',
            },
            {
              title: 'Деталь',
              render: (_, detail) => (
                <Space direction="vertical" size={0}>
                  <Text>{detail.detailName ?? parseBasisDataView(detail.basisData).name ?? '—'}</Text>
                  <Text type="secondary">{selectedTemplate?.name ?? '—'}</Text>
                </Space>
              ),
            },
            { title: 'Кол-во', dataIndex: 'quantity', width: 80 },
            {
              title: 'Комментарий бирки',
              width: 260,
              render: (_, detail) => (
                <Input
                  value={commentsByDetailId[detail.detailId] ?? ''}
                  disabled={!canWrite || isOrderDirty}
                  onChange={(event) => {
                    setDirtyDetailIds((current) => new Set([...current, detail.detailId]));
                    setCommentsByDetailId((current) => ({
                      ...current,
                      [detail.detailId]: event.target.value,
                    }));
                  }}
                />
              ),
            },
          ]}
        /> : (
          <div className="order-label-editor-workspace">
            <aside className="order-label-editor-panel">
              <div className="order-label-editor-panel__head">
                <Text type="secondary">Редактирование</Text>
                <Typography.Title level={3}>Список бирок</Typography.Title>
              </div>
              <div style={{ padding: '8px 8px 0' }}>
                <Input
                  allowClear
                  prefix={<SearchOutlined />}
                  placeholder="Номер или деталь"
                  aria-label="Поиск бирки"
                  value={detailSearch}
                  onChange={(event) => setDetailSearch(event.target.value)}
                />
              </div>
              <div className="order-label-editor-list">
                {visibleDetails.map((detail) => {
                  const parsed = parseBasisDataView(detail.basisData);
                  const position = parsed.position ?? detail.detailNumber ?? detail.detailId;
                  const name = detail.detailName ?? parsed.name ?? 'Деталь';
                  return (
                    <button
                      key={detail.detailId}
                      type="button"
                      className={`order-label-editor-list__item${detail.detailId === selectedDetailId ? ' is-active' : ''}`}
                      onClick={() => setSelectedDetailId(detail.detailId)}
                    >
                      <strong>{`Бирка ${position}`}</strong>
                      <small>{`Позиция ${position} · ${name}`}</small>
                    </button>
                  );
                })}
              </div>
            </aside>

            <section className="order-label-editor-panel order-label-editor-preview">
              <div className="order-label-editor-preview__toolbar">
                <div className="order-label-editor-preview__toolbar-actions">
                  <Text strong>{latestPreviewLoading ? 'Обновление...' : 'Предпросмотр 100%'}</Text>
                  <Button aria-label="Уменьшить масштаб" icon={<ZoomOutOutlined />} />
                  <Button aria-label="Увеличить масштаб" icon={<ZoomInOutlined />} />
                </div>
                <Button
                  disabled={!labelDataDirty}
                  onClick={() => {
                    if (!data) return;
                    setCommentsByDetailId(Object.fromEntries(
                      data.details.map((detail) => [
                        detail.detailId,
                        String(detail.bazisFields['bazis.comment'] ?? detail.note ?? ''),
                      ]),
                    ));
                    setDirtyDetailIds(new Set());
                  }}
                >
                  Сбросить изменения
                </Button>
              </div>
              <div className="order-label-editor-preview__canvas">
                {selectedPreviewSvg ? (
                  <LabelSvgPreviewFrame svg={selectedPreviewSvg} />
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Сформируйте бирки для предпросмотра" />
                )}
              </div>
            </section>

            <aside className="order-label-editor-panel order-label-editor-properties">
              <div className="order-label-editor-panel__head">
                <Text type="secondary">Свойства</Text>
                <Typography.Title level={3}>
                  {selectedDetail ? `Бирка ${selectedBasis?.position ?? selectedDetail.detailNumber ?? '—'}` : 'Бирка'}
                </Typography.Title>
              </div>
              <div className="order-label-editor-properties__body">
                <div className="order-label-editor-field">
                  <label htmlFor="order-label-detail-name">Название детали на бирке</label>
                  <Input
                    id="order-label-detail-name"
                    value={selectedDetail?.detailName ?? selectedBasis?.name ?? ''}
                    disabled
                  />
                </div>
                <div className="order-label-editor-field">
                  <label htmlFor="order-label-detail-size">Размер</label>
                  <Input
                    id="order-label-detail-size"
                    value={selectedBasis?.designation ?? selectedBasis?.raw ?? ''}
                    disabled
                  />
                </div>
                <div className="order-label-editor-field">
                  <label htmlFor="order-label-detail-comment">Комментарий бирки</label>
                  <Input.TextArea
                    id="order-label-detail-comment"
                    rows={4}
                    value={selectedDetail ? commentsByDetailId[selectedDetail.detailId] ?? '' : ''}
                    disabled={!selectedDetail || !canWrite || isOrderDirty}
                    onChange={(event) => {
                      if (!selectedDetail) return;
                      setDirtyDetailIds((current) => new Set([...current, selectedDetail.detailId]));
                      setCommentsByDetailId((current) => ({
                        ...current,
                        [selectedDetail.detailId]: event.target.value,
                      }));
                    }}
                  />
                </div>
                <div className="order-label-editor-field">
                  <label htmlFor="order-label-detail-quantity">Количество копий</label>
                  <Input
                    id="order-label-detail-quantity"
                    value={selectedDetail?.quantity ?? ''}
                    disabled
                  />
                </div>
                <span style={{ flex: 1 }} />
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  onClick={save}
                  loading={loading}
                  disabled={!canWrite || isOrderDirty || !data || !labelDataDirty}
                >
                  Сохранить бирку
                </Button>
              </div>
            </aside>
          </div>
        )}
      </Space>
    </Card>
  );
};
