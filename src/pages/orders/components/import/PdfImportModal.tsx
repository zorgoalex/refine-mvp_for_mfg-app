// Main PDF Import Modal with wizard steps (2 steps: upload + validation)

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { Modal, Steps, Button, Space, message } from 'antd';
import { FilePdfOutlined, CheckCircleOutlined, ArrowLeftOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { useList } from '@refinedev/core';
import { DraggableModalWrapper } from '../../../../components/DraggableModalWrapper';
import { usePdfParser } from './hooks/usePdfParser';
import { useImportValidation } from './hooks';
import { PdfUploadStep } from './steps/PdfUploadStep';
import { ValidationStep } from './steps';
import type { ReferenceData } from './types/importTypes';
import { IMPORT_DEFAULTS } from './types/importTypes';
import { useOrderFormStore } from '../../../../stores/orderFormStore';

type PdfImportStep = 'upload' | 'validation';

interface PdfImportModalProps {
  open: boolean;
  onClose: () => void;
}

const STEPS: { key: PdfImportStep; title: string; icon: React.ReactNode }[] = [
  { key: 'upload', title: 'Загрузка PDF', icon: <FilePdfOutlined /> },
  { key: 'validation', title: 'Проверка', icon: <CheckCircleOutlined /> },
];

export const PdfImportModal: React.FC<PdfImportModalProps> = ({ open, onClose }) => {
  const [currentStep, setCurrentStep] = useState<PdfImportStep>('upload');

  const pdfParser = usePdfParser();
  const importValidation = useImportValidation();

  const addDetail = useOrderFormStore((state) => state.addDetail);
  const recalculateFinancials = useOrderFormStore((state) => state.recalculateFinancials);

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

  const { data: materialsData } = useList({
    resource: 'materials',
    pagination: { pageSize: 10000 },
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
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
      materials: (materialsData?.data || []).map((item: any) => ({
        id: item.material_id,
        name: item.material_name,
      })),
      millingTypes: (millingTypesData?.data || []).map((item: any) => ({
        id: item.milling_type_id,
        name: item.milling_type_name,
      })),
    };
    importValidation.setReferenceData(refData);
  }, [edgeTypesData, filmsData, materialsData, millingTypesData]);

  const currentStepIndex = STEPS.findIndex(s => s.key === currentStep);

  const handleNext = useCallback(() => {
    const idx = currentStepIndex;
    if (idx < STEPS.length - 1) {
      const nextStep = STEPS[idx + 1].key;

      // When moving to validation step from upload, process PDF data
      if (nextStep === 'validation' && pdfParser.importRows.length > 0) {
        importValidation.processDirectRows(pdfParser.importRows);
      }

      setCurrentStep(nextStep);
    }
  }, [currentStepIndex, pdfParser.importRows, importValidation]);

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

    for (const row of validRows) {
      const height = row.height || 0;
      const width = row.width || 0;
      const quantity = row.quantity || 1;

      // Calculate area: (height * width * quantity) in mm² -> m²
      const areaMm2 = height * width * quantity;
      const area = areaMm2 > 0 ? Math.ceil(areaMm2 / 10000) / 100 : 0;

      const detail = {
        height,
        width,
        quantity,
        area,
        edge_type_id: row.edge_type_id || IMPORT_DEFAULTS.edge_type_id,
        film_id: row.film_id || null,
        material_id: row.material_id || IMPORT_DEFAULTS.material_id,
        milling_type_id: row.milling_type_id || IMPORT_DEFAULTS.milling_type_id,
        priority: IMPORT_DEFAULTS.priority,
        note: row.note || null,
        detail_name: row.detailName || null,
      };

      addDetail(detail);
      importedDetails++;
    }

    recalculateFinancials();

    // Show success message with doweling info if available
    const dowelingInfo = pdfParser.result?.metadata.orderNumber
      ? ` (Присадка №${pdfParser.result.metadata.orderNumber})`
      : '';
    message.success(`Импортировано ${importedDetails} деталей${dowelingInfo}`);

    // Close modal
    handleClose();
  }, [importValidation, addDetail, recalculateFinancials, handleClose, pdfParser.result]);

  // Validation for next button
  const canGoNext = useMemo(() => {
    switch (currentStep) {
      case 'upload':
        return pdfParser.importRows.length > 0 && !pdfParser.isLoading;
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
            result={pdfParser.result}
            importRows={pdfParser.importRows}
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
          items={STEPS.map(s => ({ key: s.key, title: s.title, icon: s.icon }))}
          style={{ marginBottom: 24 }}
          size="small"
        />

        <div style={{ flex: 1, overflow: 'hidden' }}>
          {renderStepContent()}
        </div>
      </Modal>
    </DraggableModalWrapper>
  );
};
