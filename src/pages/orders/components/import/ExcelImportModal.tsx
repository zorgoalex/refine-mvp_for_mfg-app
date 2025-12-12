// Excel Import Modal - Main wizard component
// Manages the import flow: Upload -> Select Range -> Map Columns -> Validate -> Import

import React, { useState, useCallback, useEffect } from 'react';
import { Modal, Steps, Button, Space, message, Result } from 'antd';
import {
  UploadOutlined,
  SelectOutlined,
  LinkOutlined,
  CheckCircleOutlined,
  ArrowLeftOutlined,
  ArrowRightOutlined,
  ImportOutlined,
} from '@ant-design/icons';
import { useList } from '@refinedev/core';

import { DraggableModalWrapper } from '../../../../components/DraggableModalWrapper';
import { useExcelParser } from './hooks/useExcelParser';
import { useRangeSelection } from './hooks/useRangeSelection';
import { useImportValidation } from './hooks/useImportValidation';
import { FileUploadStep } from './steps/FileUploadStep';
import { RangeSelectionStep } from './steps/RangeSelectionStep';
import { ColumnMappingStep } from './steps/ColumnMappingStep';
import { ValidationStep } from './steps/ValidationStep';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import type { ImportStep, FieldMapping, ReferenceData } from './types/importTypes';
import { IMPORT_DEFAULTS } from './types/importTypes';

interface ExcelImportModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: (count: number) => void;
}

const STEPS: { key: ImportStep; title: string; icon: React.ReactNode }[] = [
  { key: 'upload', title: 'Загрузка', icon: <UploadOutlined /> },
  { key: 'select', title: 'Выбор данных', icon: <SelectOutlined /> },
  { key: 'mapping', title: 'Сопоставление', icon: <LinkOutlined /> },
  { key: 'validation', title: 'Проверка', icon: <CheckCircleOutlined /> },
];

const INITIAL_MAPPING: FieldMapping = {
  height: null,
  width: null,
  quantity: null,
  edge_type: null,
  film: null,
  material: null,
  milling_type: null,
  note: null,
  detail_name: null,
};

export const ExcelImportModal: React.FC<ExcelImportModalProps> = ({
  open,
  onClose,
  onSuccess,
}) => {
  // Current step
  const [currentStep, setCurrentStep] = useState<number>(0);
  const [hasHeaderRow, setHasHeaderRow] = useState(true);
  const [fieldMapping, setFieldMapping] = useState<FieldMapping>(INITIAL_MAPPING);
  const [isImporting, setIsImporting] = useState(false);
  const [importComplete, setImportComplete] = useState(false);
  const [importedCount, setImportedCount] = useState(0);

  // Hooks
  const parser = useExcelParser();
  const selection = useRangeSelection();
  const validation = useImportValidation();
  const { addDetail } = useOrderFormStore();

  // Load reference data for validation
  const { data: edgeTypesData } = useList({
    resource: 'edge_types',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    pagination: { mode: 'off' },
  });

  const { data: filmsData } = useList({
    resource: 'films',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    pagination: { mode: 'off' },
  });

  const { data: materialsData } = useList({
    resource: 'materials',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    pagination: { mode: 'off' },
  });

  const { data: millingTypesData } = useList({
    resource: 'milling_types',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    pagination: { mode: 'off' },
  });

  // Build reference data object
  const referenceData: ReferenceData = {
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

  // Reset state when modal closes
  useEffect(() => {
    if (!open) {
      setCurrentStep(0);
      setFieldMapping(INITIAL_MAPPING);
      setHasHeaderRow(true);
      setIsImporting(false);
      setImportComplete(false);
      setImportedCount(0);
      parser.reset();
      selection.clearRanges();
      validation.reset();
    }
  }, [open]);

  // Get current step key
  const currentStepKey = STEPS[currentStep]?.key || 'upload';

  // Check if can proceed to next step
  const canProceed = useCallback((): boolean => {
    switch (currentStepKey) {
      case 'upload':
        return !!parser.sheetData && parser.sheetData.rowCount > 0;
      case 'select':
        return selection.ranges.length > 0;
      case 'mapping':
        // At minimum, height, width, quantity must be mapped
        return !!(fieldMapping.height && fieldMapping.width && fieldMapping.quantity);
      case 'validation':
        return !validation.hasErrors && validation.rows.length > 0;
      default:
        return false;
    }
  }, [currentStepKey, parser.sheetData, selection.ranges, fieldMapping, validation]);

  // Handle next step
  const handleNext = useCallback(() => {
    // Special handling: when moving from mapping to validation, run extraction
    if (currentStepKey === 'mapping' && parser.sheetData) {
      validation.extractAndValidate(
        parser.sheetData,
        selection.ranges,
        fieldMapping,
        hasHeaderRow,
        referenceData
      );
    }

    if (currentStep < STEPS.length - 1) {
      setCurrentStep(prev => prev + 1);
    }
  }, [currentStep, currentStepKey, parser.sheetData, selection.ranges, fieldMapping, hasHeaderRow, referenceData, validation]);

  // Handle previous step
  const handlePrev = useCallback(() => {
    if (currentStep > 0) {
      setCurrentStep(prev => prev - 1);
    }
  }, [currentStep]);

  // Handle import
  const handleImport = useCallback(async () => {
    if (validation.hasErrors) {
      message.error('Исправьте ошибки перед импортом');
      return;
    }

    setIsImporting(true);

    try {
      const validRows = validation.getValidRows();
      let importedCount = 0;

      for (const row of validRows) {
        // Build detail data
        const detailData = {
          height: row.height || 0,
          width: row.width || 0,
          quantity: row.quantity || 1,
          material_id: row.material_id || IMPORT_DEFAULTS.material_id,
          milling_type_id: row.milling_type_id || IMPORT_DEFAULTS.milling_type_id,
          edge_type_id: row.edge_type_id || IMPORT_DEFAULTS.edge_type_id,
          film_id: row.film_id || null,
          priority: IMPORT_DEFAULTS.priority,
          note: row.note || null,
          detail_name: row.detailName || null,
        };

        addDetail(detailData);
        importedCount++;
      }

      setImportedCount(importedCount);
      setImportComplete(true);

      message.success(`Импортировано ${importedCount} деталей`);
      onSuccess?.(importedCount);
    } catch (error) {
      console.error('[ExcelImportModal] Import error:', error);
      message.error('Ошибка при импорте');
    } finally {
      setIsImporting(false);
    }
  }, [validation, addDetail, onSuccess]);

  // Handle close
  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  // Render step content
  const renderStepContent = () => {
    if (importComplete) {
      return (
        <Result
          status="success"
          title="Импорт завершён"
          subTitle={`Успешно импортировано ${importedCount} деталей`}
          extra={
            <Button type="primary" onClick={handleClose}>
              Закрыть
            </Button>
          }
        />
      );
    }

    switch (currentStepKey) {
      case 'upload':
        return (
          <FileUploadStep
            parser={parser}
            onFileSelect={parser.parseFile}
            onSheetSelect={parser.selectSheet}
          />
        );

      case 'select':
        return (
          <RangeSelectionStep
            sheetData={parser.sheetData}
            selection={selection}
            hasHeaderRow={hasHeaderRow}
            onHasHeaderRowChange={setHasHeaderRow}
          />
        );

      case 'mapping':
        return (
          <ColumnMappingStep
            sheetData={parser.sheetData}
            ranges={selection.ranges}
            fieldMapping={fieldMapping}
            onFieldMappingChange={setFieldMapping}
            hasHeaderRow={hasHeaderRow}
          />
        );

      case 'validation':
        return (
          <ValidationStep
            rows={validation.rows}
            onUpdateRow={validation.updateRow}
            errorCount={validation.errorCount}
            warningCount={validation.warningCount}
          />
        );

      default:
        return null;
    }
  };

  // Render footer buttons
  const renderFooter = () => {
    if (importComplete) {
      return null;
    }

    return (
      <Space>
        <Button onClick={handleClose}>
          Отмена
        </Button>

        {currentStep > 0 && (
          <Button icon={<ArrowLeftOutlined />} onClick={handlePrev}>
            Назад
          </Button>
        )}

        {currentStep < STEPS.length - 1 ? (
          <Button
            type="primary"
            icon={<ArrowRightOutlined />}
            onClick={handleNext}
            disabled={!canProceed()}
          >
            Далее
          </Button>
        ) : (
          <Button
            type="primary"
            icon={<ImportOutlined />}
            onClick={handleImport}
            loading={isImporting}
            disabled={!canProceed() || isImporting}
          >
            Импортировать
          </Button>
        )}
      </Space>
    );
  };

  return (
    <Modal
      title="Импорт деталей из Excel"
      open={open}
      onCancel={handleClose}
      width={900}
      footer={renderFooter()}
      destroyOnClose
      modalRender={(modal) => <DraggableModalWrapper>{modal}</DraggableModalWrapper>}
    >
      {!importComplete && (
        <Steps
          current={currentStep}
          items={STEPS.map(step => ({
            title: step.title,
            icon: step.icon,
          }))}
          style={{ marginBottom: 24 }}
        />
      )}

      <div style={{ minHeight: 400 }}>
        {renderStepContent()}
      </div>
    </Modal>
  );
};
