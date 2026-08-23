import { Table } from '../../../../../ui/tooltipDelay';
// Step 1: Photo Upload with VLM analysis progress and results preview
// Supports optional image crop before analysis

import React, { useCallback, useState, useEffect, useRef } from 'react';
import { Upload, Typography, Space, Alert, Progress, Descriptions, Tag, Button, Image, Checkbox, message } from 'antd';
import { InboxOutlined, CameraOutlined, CloudUploadOutlined, ScanOutlined, CheckCircleOutlined, CloseCircleOutlined, ReloadOutlined, ScissorOutlined, ZoomInOutlined, ZoomOutOutlined, } from '@ant-design/icons';
import type { UploadProps } from 'antd';
import type { Crop, PixelCrop } from 'react-image-crop';
import type { ImportStatus, VlmImportResult } from '../../../../../hooks/useVlmImport';
import type { ImportRow } from '../types/importTypes';
import { ImageCropArea, cropImageToBlob } from '../components/ImageCropArea';
import { useKeepAlive } from '../../../../../components/workspace/KeepAliveContext';
import { useWorkspaceCheckpointAdapter } from '../../../../../workspace/workspaceCheckpointReact';
import { readWorkspaceCheckpointAdapterState } from '../../../../../workspace/workspaceCheckpointRegistry';
import {
  readWorkspaceAttachment,
  releaseWorkspaceAttachment,
  retainWorkspaceAttachment,
} from '../../../../../workspace/workspaceAttachmentRegistry';

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
  const { tabKey } = useKeepAlive();
  const workspaceKey = tabKey || '/orders/create';
  const restored = useRef(
    readWorkspaceCheckpointAdapterState(workspaceKey, 'vlm-photo-crop'),
  ).current;
  const retainedFile = useRef(
    readWorkspaceAttachment<File>(workspaceKey, 'vlm-photo-file'),
  ).current;
  const [previewUrl, setPreviewUrl] = useState<string | null>(() => (
    retainedFile && typeof URL !== 'undefined' ? URL.createObjectURL(retainedFile) : null
  ));
  const [selectedFile, setSelectedFile] = useState<File | null>(retainedFile);

  // Crop states
  const [useFullImage, setUseFullImage] = useState(() => restored?.useFullImage !== false);
  const [showCropPreview, setShowCropPreview] = useState(
    () => !!retainedFile && restored?.showCropPreview === true,
  );
  const [crop, setCrop] = useState<Crop | undefined>(() => readCrop(restored?.crop));
  const [completedCrop, setCompletedCrop] = useState<PixelCrop | undefined>(
    () => readPixelCrop(restored?.completedCrop),
  );
  const [scale, setScale] = useState(() => readScale(restored?.scale));
  const imgRef = useRef<HTMLImageElement | null>(null);

  useWorkspaceCheckpointAdapter(workspaceKey, 'vlm-photo-crop', {
    canCapture: () => !selectedFile
      || readWorkspaceAttachment<File>(workspaceKey, 'vlm-photo-file') === selectedFile,
    capture: () => ({
      hasFile: selectedFile !== null,
      useFullImage,
      showCropPreview,
      crop: crop ? checkpointCrop(crop) : null,
      completedCrop: completedCrop ? checkpointCrop(completedCrop) : null,
      scale,
    }),
  });

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
    const { file, onSuccess, onError } = options;
    const fileObj = file as File;
    const retained = retainWorkspaceAttachment({
      workspaceKey,
      attachmentKey: 'vlm-photo-file',
      value: fileObj,
      kind: 'file',
    });
    if (!retained) {
      const error = new Error('Лимит памяти черновиков исчерпан. Закройте другой импорт и повторите.');
      message.error(error.message);
      onError?.(error);
      return;
    }

    // Create preview URL
    const url = URL.createObjectURL(fileObj);
    setPreviewUrl(url);
    setSelectedFile(fileObj);
    setShowCropPreview(true);
    setCrop(undefined);
    setCompletedCrop(undefined);
    setScale(1);

    onSuccess?.({});
  }, [workspaceKey]);

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
    releaseWorkspaceAttachment(workspaceKey, 'vlm-photo-file');
  }, [previewUrl, workspaceKey]);

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
      const retained = retainWorkspaceAttachment({
        workspaceKey,
        attachmentKey: 'vlm-photo-file',
        value: file as File,
        kind: 'file',
      });
      if (!retained) {
        throw new Error('Лимит памяти черновиков исчерпан. Закройте другой импорт и повторите.');
      }

      await onFileUpload(file as File);
      onSuccess?.({});
    } catch (err) {
      onError?.(err as Error);
    }
  }, [onFileUpload, workspaceKey]);

  const handleReset = useCallback(() => {
    releaseWorkspaceAttachment(workspaceKey, 'vlm-photo-file');
    onReset();
  }, [onReset, workspaceKey]);

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
          background: 'var(--app-surface-muted)',
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
                background: 'var(--app-surface-muted)',
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
                      border: '1px solid var(--app-border)',
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
          background: 'var(--app-surface-muted)',
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
                  border: '1px solid var(--app-border)',
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
                onClick={handleReset}
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
                    border: '1px solid var(--app-border)',
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

function checkpointCrop(crop: Crop | PixelCrop): Record<string, unknown> {
  return {
    unit: crop.unit,
    x: crop.x,
    y: crop.y,
    width: crop.width,
    height: crop.height,
  };
}

function readCrop(value: unknown): Crop | undefined {
  const crop = readCropRecord(value);
  return crop && (crop.unit === '%' || crop.unit === 'px') ? crop as Crop : undefined;
}

function readPixelCrop(value: unknown): PixelCrop | undefined {
  const crop = readCropRecord(value);
  return crop?.unit === 'px' ? crop as PixelCrop : undefined;
}

function readCropRecord(value: unknown): Crop | PixelCrop | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const crop = value as Record<string, unknown>;
  return (crop.unit === '%' || crop.unit === 'px')
    && [crop.x, crop.y, crop.width, crop.height].every((item) => (
      typeof item === 'number' && Number.isFinite(item)
    ))
    ? crop as unknown as Crop | PixelCrop
    : null;
}

function readScale(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.25 && value <= 3
    ? value
    : 1;
}
