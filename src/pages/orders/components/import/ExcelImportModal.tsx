// Main Excel Import Modal with wizard steps

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { Modal, Steps, Button, Space, message, Result } from 'antd';
import { UploadOutlined, SelectOutlined, LinkOutlined, CheckCircleOutlined, ArrowLeftOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { useList } from '@refinedev/core';
import { DraggableModalWrapper } from '../../../../components/DraggableModalWrapper';
import { useExcelParser, useRangeSelection, useImportValidation } from './hooks';
import { FileUploadStep, RangeSelectionStep, ColumnMappingStep, ValidationStep } from './steps';
import type { ImportStep, FieldMapping, ImportableField, SelectionRange, ReferenceData } from './types/importTypes';
import { IMPORT_DEFAULTS } from './types/importTypes';
import { useOrderFormStore } from '../../../../stores/orderFormStore';

interface ExcelImportModalProps {
  open: boolean;
  onClose: () => void;
}

const STEPS: { key: ImportStep; title: string; icon: React.ReactNode }[] = [
  { key: 'upload', title: 'Загрузка', icon: <UploadOutlined /> },
  { key: 'select', title: 'Выбор данных', icon: <SelectOutlined /> },
  { key: 'mapping', title: 'Сопоставление', icon: <LinkOutlined /> },
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
  const [currentStep, setCurrentStep] = useState<ImportStep>('upload');
  const [hasHeaders, setHasHeaders] = useState(true);
  const [mapping, setMapping] = useState<FieldMapping>(emptyMapping());
  const [importComplete, setImportComplete] = useState(false);
  const [importedCount, setImportedCount] = useState(0);

  const excelParser = useExcelParser();
  const rangeSelection = useRangeSelection();
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

      // When moving to validation step, process data
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
      setCurrentStep(STEPS[idx - 1].key);
    }
  }, [currentStepIndex]);

  const handleMappingChange = useCallback((field: ImportableField, column: string | null) => {
    setMapping(prev => ({ ...prev, [field]: column }));
  }, []);

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

  const handleImport = useCallback(() => {
    const validRows = importValidation.getValidRows();
    if (validRows.length === 0) {
      message.warning('Нет строк для импорта');
      return;
    }

    let importedDetails = 0;

    for (const row of validRows) {
      const detail = {
        height: row.height || 0,
        width: row.width || 0,
        quantity: row.quantity || 1,
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
    setImportedCount(importedDetails);
    setImportComplete(true);
    message.success(`Импортировано ${importedDetails} деталей`);
  }, [importValidation, addDetail, recalculateFinancials]);

  const handleClose = useCallback(() => {
    // Reset all state
    excelParser.reset();
    rangeSelection.clearRanges();
    importValidation.reset();
    setCurrentStep('upload');
    setHasHeaders(true);
    setMapping(emptyMapping());
    setImportComplete(false);
    setImportedCount(0);
    onClose();
  }, [excelParser, rangeSelection, importValidation, onClose]);

  // Validation for next button
  const canGoNext = useMemo(() => {
    switch (currentStep) {
      case 'upload':
        return !!excelParser.sheetData && !excelParser.isLoading;
      case 'select':
        return rangeSelection.ranges.length > 0;
      case 'mapping':
        return !!mapping.height && !!mapping.width && !!mapping.quantity;
      case 'validation':
        return importValidation.stats.validRows > 0;
      default:
        return false;
    }
  }, [currentStep, excelParser, rangeSelection.ranges, mapping, importValidation.stats]);

  const renderStepContent = () => {
    if (importComplete) {
      return (
        <Result
          status="success"
          title={`Импорт завершён`}
          subTitle={`Добавлено ${importedCount} деталей в заказ`}
          extra={[
            <Button key="close" type="primary" onClick={handleClose}>
              Закрыть
            </Button>
          ]}
        />
      );
    }

    switch (currentStep) {
      case 'upload':
        return (
          <FileUploadStep
            sheets={excelParser.sheets}
            selectedSheet={excelParser.selectedSheet}
            sheetData={excelParser.sheetData}
            isLoading={excelParser.isLoading}
            error={excelParser.error}
            onFileUpload={excelParser.parseFile}
            onSheetSelect={excelParser.selectSheet}
          />
        );

      case 'select':
        return excelParser.sheetData ? (
          <RangeSelectionStep
            sheetData={excelParser.sheetData}
            ranges={rangeSelection.ranges}
            activeRangeId={rangeSelection.activeRangeId}
            isSelecting={rangeSelection.isSelecting}
            currentSelection={rangeSelection.currentSelection}
            hasHeaders={hasHeaders}
            onHasHeadersChange={setHasHeaders}
            onStartSelection={rangeSelection.startSelection}
            onUpdateSelection={rangeSelection.updateSelection}
            onEndSelection={rangeSelection.endSelection}
            onRemoveRange={rangeSelection.removeRange}
            onClearRanges={rangeSelection.clearRanges}
            onSetActiveRange={rangeSelection.setActiveRange}
          />
        ) : null;

      case 'mapping':
        return excelParser.sheetData ? (
          <ColumnMappingStep
            sheetData={excelParser.sheetData}
            ranges={rangeSelection.ranges}
            hasHeaders={hasHeaders}
            mapping={mapping}
            onMappingChange={handleMappingChange}
            onAutoDetect={handleAutoDetect}
          />
        ) : null;

      case 'validation':
        return (
          <ValidationStep
            validatedRows={importValidation.validatedRows}
            referenceData={importValidation.referenceData}
            stats={importValidation.stats}
            onUpdateRow={importValidation.updateRow}
            onRemoveRow={importValidation.removeRow}
          />
        );

      default:
        return null;
    }
  };

  return (
    <DraggableModalWrapper open={open}>
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
            overflow: 'auto',
            display: 'flex',
            flexDirection: 'column',
          },
        }}
        footer={
          importComplete ? null : (
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
          )
        }
      >
        {!importComplete && (
          <Steps
            current={currentStepIndex}
            items={STEPS.map(s => ({ key: s.key, title: s.title, icon: s.icon }))}
            style={{ marginBottom: 24 }}
            size="small"
          />
        )}

        <div style={{ flex: 1, overflow: 'auto' }}>
          {renderStepContent()}
        </div>
      </Modal>
    </DraggableModalWrapper>
  );
};
