import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Empty, Space, Typography, message } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { labelsApi } from '../../../../api/labelsApi';
import type { LatestOrderLabelsPreview } from '../../../../api/types/labelsApi.types';
import { can } from '../../../../utils/permissions';
import { saveLabelBlob } from './labelDownloads';
import { OrderLabelGenerateAction } from './OrderLabelGenerateAction';
import { LabelSvgPreviewFrame } from './LabelSvgPreviewFrame';
import { OrderLabelPagesViewer } from './OrderLabelPagesViewer';
import { useOperationalUi } from '../../../../ui-operational/OperationalPrimitives';

const { Text } = Typography;

interface OrderLatestLabelsPreviewProps {
  orderId: number;
}

export const OrderLatestLabelPreviewSurface: React.FC<{
  svg: string;
  zoomed: boolean;
  onToggle?: () => void;
}> = ({ svg, zoomed, onToggle }) => (
  <LabelSvgPreviewFrame
    svg={svg}
    onClick={onToggle}
    title={zoomed ? 'Свернуть бирку' : 'Увеличить бирку'}
    contentStyle={{ zoom: zoomed ? 1 : 0.25 }}
    style={{
      border: '1px solid var(--app-border)',
      overflow: 'hidden',
      cursor: 'pointer',
      display: 'inline-block',
      lineHeight: 0,
    }}
  />
);

export const OrderLatestLabelsPreview: React.FC<OrderLatestLabelsPreviewProps> = ({ orderId }) => {
  const isOperational = useOperationalUi();
  const canGenerate = can('labels.generate');
  const [latest, setLatest] = useState<LatestOrderLabelsPreview | null>(null);
  const [loading, setLoading] = useState(false);

  const loadLatest = useCallback(() => {
    setLoading(true);
    labelsApi.getLatest(orderId)
      .then(setLatest)
      .catch(() => setLatest(null))
      .finally(() => setLoading(false));
  }, [orderId]);

  useEffect(() => {
    loadLatest();
  }, [loadLatest]);

  const downloadLatest = async () => {
    try {
      const downloaded = await labelsApi.downloadLatest(orderId);
      saveLabelBlob(downloaded.blob, downloaded.fileName ?? `order-${orderId}-labels.zip`);
    } catch {
      message.error('Не удалось скачать бирки');
    }
  };

  return (
    <div
      className={isOperational ? 'order-latest-labels-preview--operational' : undefined}
      style={isOperational ? undefined : { marginBottom: 8, borderTop: '1px solid var(--app-border)', paddingTop: 8 }}
    >
      <div
        className="order-latest-labels-preview__title"
        style={{ fontSize: 12, fontWeight: 600, color: '#1677ff', marginBottom: 3 }}
      >
        Бирки
      </div>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {latest ? (
          <>
            <OrderLabelPagesViewer
              svgPages={latest.svgPages}
              rows={latest.rows}
              title={`Последняя генерация: ${latest.labelCount} шт.`}
              printTitle={`Заказ ${orderId} — последняя генерация бирок #${latest.generationId}`}
            />
            <Space wrap className="order-latest-labels-preview__actions">
              {canGenerate && (
                <Button size="small" icon={<DownloadOutlined />} onClick={downloadLatest}>
                  Скачать ZIP
                </Button>
              )}
              {canGenerate && <OrderLabelGenerateAction orderId={orderId} compact onGenerated={loadLatest} />}
            </Space>
          </>
        ) : loading ? (
          <Text type="secondary">Загрузка...</Text>
        ) : (
          <Space direction="vertical" size={8}>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Бирки ещё не формировались" />
            {canGenerate ? <OrderLabelGenerateAction orderId={orderId} compact onGenerated={loadLatest} /> : <Alert type="info" showIcon message="Нет сформированных бирок" />}
          </Space>
        )}
      </Space>
    </div>
  );
};
