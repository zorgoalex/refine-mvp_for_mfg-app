// Main PDF Import Modal with wizard steps (2 steps: upload + validation)

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { Alert, Modal, Steps, Button, Space, message } from 'antd';
import { FilePdfOutlined, CheckCircleOutlined, ArrowLeftOutlined, ArrowRightOutlined, TableOutlined } from '@ant-design/icons';
import { useList } from '@refinedev/core';
import { DraggableModalWrapper } from '../../../../components/DraggableModalWrapper';
import { usePdfParser } from './hooks/usePdfParser';
import { useImportValidation } from './hooks';
import { PdfUploadStep } from './steps/PdfUploadStep';
import { PdfLayoutMappingStep, ValidationStep } from './steps';
import type { ReferenceData } from './types/importTypes';
import { IMPORT_DEFAULTS } from './types/importTypes';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { calculateOrderDetailArea } from '../../../../utils/orderArea';
import { sortOptionsByRecency, useRecentReferences } from '../../../../hooks/useRecentReferences';

type PdfImportStep = 'upload' | 'mapping' | 'validation';

interface PdfImportModalProps {
  open: boolean;
  onClose: () => void;
}

const STEPS: { key: PdfImportStep; title: string; icon: React.ReactNode }[] = [
  { key: 'upload', title: 'Загрузка PDF', icon: <FilePdfOutlined /> },
  { key: 'mapping', title: 'Сопоставление', icon: <TableOutlined /> },
  { key: 'validation', title: 'Проверка', icon: <CheckCircleOutlined /> },
];

export const PdfImportModal: React.FC<PdfImportModalProps> = ({ open, onClose }) => {
  const [currentStep, setCurrentStep] = useState<PdfImportStep>('upload');

  const pdfParser = usePdfParser();
  const importValidation = useImportValidation();

  const addDetail = useOrderFormStore((state) => state.addDetail);
  const recalculateFinancials = useOrderFormStore((state) => state.recalculateFinancials);
  const materialRecency = useRecentReferences('sheet_material_types');

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

  const visibleSteps = useMemo(
    () => STEPS.filter(step =>
      step.key !== 'mapping' || pdfParser.needsLayoutMapping || currentStep === 'mapping'),
    [pdfParser.needsLayoutMapping, currentStep],
  );
  const currentStepIndex = visibleSteps.findIndex(s => s.key === currentStep);

  const handleNext = useCallback(async () => {
    if (currentStep === 'upload') {
      if (pdfParser.needsLayoutMapping) {
        setCurrentStep('mapping');
        return;
      }
      if (pdfParser.importRows.length > 0) {
        importValidation.processDirectRows(pdfParser.importRows);
        setCurrentStep('validation');
      }
      return;
    }
    if (currentStep === 'mapping') {
      const rows = await pdfParser.confirmLayouts();
      if (!rows) return;
      importValidation.processDirectRows(rows);
      setCurrentStep('validation');
    }
  }, [currentStep, pdfParser, importValidation]);

  const handleBack = useCallback(() => {
    const idx = currentStepIndex;
    if (idx > 0) {
      const prevStep = visibleSteps[idx - 1].key;

      // Reset validation when going back
      if (currentStep === 'validation') {
        importValidation.reset();
      }

      setCurrentStep(prevStep);
    }
  }, [currentStepIndex, currentStep, importValidation, visibleSteps]);

  const handleClose = useCallback(() => {
    // Reset all state
    pdfParser.reset();
    importValidation.reset();
    setCurrentStep('upload');
    onClose();
  }, [pdfParser, importValidation, onClose]);

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
        basis_project: row.basisProject || null,
        basis_product: row.basisProduct || null,
        basis_data: row.basisData || null,
        basis_designation: row.basisDesignation || null,
        detail_name: row.detailName || null,
        doweling: row.doweling === true,
      };

      addDetail(detail);
      if (Number.isSafeInteger(row.sheet_material_type_id) && Number(row.sheet_material_type_id) > 0) {
        usedMaterialIds.add(Number(row.sheet_material_type_id));
      }
      importedDetails++;
    }

    usedMaterialIds.forEach(materialRecency.promote);
    recalculateFinancials();

    // Show success message with doweling info if available
    const dowelingInfo = pdfParser.result?.metadata.orderNumber
      ? ` (Присадка №${pdfParser.result.metadata.orderNumber})`
      : '';
    message.success(`Импортировано ${importedDetails} деталей${dowelingInfo}`);

    // Close modal
    handleClose();
  }, [importValidation, addDetail, materialRecency.promote, recalculateFinancials, handleClose, pdfParser.result]);

  // Validation for next button
  const canGoNext = useMemo(() => {
    switch (currentStep) {
      case 'upload':
        return (
          (pdfParser.importRows.length > 0 || pdfParser.needsLayoutMapping)
          && !pdfParser.isLoading
        );
      case 'mapping':
        return pdfParser.genericTables.length > 0;
      case 'validation':
        return importValidation.stats.validRows > 0;
      default:
        return false;
    }
  }, [currentStep, pdfParser, importValidation.stats]);

  const renderStepContent = () => {
    switch (currentStep) {
      case 'upload':
        return (
          <PdfUploadStep
            isLoading={pdfParser.isLoading}
            error={pdfParser.error}
            fileName={pdfParser.fileName}
            result={pdfParser.result}
            importRows={pdfParser.importRows}
            needsLayoutMapping={pdfParser.needsLayoutMapping}
            detectedTables={pdfParser.genericTables.length}
            onFileUpload={pdfParser.parseFile}
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

      case 'mapping':
        return (
          <PdfLayoutMappingStep
            tables={pdfParser.genericTables}
            mappings={pdfParser.layoutMappings}
            matches={pdfParser.patternMatches}
            issues={pdfParser.layoutIssues}
            onTargetChange={pdfParser.setColumnTarget}
            onGeometryCandidateRoleChange={pdfParser.setGeometryCandidateRole}
            onUnresolvedLineAction={pdfParser.setUnresolvedLineAction}
          />
        );

      default:
        return null;
    }
  };

  return (
    <DraggableModalWrapper open={open}>
      <Modal
        title={
          <Space>
            <FilePdfOutlined style={{ color: '#f5222d' }} />
            <span>Импорт деталей из PDF</span>
            {pdfParser.result?.metadata.orderNumber && (
              <span style={{ fontWeight: 'normal', color: '#666' }}>
                — Присадка №{pdfParser.result.metadata.orderNumber}
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
      >
        <Steps
          current={currentStepIndex}
          items={visibleSteps.map(s => ({ key: s.key, title: s.title, icon: s.icon }))}
          style={{ marginBottom: 24 }}
          size="small"
        />

        <div style={{ flex: 1, overflow: 'hidden' }}>
          {pdfParser.patternSaveWarning && (
            <Alert
              type="warning"
              showIcon
              message={pdfParser.patternSaveWarning}
              style={{ marginBottom: 12 }}
            />
          )}
          {renderStepContent()}
        </div>
      </Modal>
    </DraggableModalWrapper>
  );
};
