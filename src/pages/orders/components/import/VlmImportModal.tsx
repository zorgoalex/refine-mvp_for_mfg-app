// Main VLM Import Modal with wizard steps (2 steps: upload+analyze + validation)

import React, { useState, useCallback, useEffect, useMemo, useRef, useLayoutEffect } from 'react';
import { Modal, Steps, Button, Space, message } from 'antd';
import { CameraOutlined, CheckCircleOutlined, ArrowLeftOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { useList } from '../../../../query/orderLifecycleQueries';
import { DraggableModalWrapper } from '../../../../components/DraggableModalWrapper';
import { ResizableModalWrapper } from '../../../../components/ResizableModalWrapper';
import {
  useVlmImport,
  type ImportedOrderDetail,
  type VlmImportResult,
} from '../../../../hooks/useVlmImport';
import { useImportValidation } from './hooks';
import { PhotoUploadStep } from './steps/PhotoUploadStep';
import { ValidationStep } from './steps';
import type { ReferenceData, ImportRow, ValidatedRow } from './types/importTypes';
import { IMPORT_DEFAULTS } from './types/importTypes';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { calculateOrderDetailArea } from '../../../../utils/orderArea';
import { sortOptionsByRecency, useRecentReferences } from '../../../../hooks/useRecentReferences';
import { useKeepAlive } from '../../../../components/workspace/KeepAliveContext';
import { useWorkspaceCheckpointAdapter } from '../../../../workspace/workspaceCheckpointReact';
import {
  deleteWorkspaceCheckpointAdapterState,
  readWorkspaceCheckpointAdapterState,
} from '../../../../workspace/workspaceCheckpointRegistry';
import { releaseWorkspaceAttachment } from '../../../../workspace/workspaceAttachmentRegistry';
import { runPageOwnedWorkspaceOperation } from '../../../../workspace/workspaceOperationPins';

type VlmImportStep = 'upload' | 'validation';

interface VlmImportModalProps {
  open: boolean;
  onClose: () => void;
}

const STEPS: { key: VlmImportStep; title: string; icon: React.ReactNode }[] = [
  { key: 'upload', title: 'Загрузка фото', icon: <CameraOutlined /> },
  { key: 'validation', title: 'Проверка', icon: <CheckCircleOutlined /> },
];

/**
 * Convert VLM imported items to ImportRow format for validation
 */
function vlmItemsToImportRows(items: ImportedOrderDetail[]): ImportRow[] {
  return items.map((item, index) => ({
    sourceRowIndex: index,
    height: item.height || null,
    width: item.width || null,
    quantity: item.quantity || 1,
    edgeTypeName: item.edge || null,
    filmName: item.film || null,
    materialName: item.material || null,
    millingTypeName: item.milling || null,
    note: item.note || null,
    detailName: item.detail_name || null,
  }));
}

export const VlmImportModal: React.FC<VlmImportModalProps> = ({ open, onClose }) => {
  const { tabKey } = useKeepAlive();
  const workspaceKey = tabKey || '/orders/create';
  const restored = useRef(
    readWorkspaceCheckpointAdapterState(workspaceKey, 'vlm-import-wizard'),
  ).current;
  const restoreStartedRef = useRef(false);
  const [currentStep, setCurrentStep] = useState<VlmImportStep>('upload');

  const vlmImport = useVlmImport();
  const importValidation = useImportValidation();

  const addDetail = useOrderFormStore((state) => state.addDetail);
  const recalculateFinancials = useOrderFormStore((state) => state.recalculateFinancials);
  const materialRecency = useRecentReferences('sheet_material_types');

  useWorkspaceCheckpointAdapter(workspaceKey, 'vlm-import-wizard', {
    canCapture: () => !['uploading', 'analyzing', 'parsing'].includes(vlmImport.status),
    capture: () => ({
      open,
      currentStep,
      result: checkpointVlmResult(vlmImport.result),
      validatedRows: importValidation.validatedRows,
    }),
  });

  useLayoutEffect(() => {
    if (!open || restoreStartedRef.current || restored?.open !== true) return;
    restoreStartedRef.current = true;
    const result = readVlmResult(restored.result);
    if (result) vlmImport.restoreResult(result);
    importValidation.restoreValidatedRows(readVlmValidatedRows(restored.validatedRows));
    setCurrentStep(result ? readVlmImportStep(restored.currentStep) : 'upload');
  }, [importValidation, open, restored, vlmImport]);

  // Load reference data
  const { data: edgeTypesData } = useList({
    resource: 'edge_types',
    pagination: { pageSize: 10000 },
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
  });

  const { data: filmsData } = useList({
    resource: 'films',
    pagination: { pageSize: 10000 },
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
  });

  // Variant B: material resolution uses sheet_material_types (cuttable only)
  const { data: sheetMaterialTypesData } = useList({
    resource: 'sheet_material_types',
    pagination: { pageSize: 10000 },
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }, { field: 'sheet_material_type_id', order: 'asc' }],
    meta: { fields: ['sheet_material_type_id', 'name', 'is_cuttable', 'sort_order'] },
  });

  const { data: millingTypesData } = useList({
    resource: 'milling_types',
    pagination: { pageSize: 10000 },
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
  });

  // Update reference data when loaded
  useEffect(() => {
    const refData: ReferenceData = {
      edgeTypes: (edgeTypesData?.data || []).map((item: any) => ({
        id: item.edge_type_id,
        name: item.edge_type_name,
      })),
      films: (filmsData?.data || []).map((item: any) => ({
        id: item.film_id,
        name: item.film_name,
      })),
      millingTypes: (millingTypesData?.data || []).map((item: any) => ({
        id: item.milling_type_id,
        name: item.milling_type_name,
      })),
      // Variant B: material resolution uses sheet_material_types
      sheetMaterialTypes: sortOptionsByRecency(
        (sheetMaterialTypesData?.data || []).map((item: any) => ({
          value: item.sheet_material_type_id,
          label: item.name,
          sortOrder: item.sort_order,
          isCuttable: item.is_cuttable != null ? Boolean(item.is_cuttable) : true,
        })),
        materialRecency.recentIds,
      ).map((item) => ({
        id: item.value,
        name: item.label,
        isCuttable: item.isCuttable,
      })),
    };
    importValidation.setReferenceData(refData);
  }, [edgeTypesData, filmsData, sheetMaterialTypesData, millingTypesData, materialRecency.recentIds]);

  const currentStepIndex = STEPS.findIndex(s => s.key === currentStep);

  // Convert VLM items to ImportRow format
  const importRows = useMemo(() => {
    if (!vlmImport.result?.items) return [];
    return vlmItemsToImportRows(vlmImport.result.items);
  }, [vlmImport.result]);

  const handleVlmUpload = useCallback(
    (file: File | Blob) => runPageOwnedWorkspaceOperation(
      workspaceKey,
      'order-vlm-import',
      () => vlmImport.importFromImage(file),
    ),
    [vlmImport.importFromImage, workspaceKey],
  );

  const handleNext = useCallback(() => {
    const idx = currentStepIndex;
    if (idx < STEPS.length - 1) {
      const nextStep = STEPS[idx + 1].key;

      // When moving to validation step from upload, process VLM data
      if (nextStep === 'validation' && importRows.length > 0) {
        importValidation.processDirectRows(importRows);
      }

      setCurrentStep(nextStep);
    }
  }, [currentStepIndex, importRows, importValidation]);

  const handleBack = useCallback(() => {
    const idx = currentStepIndex;
    if (idx > 0) {
      const prevStep = STEPS[idx - 1].key;

      // Reset validation when going back
      if (currentStep === 'validation') {
        importValidation.reset();
      }

      setCurrentStep(prevStep);
    }
  }, [currentStepIndex, currentStep, importValidation]);

  const handleClose = useCallback(() => {
    // Reset all state
    vlmImport.reset();
    importValidation.reset();
    setCurrentStep('upload');
    releaseWorkspaceAttachment(workspaceKey, 'vlm-photo-file');
    deleteWorkspaceCheckpointAdapterState(workspaceKey, 'vlm-import-wizard');
    deleteWorkspaceCheckpointAdapterState(workspaceKey, 'vlm-photo-crop');
    onClose();
  }, [vlmImport, importValidation, onClose, workspaceKey]);

  const handleVlmReset = useCallback(() => {
    releaseWorkspaceAttachment(workspaceKey, 'vlm-photo-file');
    vlmImport.reset();
  }, [vlmImport, workspaceKey]);

  const handleImport = useCallback(() => {
    const validRows = importValidation.getValidRows();
    if (validRows.length === 0) {
      message.warning('Нет строк для импорта');
      return;
    }

    let importedDetails = 0;
    const usedMaterialIds = new Set<number>();

    for (const row of validRows) {
      const height = row.height || 0;
      const width = row.width || 0;
      const quantity = row.quantity || 1;

      const area = calculateOrderDetailArea(height, width, quantity);

      const detail = {
        height,
        width,
        quantity,
        area,
        edge_type_id: row.edge_type_id || IMPORT_DEFAULTS.edge_type_id,
        film_id: row.film_id || null,
        // Variant B: material_id is always null; sheet_material_type_id carries the reference
        material_id: null,
        sheet_material_type_id: row.sheet_material_type_id || null,
        milling_type_id: row.milling_type_id || IMPORT_DEFAULTS.milling_type_id,
        priority: IMPORT_DEFAULTS.priority,
        note: row.note || null,
        detail_name: row.detailName || null,
      };

      addDetail(detail);
      if (Number.isSafeInteger(row.sheet_material_type_id) && Number(row.sheet_material_type_id) > 0) {
        usedMaterialIds.add(Number(row.sheet_material_type_id));
      }
      importedDetails++;
    }

    usedMaterialIds.forEach(materialRecency.promote);
    recalculateFinancials();

    // Show success message with provider info
    const providerInfo = vlmImport.result?.provider
      ? ` (${vlmImport.result.provider})`
      : '';
    message.success(`Импортировано ${importedDetails} деталей${providerInfo}`);

    // Close modal
    handleClose();
  }, [importValidation, addDetail, materialRecency.promote, recalculateFinancials, handleClose, vlmImport.result]);

  // Validation for next button
  const canGoNext = useMemo(() => {
    switch (currentStep) {
      case 'upload':
        return vlmImport.status === 'success' && importRows.length > 0;
      case 'validation':
        return importValidation.stats.validRows > 0;
      default:
        return false;
    }
  }, [currentStep, vlmImport.status, importRows.length, importValidation.stats]);

  const renderStepContent = () => {
    switch (currentStep) {
      case 'upload':
        return (
          <PhotoUploadStep
            status={vlmImport.status}
            progress={vlmImport.progress}
            statusMessage={vlmImport.statusMessage}
            error={vlmImport.error}
            result={vlmImport.result}
            importRows={importRows}
            onFileUpload={handleVlmUpload}
            onReset={handleVlmReset}
          />
        );

      case 'validation':
        return (
          <ValidationStep
            validatedRows={importValidation.validatedRows}
            referenceData={importValidation.referenceData}
            stats={importValidation.stats}
            unresolvedRefs={importValidation.unresolvedRefs}
            onUpdateRow={importValidation.updateRow}
            onRemoveRow={importValidation.removeRow}
            onBatchReplace={importValidation.batchReplaceReference}
            onMaterialUsed={materialRecency.promote}
          />
        );

      default:
        return null;
    }
  };

  return (
        <Modal
          title={
            <Space>
              <CameraOutlined style={{ color: '#1890ff' }} />
              <span>Импорт деталей из фото</span>
              {vlmImport.result?.provider && (
                <span style={{ fontWeight: 'normal', color: '#666' }}>
                  — {vlmImport.result.provider}
                </span>
              )}
            </Space>
          }
          open={open}
          onCancel={handleClose}
          width={1200}
          style={{ top: 20 }}
          styles={{
            body: {
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            },
          }}
          footer={
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <Button
              onClick={handleBack}
              disabled={currentStepIndex === 0}
              icon={<ArrowLeftOutlined />}
            >
              Назад
            </Button>
            <Space>
              <Button onClick={handleClose}>Отмена</Button>
              {currentStep === 'validation' ? (
                <Button
                  type="primary"
                  onClick={handleImport}
                  disabled={importValidation.stats.validRows === 0}
                >
                  Импортировать ({importValidation.stats.validRows} шт)
                </Button>
              ) : (
                <Button
                  type="primary"
                  onClick={handleNext}
                  disabled={!canGoNext}
                  icon={<ArrowRightOutlined />}
                >
                  Далее
                </Button>
              )}
            </Space>
          </div>
          }
          modalRender={(modal) => (
            <DraggableModalWrapper open={open} workspaceKey={workspaceKey}>
              <ResizableModalWrapper open={open} minHeight={400} defaultHeight={550}>
                {React.isValidElement(modal) ? modal : <>{modal}</>}
              </ResizableModalWrapper>
            </DraggableModalWrapper>
          )}
      >
        <Steps
          current={currentStepIndex}
          items={STEPS.map(s => ({ key: s.key, title: s.title, icon: s.icon }))}
          style={{ marginBottom: 24 }}
          size="small"
        />

        <div style={{ flex: 1, overflow: 'auto' }}>
          {renderStepContent()}
        </div>
        </Modal>
  );
};

function readVlmImportStep(value: unknown): VlmImportStep {
  return value === 'validation' ? 'validation' : 'upload';
}

function checkpointVlmResult(result: VlmImportResult | null): Record<string, unknown> | null {
  if (!result) return null;
  return {
    success: result.success,
    items: result.items,
    parseError: result.parseError ?? null,
    error: result.error ?? null,
    provider: result.provider ?? null,
    model: result.model ?? null,
    duration: result.duration ?? null,
  };
}

function readVlmResult(value: unknown): VlmImportResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.success !== true || !Array.isArray(candidate.items)) return null;
  return {
    success: true,
    items: candidate.items as ImportedOrderDetail[],
    ...(typeof candidate.parseError === 'string' ? { parseError: candidate.parseError } : {}),
    ...(typeof candidate.provider === 'string' ? { provider: candidate.provider } : {}),
    ...(typeof candidate.model === 'string' ? { model: candidate.model } : {}),
    ...(typeof candidate.duration === 'number' ? { duration: candidate.duration } : {}),
  };
}

function readVlmValidatedRows(value: unknown): ValidatedRow[] {
  return Array.isArray(value)
    ? value.filter((row): row is ValidatedRow => (
        !!row && typeof row === 'object' && !Array.isArray(row)
        && typeof row.isValid === 'boolean'
        && Array.isArray(row.errors)
        && Array.isArray(row.warnings)
      ))
    : [];
}
