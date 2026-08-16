// Main Excel Import Modal with wizard steps

import React, { useState, useCallback, useEffect, useMemo, useRef, useLayoutEffect } from 'react';
import { Modal, Steps, Button, Space, message } from 'antd';
import { UploadOutlined, SelectOutlined, CheckCircleOutlined, ArrowLeftOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { useList } from '../../../../query/orderLifecycleQueries';
import { DraggableModalWrapper } from '../../../../components/DraggableModalWrapper';
import { useExcelParser, useRangeSelection, useImportValidation } from './hooks';
import { FileUploadStep, RangeSelectionStep, ValidationStep } from './steps';
import type { ImportStep, FieldMapping, ImportableField, SelectionRange, ReferenceData, ValidatedRow } from './types/importTypes';
import type { WorkBook } from 'xlsx';
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
import {
  readWorkspaceAttachment,
  releaseWorkspaceAttachment,
  retainWorkspaceAttachment,
} from '../../../../workspace/workspaceAttachmentRegistry';

interface ExcelImportModalProps {
  open: boolean;
  onClose: () => void;
}

const STEPS: { key: ImportStep; title: string; icon: React.ReactNode }[] = [
  { key: 'upload', title: 'Загрузка', icon: <UploadOutlined /> },
  { key: 'select', title: 'Выбор строк и столбцов', icon: <SelectOutlined /> },
  { key: 'validation', title: 'Проверка', icon: <CheckCircleOutlined /> },
];

const emptyMapping = (): FieldMapping => ({
  height: null,
  width: null,
  quantity: null,
  edge_type: null,
  film: null,
  material: null,
  milling_type: null,
  note: null,
  detail_name: null,
});

export const ExcelImportModal: React.FC<ExcelImportModalProps> = ({ open, onClose }) => {
  const { tabKey } = useKeepAlive();
  const workspaceKey = tabKey || '/orders/create';
  const restored = useRef(
    readWorkspaceCheckpointAdapterState(workspaceKey, 'excel-import-wizard'),
  ).current;
  const restoreStartedRef = useRef(false);
  const [currentStep, setCurrentStep] = useState<ImportStep>('upload');
  const [hasHeaders, setHasHeaders] = useState(() => restored?.hasHeaders === true);
  const [mapping, setMapping] = useState<FieldMapping>(() => readFieldMapping(restored?.mapping));

  const excelParser = useExcelParser();
  const rangeSelection = useRangeSelection();
  const importValidation = useImportValidation();

  const addDetail = useOrderFormStore((state) => state.addDetail);
  const recalculateFinancials = useOrderFormStore((state) => state.recalculateFinancials);
  const materialRecency = useRecentReferences('sheet_material_types');

  useWorkspaceCheckpointAdapter(workspaceKey, 'excel-import-wizard', {
    canCapture: () => !excelParser.isLoading
      && !rangeSelection.isSelecting
      && (!excelParser.sheetData
        || readWorkspaceAttachment<File>(workspaceKey, 'excel-file') !== null),
    capture: () => ({
      open,
      currentStep,
      hasHeaders,
      mapping,
      ranges: rangeSelection.ranges,
      activeRangeId: rangeSelection.activeRangeId,
      selectedSheet: excelParser.selectedSheet,
      validatedRows: importValidation.validatedRows,
    }),
  });

  useLayoutEffect(() => {
    if (!open || restoreStartedRef.current || restored?.open !== true) return;
    restoreStartedRef.current = true;
    let cancelled = false;
    const file = readWorkspaceAttachment<File>(workspaceKey, 'excel-file');
    const workbook = readWorkspaceAttachment<WorkBook>(workspaceKey, 'excel-workbook');
    if (!file || (!workbook && typeof file.arrayBuffer !== 'function')) {
      setCurrentStep('upload');
      return;
    }
    const restoreWizardState = () => {
      if (cancelled) return;
      rangeSelection.clearRanges();
      const ranges = readSelectionRanges(restored.ranges);
      ranges.forEach(rangeSelection.addRange);
      const activeRangeId = typeof restored.activeRangeId === 'string'
        ? restored.activeRangeId
        : null;
      rangeSelection.setActiveRange(
        ranges.some((range) => range.id === activeRangeId) ? activeRangeId : ranges.at(-1)?.id ?? null,
      );
      importValidation.restoreValidatedRows(readValidatedRows(restored.validatedRows));
      setCurrentStep(readExcelImportStep(restored.currentStep));
    };
    const selectedSheet = typeof restored.selectedSheet === 'string' ? restored.selectedSheet : null;
    if (workbook && excelParser.restoreWorkbook(workbook, selectedSheet)) {
      restoreWizardState();
      return;
    }
    void excelParser.parseFile(file, selectedSheet).then(restoreWizardState);
    return () => {
      cancelled = true;
    };
  }, [excelParser, importValidation, open, rangeSelection, restored, workspaceKey]);

  useEffect(() => {
    if (!excelParser.workbook) return;
    const file = readWorkspaceAttachment<File>(workspaceKey, 'excel-file');
    if (!file) return;
    retainWorkspaceAttachment({
      workspaceKey,
      attachmentKey: 'excel-workbook',
      value: excelParser.workbook,
      kind: 'parsed-workbook',
      estimatedBytes: Math.min(64 * 1024 * 1024, Math.max(file.size, file.size * 4)),
    });
  }, [excelParser.workbook, workspaceKey]);

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

  const handleNext = useCallback(() => {
    const idx = currentStepIndex;
    if (idx < STEPS.length - 1) {
      const nextStep = STEPS[idx + 1].key;

      // When moving to validation step from select, process data
      if (nextStep === 'validation' && excelParser.sheetData) {
        importValidation.processImport(
          excelParser.sheetData,
          rangeSelection.ranges,
          mapping,
          hasHeaders
        );
      }

      setCurrentStep(nextStep);
    }
  }, [currentStepIndex, excelParser.sheetData, rangeSelection.ranges, mapping, hasHeaders, importValidation]);

  const handleBack = useCallback(() => {
    const idx = currentStepIndex;
    if (idx > 0) {
      const prevStep = STEPS[idx - 1].key;

      // Reset current step state when going back
      if (currentStep === 'validation') {
        // Going back from validation to select - reset validation
        importValidation.reset();
      } else if (currentStep === 'select') {
        // Going back from select to upload - reset selection and mapping
        rangeSelection.clearRanges();
        setMapping(emptyMapping());
        setHasHeaders(false);
      }

      setCurrentStep(prevStep);
    }
  }, [currentStepIndex, currentStep, importValidation, rangeSelection]);

  const handleMappingChange = useCallback((field: ImportableField, column: string | null) => {
    setMapping(prev => ({ ...prev, [field]: column }));
  }, []);

  // Handle sheet change - clear ranges and mapping, then select new sheet
  const handleSheetChange = useCallback((sheetName: string) => {
    rangeSelection.clearRanges();
    setMapping(emptyMapping());
    lastAutoDetectRangeRef.current = null;
    excelParser.selectSheet(sheetName);
  }, [rangeSelection, excelParser]);

  const handleAutoDetect = useCallback(() => {
    if (excelParser.sheetData && rangeSelection.ranges.length > 0) {
      const detected = importValidation.autoDetectMapping(
        excelParser.sheetData,
        rangeSelection.ranges[0],
        hasHeaders
      );
      setMapping(detected);
    }
  }, [excelParser.sheetData, rangeSelection.ranges, hasHeaders, importValidation]);

  // Track last auto-detected range to avoid re-running
  const lastAutoDetectRangeRef = useRef<string | null>(null);

  // Auto-detect mapping when range is selected (only once per range)
  useEffect(() => {
    if (currentStep === 'select' && rangeSelection.ranges.length > 0 && excelParser.sheetData) {
      // Create a unique key for current range + hasHeaders
      const range = rangeSelection.ranges[0];
      const rangeKey = `${range.startRow}-${range.endRow}-${range.startCol}-${range.endCol}-${hasHeaders}`;

      // Only auto-detect if range changed
      if (lastAutoDetectRangeRef.current !== rangeKey) {
        lastAutoDetectRangeRef.current = rangeKey;
        const detected = importValidation.autoDetectMapping(
          excelParser.sheetData,
          range,
          hasHeaders
        );
        setMapping(detected);
      }
    } else if (rangeSelection.ranges.length === 0) {
      lastAutoDetectRangeRef.current = null;
    }
  }, [rangeSelection.ranges, currentStep, excelParser.sheetData, hasHeaders, importValidation]);

  const handleClose = useCallback(() => {
    // Reset all state
    excelParser.reset();
    rangeSelection.clearRanges();
    importValidation.reset();
    setCurrentStep('upload');
    setHasHeaders(false);
    setMapping(emptyMapping());
    releaseWorkspaceAttachment(workspaceKey, 'excel-file');
    releaseWorkspaceAttachment(workspaceKey, 'excel-workbook');
    deleteWorkspaceCheckpointAdapterState(workspaceKey, 'excel-import-wizard');
    onClose();
  }, [excelParser, rangeSelection, importValidation, onClose, workspaceKey]);

  const handleFileUpload = useCallback(async (file: File) => {
    const retained = retainWorkspaceAttachment({
      workspaceKey,
      attachmentKey: 'excel-file',
      value: file,
      kind: 'file',
    });
    if (!retained) {
      const error = new Error('Лимит памяти черновиков исчерпан. Закройте другой импорт и повторите.');
      message.error(error.message);
      throw error;
    }
    releaseWorkspaceAttachment(workspaceKey, 'excel-workbook');
    await excelParser.parseFile(file);
  }, [excelParser, workspaceKey]);

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
    message.success(`Импортировано ${importedDetails} деталей`);

    // Close modal immediately after successful import
    handleClose();
  }, [importValidation, addDetail, materialRecency.promote, recalculateFinancials, handleClose]);

  // Validation for next button
  const canGoNext = useMemo(() => {
    switch (currentStep) {
      case 'upload':
        return !!excelParser.sheetData && !excelParser.isLoading;
      case 'select':
        // Need range selected AND required fields mapped
        return rangeSelection.ranges.length > 0 && !!mapping.height && !!mapping.width && !!mapping.quantity;
      case 'validation':
        return importValidation.stats.validRows > 0;
      default:
        return false;
    }
  }, [currentStep, excelParser, rangeSelection.ranges, mapping, importValidation.stats]);

  const renderStepContent = () => {
    switch (currentStep) {
      case 'upload':
        return (
          <FileUploadStep
            sheets={excelParser.sheets}
            selectedSheet={excelParser.selectedSheet}
            sheetData={excelParser.sheetData}
            isLoading={excelParser.isLoading}
            error={excelParser.error}
            onFileUpload={handleFileUpload}
            onSheetSelect={excelParser.selectSheet}
          />
        );

      case 'select':
        return excelParser.sheetData ? (
          <RangeSelectionStep
            sheetData={excelParser.sheetData}
            sheets={excelParser.sheets}
            selectedSheet={excelParser.selectedSheet}
            onSheetSelect={handleSheetChange}
            ranges={rangeSelection.ranges}
            activeRangeId={rangeSelection.activeRangeId}
            isSelecting={rangeSelection.isSelecting}
            currentSelection={rangeSelection.currentSelection}
            hasHeaders={hasHeaders}
            mapping={mapping}
            onHasHeadersChange={setHasHeaders}
            onMappingChange={handleMappingChange}
            onStartSelection={rangeSelection.startSelection}
            onUpdateSelection={rangeSelection.updateSelection}
            onEndSelection={rangeSelection.endSelection}
            onRemoveRange={rangeSelection.removeRange}
            onClearRanges={rangeSelection.clearRanges}
            onSetActiveRange={rangeSelection.setActiveRange}
          />
        ) : null;

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
        title="Импорт деталей из Excel"
        open={open}
        onCancel={handleClose}
        width={1200}
        style={{ top: 20 }}
        styles={{
          body: {
            minHeight: 500,
            maxHeight: 'calc(90vh - 120px)',
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
            {modal}
          </DraggableModalWrapper>
        )}
      >
        <Steps
          current={currentStepIndex}
          items={STEPS.map(s => ({ key: s.key, title: s.title, icon: s.icon }))}
          style={{ marginBottom: 24 }}
          size="small"
        />

        <div style={{ flex: 1, overflow: 'hidden' }}>
          {renderStepContent()}
        </div>
      </Modal>
  );
};

function readExcelImportStep(value: unknown): ImportStep {
  return value === 'select' || value === 'validation' ? value : 'upload';
}

function readFieldMapping(value: unknown): FieldMapping {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyMapping();
  const source = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(emptyMapping()).map((key) => [
    key,
    typeof source[key] === 'string' ? source[key] : null,
  ])) as unknown as FieldMapping;
}

function readSelectionRanges(value: unknown): SelectionRange[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): SelectionRange[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const range = entry as Record<string, unknown>;
    if (
      typeof range.id !== 'string'
      || !Number.isSafeInteger(range.startRow)
      || !Number.isSafeInteger(range.endRow)
      || !Number.isSafeInteger(range.startCol)
      || !Number.isSafeInteger(range.endCol)
    ) return [];
    return [{
      id: range.id,
      startRow: Number(range.startRow),
      endRow: Number(range.endRow),
      startCol: Number(range.startCol),
      endCol: Number(range.endCol),
      ...(typeof range.color === 'string' ? { color: range.color } : {}),
    }];
  });
}

function readValidatedRows(value: unknown): ValidatedRow[] {
  return Array.isArray(value)
    ? value.filter((row): row is ValidatedRow => (
        !!row && typeof row === 'object' && !Array.isArray(row)
        && typeof row.isValid === 'boolean'
        && Array.isArray(row.errors)
        && Array.isArray(row.warnings)
      ))
    : [];
}
