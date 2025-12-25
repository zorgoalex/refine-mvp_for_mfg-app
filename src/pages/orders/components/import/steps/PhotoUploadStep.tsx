// Step 1: Photo Upload with VLM analysis progress and results preview
// Supports optional image crop before analysis

import React, { useCallback, useState, useEffect, useRef } from 'react';
import { Upload, Table, Typography, Space, Alert, Progress, Descriptions, Tag, Button, Image, Checkbox } from 'antd';
import {
  InboxOutlined,
  CameraOutlined,
  CloudUploadOutlined,
  ScanOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ReloadOutlined,
  ScissorOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from '@ant-design/icons';
import type { UploadProps } from 'antd';
import type { Crop, PixelCrop } from 'react-image-crop';
import type { ImportStatus, VlmImportResult } from '../../../../../hooks/useVlmImport';
import type { ImportRow } from '../types/importTypes';
import { ImageCropArea, cropImageToBlob } from '../components/ImageCropArea';

const { Dragger } = Upload;
const { Text, Title } = Typography;

interface PhotoUploadStepProps {
  status: ImportStatus;
  progress: number;
  statusMessage: string;
  error: string | null;
  result: VlmImportResult | null;
  importRows: ImportRow[];
  onFileUpload: (file: File | Blob) => Promise<VlmImportResult>;
  onReset: () => void;
}

// Status icons mapping
const STATUS_ICONS: Record<ImportStatus, React.ReactNode> = {
  idle: <CameraOutlined style={{ fontSize: 48, color: '#1890ff' }} />,
  uploading: <CloudUploadOutlined style={{ fontSize: 48, color: '#1890ff' }} />,
  analyzing: <ScanOutlined style={{ fontSize: 48, color: '#722ed1' }} />,
  parsing: <ScanOutlined style={{ fontSize: 48, color: '#13c2c2' }} />,
  success: <CheckCircleOutlined style={{ fontSize: 48, color: '#52c41a' }} />,
  error: <CloseCircleOutlined style={{ fontSize: 48, color: '#ff4d4f' }} />,
};

// Status colors for progress
const STATUS_COLORS: Record<ImportStatus, string> = {
  idle: '#1890ff',
  uploading: '#1890ff',
  analyzing: '#722ed1',
  parsing: '#13c2c2',
  success: '#52c41a',
  error: '#ff4d4f',
};

export const PhotoUploadStep: React.FC<PhotoUploadStepProps> = ({
  status,
  progress,
  statusMessage,
  error,
  result,
  importRows,
  onFileUpload,
  onReset,
}) => {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  // Crop states
  const [useFullImage, setUseFullImage] = useState(true);
  const [showCropPreview, setShowCropPreview] = useState(false);
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
  const [scale, setScale] = useState(1);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // Zoom constants
  const MIN_SCALE = 0.25;
  const MAX_SCALE = 3;
  const SCALE_STEP = 0.25;

  // Cleanup preview URL on unmount or reset
  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  // Clear preview when reset (status changes TO idle, not when already idle)
  const prevStatusRef = useRef<ImportStatus>(status);
  useEffect(() => {
    // Only clear when transitioning TO idle (e.g., after error reset)
    // Not when already idle (e.g., after file selection)
    if (status === 'idle' && prevStatusRef.current !== 'idle' && previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      setSelectedFile(null);
      setShowCropPreview(false);
      setCrop(undefined);
      setCompletedCrop(undefined);
      setScale(1);
    }
    prevStatusRef.current = status;
  }, [status, previewUrl]);

  // Handle file selection - show preview first
  const handleFileSelect: UploadProps['customRequest'] = useCallback(async (options) => {
    const { file, onSuccess } = options;
    const fileObj = file as File;

    // Create preview URL
    const url = URL.createObjectURL(fileObj);
    setPreviewUrl(url);
    setSelectedFile(fileObj);
    setShowCropPreview(true);
    setCrop(undefined);
    setCompletedCrop(undefined);
    setScale(1);

    onSuccess?.({});
  }, []);

  // Handle analyze button click
  const handleAnalyze = useCallback(async () => {
    if (!selectedFile) return;

    try {
      if (!useFullImage && completedCrop && imgRef.current) {
        // Crop image and upload
        const croppedBlob = await cropImageToBlob(imgRef.current, completedCrop);
        await onFileUpload(croppedBlob);
      } else {
        // Upload full image
        await onFileUpload(selectedFile);
      }
      setShowCropPreview(false);
    } catch (err) {
      console.error('Analyze error:', err);
    }
  }, [selectedFile, useFullImage, completedCrop, onFileUpload]);

  // Handle image load for crop
  const handleImageLoad = useCallback((img: HTMLImageElement) => {
    imgRef.current = img;
  }, []);

  // Cancel crop preview
  const handleCancelCrop = useCallback(() => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    setPreviewUrl(null);
    setSelectedFile(null);
    setShowCropPreview(false);
    setCrop(undefined);
    setCompletedCrop(undefined);
    setScale(1);
  }, [previewUrl]);

  // Zoom handlers
  const handleZoomIn = useCallback(() => {
    setScale((prev) => Math.min(prev + SCALE_STEP, MAX_SCALE));
  }, []);

  const handleZoomOut = useCallback(() => {
    setScale((prev) => Math.max(prev - SCALE_STEP, MIN_SCALE));
  }, []);

  const handleZoomReset = useCallback(() => {
    setScale(1);
  }, []);

  // Legacy upload handler (kept for compatibility)
  const handleUpload: UploadProps['customRequest'] = useCallback(async (options) => {
    const { file, onSuccess, onError } = options;
    try {
      // Create preview URL
      const url = URL.createObjectURL(file as File);
      setPreviewUrl(url);

      await onFileUpload(file as File);
      onSuccess?.({});
    } catch (err) {
      onError?.(err as Error);
    }
  }, [onFileUpload]);

  const uploadProps: UploadProps = {
    name: 'file',
    multiple: false,
    accept: 'image/*,.jpg,.jpeg,.png,.webp',
    customRequest: handleFileSelect,
    showUploadList: false,
    disabled: showCropPreview || (status !== 'idle' && status !== 'error' && status !== 'success'),
  };

  // Can analyze: full image always, or crop if area selected
  const canAnalyze = useFullImage || (completedCrop && completedCrop.width > 0 && completedCrop.height > 0);

  // Preview columns for parsed details
  const previewColumns = [
    {
      title: '№',
      dataIndex: 'sourceRowIndex',
      key: 'index',
      width: 50,
      render: (_: unknown, __: unknown, index: number) => index + 1,
    },
    {
      title: 'Название',
      dataIndex: 'detailName',
      key: 'detailName',
      width: 150,
      ellipsis: true,
      render: (value: string | null) => value || <Text type="secondary">—</Text>,
    },
    {
      title: 'Размер (мм)',
      key: 'size',
      width: 120,
      render: (_: unknown, record: ImportRow) => (
        <Text>{record.height ?? '?'} × {record.width ?? '?'}</Text>
      ),
    },
    {
      title: 'Кол-во',
      dataIndex: 'quantity',
      key: 'quantity',
      width: 70,
      align: 'center' as const,
    },
    {
      title: 'Обкат',
      dataIndex: 'edgeTypeName',
      key: 'edge',
      width: 100,
      ellipsis: true,
      render: (value: string | null) => value || <Text type="secondary">—</Text>,
    },
    {
      title: 'Плёнка',
      dataIndex: 'filmName',
      key: 'film',
      width: 150,
      ellipsis: true,
      render: (value: string | null) => value || <Text type="secondary">—</Text>,
    },
    {
      title: 'Материал',
      dataIndex: 'materialName',
      key: 'material',
      width: 150,
      ellipsis: true,
      render: (value: string | null) => value || <Text type="secondary">—</Text>,
    },
    {
      title: 'Примечание',
      dataIndex: 'note',
      key: 'note',
      width: 100,
      ellipsis: true,
      render: (value: string | null) => value || <Text type="secondary">—</Text>,
    },
  ];

  const isProcessing = status === 'uploading' || status === 'analyzing' || status === 'parsing';

  return (
    <div style={{ padding: '16px 0' }}>
      {/* Crop preview - shown after file selection, before analysis */}
      {showCropPreview && previewUrl && !isProcessing && (
        <div style={{
          background: '#fafafa',
          borderRadius: 8,
          padding: 16,
          marginBottom: 24,
        }}>
          {/* Header with checkbox and zoom controls */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
            flexWrap: 'wrap',
            gap: 8,
          }}>
            <Space>
              <ScissorOutlined style={{ fontSize: 18, color: '#1890ff' }} />
              <Text strong>Выберите область для анализа</Text>
            </Space>
            <Space size="middle">
              {/* Zoom controls */}
              <Space.Compact>
                <Button
                  icon={<ZoomOutOutlined />}
                  onClick={handleZoomOut}
                  disabled={scale <= MIN_SCALE}
                  title="Уменьшить"
                />
                <Button
                  onClick={handleZoomReset}
                  style={{ minWidth: 60 }}
                  title="Сбросить масштаб"
                >
                  {Math.round(scale * 100)}%
                </Button>
                <Button
                  icon={<ZoomInOutlined />}
                  onClick={handleZoomIn}
                  disabled={scale >= MAX_SCALE}
                  title="Увеличить"
                />
              </Space.Compact>
              {/* Full image checkbox */}
              <Checkbox
                checked={useFullImage}
                onChange={(e) => setUseFullImage(e.target.checked)}
              >
                Вся картинка
              </Checkbox>
            </Space>
          </div>

          {/* Image with optional crop */}
          <div style={{ marginBottom: 16 }}>
            {useFullImage ? (
              <div style={{
                background: '#f5f5f5',
                borderRadius: 8,
                padding: 16,
                overflow: 'auto',
                maxHeight: 400,
              }}>
                <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}>
                  <img
                    src={previewUrl}
                    alt="Preview"
                    onLoad={(e) => { imgRef.current = e.currentTarget; }}
                    style={{
                      display: 'block',
                      borderRadius: 4,
                      border: '1px solid #d9d9d9',
                    }}
                  />
                </div>
              </div>
            ) : (
              <>
                <ImageCropArea
                  imageSrc={previewUrl}
                  crop={crop}
                  onCropChange={setCrop}
                  onCropComplete={setCompletedCrop}
                  onImageLoad={handleImageLoad}
                  scale={scale}
                  containerHeight={400}
                />
                {!completedCrop && (
                  <Text type="secondary" style={{ display: 'block', textAlign: 'center', marginTop: 8 }}>
                    Выделите область мышью для анализа
                  </Text>
                )}
              </>
            )}
          </div>

          {/* Action buttons */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button onClick={handleCancelCrop}>
              Отмена
            </Button>
            <Button
              type="primary"
              onClick={handleAnalyze}
              disabled={!canAnalyze}
              icon={<ScanOutlined />}
            >
              Анализировать
            </Button>
          </div>
        </div>
      )}

      {/* Upload area or progress */}
      {isProcessing ? (
        <div style={{
          display: 'flex',
          gap: 24,
          padding: '20px',
          background: '#fafafa',
          borderRadius: 8,
          marginBottom: 24,
        }}>
          {/* Image preview */}
          {previewUrl && (
            <div style={{ flexShrink: 0 }}>
              <Image
                src={previewUrl}
                alt="Preview"
                style={{
                  maxWidth: 200,
                  maxHeight: 200,
                  objectFit: 'contain',
                  borderRadius: 4,
                  border: '1px solid #d9d9d9',
                }}
                preview={false}
              />
            </div>
          )}
          {/* Progress info */}
          <div style={{ flex: 1, textAlign: 'center', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            {STATUS_ICONS[status]}
            <div style={{ marginTop: 16, marginBottom: 16 }}>
              <Text strong style={{ fontSize: 16 }}>{statusMessage}</Text>
            </div>
            <Progress
              percent={progress}
              strokeColor={STATUS_COLORS[status]}
              style={{ maxWidth: 400, margin: '0 auto' }}
            />
            {status === 'analyzing' && (
              <Text type="secondary" style={{ display: 'block', marginTop: 12, fontSize: 12 }}>
                Анализ изображения может занять до минуты...
              </Text>
            )}
          </div>
        </div>
      ) : !showCropPreview && (
        <Dragger {...uploadProps} style={{ marginBottom: 24 }}>
          <p className="ant-upload-drag-icon">
            {STATUS_ICONS[status]}
          </p>
          <p className="ant-upload-text">
            {status === 'success'
              ? 'Загрузите другое фото или перейдите к проверке'
              : 'Перетащите изображение сюда или нажмите для выбора'}
          </p>
          <p className="ant-upload-hint">
            Поддерживаются форматы: JPG, PNG, WebP (до 5 МБ)
          </p>
        </Dragger>
      )}

      {/* Error alert */}
      {error && (
        <Alert
          type="error"
          message="Ошибка анализа"
          description={
            <Space direction="vertical">
              <Text>{error}</Text>
              <Button
                type="link"
                icon={<ReloadOutlined />}
                onClick={onReset}
                style={{ padding: 0 }}
              >
                Попробовать снова
              </Button>
            </Space>
          }
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      {/* Result display */}
      {result && result.success && (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          {/* Image preview + Metadata */}
          <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
            {/* Image preview */}
            {previewUrl && (
              <div style={{ flexShrink: 0 }}>
                <Image
                  src={previewUrl}
                  alt="Uploaded"
                  style={{
                    maxWidth: 200,
                    maxHeight: 200,
                    objectFit: 'contain',
                    borderRadius: 4,
                    border: '1px solid #d9d9d9',
                  }}
                />
              </div>
            )}
            {/* Metadata section */}
            <Descriptions
              title={
                <Space>
                  <CheckCircleOutlined style={{ color: '#52c41a' }} />
                  <span>Результат анализа</span>
                </Space>
              }
              bordered
              size="small"
              column={2}
              style={{ flex: 1 }}
            >
              <Descriptions.Item label="Найдено деталей">
                <Text strong style={{ fontSize: 16 }}>{result.items.length}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="Провайдер">
                <Tag color="blue">{result.provider || 'unknown'}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Модель">
                <Tag>{result.model || 'unknown'}</Tag>
              </Descriptions.Item>
              {result.duration && (
                <Descriptions.Item label="Время анализа">
                  <Text>{(result.duration / 1000).toFixed(1)} сек</Text>
                </Descriptions.Item>
              )}
            </Descriptions>
          </div>

          {/* Parse error warning */}
          {result.parseError && (
            <Alert
              type="warning"
              message="Предупреждение при разборе"
              description={result.parseError}
              showIcon
            />
          )}

          {/* Preview table */}
          {importRows.length > 0 && (
            <div>
              <Title level={5} style={{ marginBottom: 8 }}>
                Предпросмотр (первые 10 деталей):
              </Title>
              <Table
                columns={previewColumns}
                dataSource={importRows.slice(0, 10).map((row, idx) => ({ ...row, key: idx }))}
                pagination={false}
                size="small"
                scroll={{ x: 'max-content' }}
                bordered
                style={{ fontSize: 12 }}
              />
              {importRows.length > 10 && (
                <Text type="secondary" style={{ fontSize: 12, marginTop: 8, display: 'block' }}>
                  Показаны первые 10 деталей из {importRows.length}.
                  Все детали будут доступны на следующем шаге.
                </Text>
              )}
            </div>
          )}

          {/* No items warning */}
          {importRows.length === 0 && (
            <Alert
              type="warning"
              message="Детали не найдены"
              description="VLM не обнаружил деталей на изображении. Попробуйте загрузить другое фото."
              showIcon
            />
          )}
        </Space>
      )}
    </div>
  );
};
