import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Input, Select, Space, Table, Typography, message } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { labelsApi } from '../../../../api/labelsApi';
import type { LabelTemplate, OrderLabelData } from '../../../../api/types/labelsApi.types';
import { canAny } from '../../../../utils/permissions';
import { parseBasisDataView } from './parseBasisDataView';
import { OrderLabelGenerateAction } from './OrderLabelGenerateAction';

const { Text } = Typography;

interface OrderLabelDataEditorProps {
  orderId?: number;
  isOrderDirty: boolean;
}

export const OrderLabelDataEditor: React.FC<OrderLabelDataEditorProps> = ({ orderId, isOrderDirty }) => {
  const canWrite = canAny(['labels.generate', 'labels.manage_templates']);
  const [templates, setTemplates] = useState<LabelTemplate[]>([]);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [data, setData] = useState<OrderLabelData | null>(null);
  const [selectedDetailId, setSelectedDetailId] = useState<number | null>(null);
  const [commentsByDetailId, setCommentsByDetailId] = useState<Record<number, string>>({});
  const [dirtyDetailIds, setDirtyDetailIds] = useState<Set<number>>(new Set());
  const labelDataDirty = dirtyDetailIds.size > 0;
  const [loading, setLoading] = useState(false);
  const [latestPreviewSvg, setLatestPreviewSvg] = useState<string | null>(null);
  const [latestPreviewLoading, setLatestPreviewLoading] = useState(false);
  const [latestPreviewRefreshKey, setLatestPreviewRefreshKey] = useState(0);
  const selectedTemplate = useMemo(
    () => templates.find((template) => template.labelTemplateId === templateId) ?? null,
    [templateId, templates],
  );

  useEffect(() => {
    if (!orderId) return;
    setLoading(true);
    labelsApi.listTemplates(true)
      .then((next) => {
        setTemplates(next);
        setTemplateId((current) => current ?? next.find((template) => template.isActive)?.labelTemplateId ?? null);
      })
      .catch(() => message.error('Не удалось загрузить шаблоны бирок'))
      .finally(() => setLoading(false));
  }, [orderId]);

  useEffect(() => {
    if (!orderId || !templateId) return;
    setLoading(true);
    labelsApi.getOrderLabelData(orderId, templateId)
      .then((next) => {
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
      .catch(() => message.error('Не удалось загрузить данные бирок'))
      .finally(() => setLoading(false));
  }, [orderId, templateId]);

  useEffect(() => {
    const firstDetailId = data?.details[0]?.detailId;
    if (!orderId || !firstDetailId) {
      setLatestPreviewSvg(null);
      return;
    }
    let cancelled = false;
    setLatestPreviewLoading(true);
    labelsApi.getLatest(orderId)
      .then(async (latest) => {
        try {
          const preview = await labelsApi.previewOrderLabels(orderId, {
            templateId: latest.templateId,
            templateVersion: latest.templateVersion,
            detailFilters: { detailIds: [firstDetailId] },
          });
          if (!cancelled) {
            setLatestPreviewSvg(preview.svgPages[0] ?? latest.svgPages[0] ?? null);
          }
        } catch {
          if (!cancelled) {
            setLatestPreviewSvg(latest.svgPages[0] ?? null);
          }
        }
      })
      .catch(() => {
        if (!cancelled) setLatestPreviewSvg(null);
      })
      .finally(() => {
        if (!cancelled) setLatestPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [data, latestPreviewRefreshKey, orderId]);

  const save = async () => {
    if (!orderId || !data || !templateId || isOrderDirty) return;
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
      setData(next);
      setDirtyDetailIds(new Set());
      message.success('Данные бирок сохранены');
    } catch {
      message.error('Не удалось сохранить данные бирок');
    } finally {
      setLoading(false);
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

  return (
    <Card size="small" title="Бирки">
      <style>{`
        .order-label-inline-preview-fit svg {
          display: block;
          max-width: 100%;
          max-height: 260px;
          width: auto;
          height: auto;
        }
      `}</style>
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        {isOrderDirty && <Alert type="warning" showIcon message="Сначала сохраните заказ" />}
        {labelDataDirty && <Alert type="warning" showIcon message="Сначала сохраните данные бирок" />}
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
        {(latestPreviewSvg || latestPreviewLoading) && (
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            <Text type="secondary">Превью последней генерации: первая позиция</Text>
            {latestPreviewLoading ? (
              <Text type="secondary">Загрузка превью...</Text>
            ) : (
              <div
                className="order-label-inline-preview-fit"
                style={{
                  alignItems: 'center',
                  border: '1px solid var(--app-border)',
                  display: 'flex',
                  justifyContent: 'center',
                  minHeight: 180,
                  overflow: 'hidden',
                  padding: 12,
                }}
                dangerouslySetInnerHTML={{ __html: latestPreviewSvg ?? '' }}
              />
            )}
          </Space>
        )}
        {selectedDetailId && (
          <Text type="secondary">Выбрана для предпросмотра: {detailPreviewOptions.find((detail) => detail.detailId === selectedDetailId)?.label}</Text>
        )}
        <Table
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
        />
      </Space>
    </Card>
  );
};
