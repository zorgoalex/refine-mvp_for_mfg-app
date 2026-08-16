// Order Detail Modal
// Modal for creating/editing order details with auto-calculation

import React, { useEffect, useState } from 'react';
import { Modal, Form, Input, InputNumber, Row, Col, Select, Space, Button, Alert, Checkbox } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useSelect } from '../../../../query/orderLifecycleQueries';
import { OrderDetail } from '../../../../types/orders';
import { numberFormatter, numberParser } from '../../../../utils/numberFormat';
import { CURRENCY_SYMBOL } from '../../../../config/currency';
import { MillingTypeQuickCreate } from './MillingTypeQuickCreate';
import { EdgeTypeQuickCreate } from './EdgeTypeQuickCreate';
import { DraggableModalWrapper } from '../../../../components/DraggableModalWrapper';
import { createBackendSelectProps, useOrderFormData } from '../../../../hooks/useOrderFormData';
import {
  useSheetMaterialOptions,
  toSheetSelectOptions,
  filterCuttableOptions,
} from '../../../../hooks/useSheetMaterialOptions';
import {
  validateSheetDimensions,
} from '../../../../utils/materialDimensionValidation';
import { calculateOrderDetailArea } from '../../../../utils/orderArea';

interface OrderDetailModalProps {
  open: boolean;
  mode: 'create' | 'edit';
  detail?: OrderDetail;
  onSave: (detail: Omit<OrderDetail, 'temp_id'>) => void;
  onCancel: () => void;
}

export const OrderDetailModal: React.FC<OrderDetailModalProps> = ({
  open,
  mode,
  detail,
  onSave,
  onCancel,
}) => {
  const [form] = Form.useForm();
  const [calculatedArea, setCalculatedArea] = useState<number>(0);
  const [calculatedCost, setCalculatedCost] = useState<number>(0);
  const [millingTypeModalOpen, setMillingTypeModalOpen] = useState(false);
  const [edgeTypeModalOpen, setEdgeTypeModalOpen] = useState(false);
  const [dimensionValidationError, setDimensionValidationError] = useState<string | null>(null);
  const orderFormData = useOrderFormData();
  const useBackendReferences = orderFormData.enabled;

  // VB: sheet picker is unconditional — every detail uses sheet_material_type_id.
  const sheetMaterials = useSheetMaterialOptions();
  const detailHasStoredSheetId =
    typeof detail?.sheet_material_type_id === 'number' && detail.sheet_material_type_id > 0;
  const selectedSheetId = Form.useWatch('sheet_material_type_id', form) as
    | number
    | null
    | undefined;
  const hasSheetSelected = typeof selectedSheetId === 'number' && selectedSheetId > 0;
  // A row that already carries a STORED sheet id cannot revert to legacy (no-clear).
  const hasStoredSheetId = detailHasStoredSheetId;

  // Load reference data with search
  const { selectProps: millingTypeSelectProps } = useSelect({
    resource: 'milling_types',
    optionLabel: 'milling_type_name',
    optionValue: 'milling_type_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }, { field: 'milling_type_id', order: 'asc' }],
    ...(detail?.milling_type_id ? { defaultValue: detail.milling_type_id } : {}),
    queryOptions: { enabled: !useBackendReferences },
  });
  const resolvedMillingTypeSelectProps = useBackendReferences
    ? createBackendSelectProps(orderFormData.references.millingTypes, orderFormData.isLoading)
    : millingTypeSelectProps;

  const { selectProps: edgeTypeSelectProps } = useSelect({
    resource: 'edge_types',
    optionLabel: 'edge_type_name',
    optionValue: 'edge_type_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }, { field: 'edge_type_id', order: 'asc' }],
    ...(detail?.edge_type_id ? { defaultValue: detail.edge_type_id } : {}),
    queryOptions: { enabled: !useBackendReferences },
  });
  const resolvedEdgeTypeSelectProps = useBackendReferences
    ? createBackendSelectProps(orderFormData.references.edgeTypes, orderFormData.isLoading)
    : edgeTypeSelectProps;

  const { selectProps: filmSelectProps } = useSelect({
    resource: 'films',
    optionLabel: 'film_name',
    optionValue: 'film_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    pagination: { pageSize: 100 },
    ...(detail?.film_id ? { defaultValue: detail.film_id } : {}),
    queryOptions: { enabled: !useBackendReferences },
  });
  const resolvedFilmSelectProps = useBackendReferences
    ? createBackendSelectProps(orderFormData.references.films, orderFormData.isLoading)
    : filmSelectProps;

  const { selectProps: productionStatusSelectProps } = useSelect({
    resource: 'production_statuses',
    optionLabel: 'production_status_name',
    optionValue: 'production_status_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }, { field: 'production_status_id', order: 'asc' }],
    ...(detail?.production_status_id ? { defaultValue: detail.production_status_id } : {}),
    queryOptions: { enabled: !useBackendReferences },
  });
  const resolvedProductionStatusSelectProps = useBackendReferences
    ? createBackendSelectProps(orderFormData.references.productionStatuses, orderFormData.isLoading)
    : productionStatusSelectProps;

  // Initialize form when detail changes
  useEffect(() => {
    if (open) {
      if (mode === 'edit' && detail) {
        form.setFieldsValue(detail);
        setCalculatedArea(detail.area || 0);
        setCalculatedCost(detail.detail_cost || 0);
      } else {
        form.resetFields();
        form.setFieldsValue({
          priority: 100,
          milling_type_id: 1, // Модерн
          hdf_parameter_override_mm: null,
          edge_type_id: 1, // р-1
        });
        setCalculatedArea(0);
        setCalculatedCost(0);
        setDimensionValidationError(null);
      }
    }
  }, [open, mode, detail, form]);

  // Validate dimensions against material limits
  const validateDimensions = () => {
    const height = form.getFieldValue('height');
    const width = form.getFieldValue('width');

    // SP3: when a sheet material is selected, mirror the dimension check against
    // the sheet's own width/height (UX hint only; backend is authoritative).
    if (hasSheetSelected) {
      const sheetOption = selectedSheetId
        ? sheetMaterials.byId.get(selectedSheetId)
        : undefined;
      const sheetResult = validateSheetDimensions(
        height,
        width,
        sheetOption
          ? { name: sheetOption.label, widthMm: sheetOption.widthMm, heightMm: sheetOption.heightMm }
          : null,
      );
      setDimensionValidationError(sheetResult.isValid ? null : sheetResult.errorMessage || null);
      return;
    }

    setDimensionValidationError(null);
  };

  // Auto-calculate area when height, width or quantity changes
  const handleDimensionChange = () => {
    const height = form.getFieldValue('height');
    const width = form.getFieldValue('width');
    const quantity = form.getFieldValue('quantity');

    console.log('[OrderDetailModal] handleDimensionChange - height:', height, 'width:', width, 'quantity:', quantity);

    if (height && width && quantity && height > 0 && width > 0 && quantity > 0) {
      const areaPerPiece = (height / 1000) * (width / 1000);
      const totalArea = areaPerPiece * quantity;
      const area = calculateOrderDetailArea(height, width, quantity);
      console.log('[OrderDetailModal] calculated area:', area, '(per piece:', areaPerPiece, ', total before rounding:', totalArea, ')');
      setCalculatedArea(area);
      form.setFieldsValue({ area });

      // Also recalculate cost when area changes
      handleCostCalculation(area);
    } else {
      console.log('[OrderDetailModal] cannot calculate area - invalid dimensions or quantity');
    }

    // Validate dimensions against material limits
    validateDimensions();
  };

  // Auto-calculate cost when area or price changes
  const handleCostCalculation = (areaOverride?: number) => {
    const area = areaOverride !== undefined ? areaOverride : form.getFieldValue('area');
    const pricePerSqm = form.getFieldValue('milling_cost_per_sqm');

    console.log('[OrderDetailModal] handleCostCalculation - area:', area, 'pricePerSqm:', pricePerSqm);

    if (area && pricePerSqm && area > 0 && pricePerSqm > 0) {
      const cost = area * pricePerSqm;
      const roundedCost = Number(cost.toFixed(2));
      console.log('[OrderDetailModal] calculated cost:', cost, 'rounded:', roundedCost);
      setCalculatedCost(roundedCost);
      form.setFieldsValue({ detail_cost: roundedCost });
    } else {
      console.log('[OrderDetailModal] cannot calculate cost - invalid area or price');
    }
  };

  const handleOk = async () => {
    try {
      // Check dimension validation first
      if (dimensionValidationError) {
        console.error('[OrderDetailModal] Dimension validation failed:', dimensionValidationError);
        return;
      }

      const values = await form.validateFields();

      console.log('[OrderDetailModal] handleOk - form values:', values);
      console.log('[OrderDetailModal] handleOk - calculatedArea:', calculatedArea, 'calculatedCost:', calculatedCost);

      const normalizedCost =
        typeof values.detail_cost === 'number'
          ? Number(values.detail_cost.toFixed(2))
          : calculatedCost;

      // Prepare detail data
      const detailData: Omit<OrderDetail, 'temp_id'> = {
        ...detail, // Keep existing fields like detail_id, temp_id for edit mode
        ...values,
        area: calculatedArea,
        detail_cost: normalizedCost,
      };

      console.log('[OrderDetailModal] handleOk - final detailData:', detailData);

      onSave(detailData);
      form.resetFields();
      setDimensionValidationError(null);
    } catch (error) {
      console.error('[OrderDetailModal] Validation failed:', error);
    }
  };

  return (
    <>
    <Modal
      title={mode === 'create' ? 'Добавить деталь' : 'Редактировать деталь'}
      open={open}
      onOk={handleOk}
      onCancel={onCancel}
      width={800}
      okText="Сохранить"
      cancelText="Отмена"
      modalRender={(modal) => <DraggableModalWrapper open={open}>{modal}</DraggableModalWrapper>}
    >
      <Form form={form} layout="vertical">
        {/* Dimension validation error alert */}
        {dimensionValidationError && (
          <Alert
            message="Ошибка размеров детали"
            description={dimensionValidationError}
            type="error"
            showIcon
            closable
            onClose={() => setDimensionValidationError(null)}
            style={{ marginBottom: 16 }}
          />
        )}

        <Row gutter={16}>
          <Col span={6}>
            <Form.Item
              label="Высота (мм)"
              name="height"
              rules={[{ required: true, message: 'Обязательное поле' }]}
            >
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                precision={2}
                parser={numberParser}
                onChange={handleDimensionChange}
              />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item
              label="Ширина (мм)"
              name="width"
              rules={[{ required: true, message: 'Обязательное поле' }]}
            >
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                precision={2}
                parser={numberParser}
                onChange={handleDimensionChange}
              />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item
              label="Количество"
              name="quantity"
              rules={[{ required: true, message: 'Обязательное поле' }]}
              initialValue={1}
            >
              <InputNumber
                style={{ width: '100%' }}
                min={1}
                onChange={handleDimensionChange}
              />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item label="Площадь (м²)" name="area">
              <InputNumber
                style={{ width: '100%' }}
                disabled
                value={calculatedArea}
                precision={2}
                formatter={(value) => numberFormatter(value, 2)}
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              label="Материал"
              name="sheet_material_type_id"
              rules={[{ required: true, message: 'Обязательное поле' }]}
            >
              <Select
                options={toSheetSelectOptions(filterCuttableOptions(sheetMaterials.options), selectedSheetId)}
                loading={sheetMaterials.isLoading}
                onChange={() => setTimeout(validateDimensions, 0)}
                placeholder="Выберите материал"
                allowClear={!hasStoredSheetId}
                showSearch
                optionFilterProp="label"
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              label="Пленка"
              name="film_id"
            >
              <Select
                {...resolvedFilmSelectProps}
                showSearch
                placeholder="Выберите пленку"
                allowClear
                dropdownRender={(menu) => (
                  <>
                    {menu}
                    <Space style={{ padding: '8px' }}>
                      <Button
                        type="text"
                        icon={<PlusOutlined />}
                        onClick={() => {
                          // TODO: Open FilmQuickCreate modal
                          // console.log('Open FilmQuickCreate');
                        }}
                      >
                        Создать пленку
                      </Button>
                    </Space>
                  </>
                )}
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={10}>
            <Form.Item
              label="Тип фрезеровки"
              name="milling_type_id"
              rules={[{ required: true, message: 'Обязательное поле' }]}
            >
              <Select
                {...resolvedMillingTypeSelectProps}
                placeholder="Выберите тип"
                dropdownRender={(menu) => (
                  <>
                    {menu}
                    <div style={{ borderTop: '1px solid var(--app-border-soft)', padding: '8px' }}>
                      <Button
                        type="link"
                        icon={<PlusOutlined />}
                        onClick={() => setMillingTypeModalOpen(true)}
                        style={{ width: '100%', textAlign: 'left' }}
                      >
                        Создать тип фрезеровки
                      </Button>
                    </div>
                  </>
                )}
              />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item
              label="ХДФ мм"
              name="hdf_parameter_override_mm"
              rules={[{ type: 'number', min: 0.01, message: 'Больше 0' }]}
            >
              <InputNumber
                style={{ width: '100%' }}
                min={0.01}
                precision={2}
                parser={numberParser}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label="Тип обката"
              name="edge_type_id"
              rules={[{ required: true, message: 'Обязательное поле' }]}
            >
              <Select
                {...resolvedEdgeTypeSelectProps}
                placeholder="Выберите тип"
                dropdownRender={(menu) => (
                  <>
                    {menu}
                    <div style={{ borderTop: '1px solid var(--app-border-soft)', padding: '8px' }}>
                      <Button
                        type="link"
                        icon={<PlusOutlined />}
                        onClick={() => setEdgeTypeModalOpen(true)}
                        style={{ width: '100%', textAlign: 'left' }}
                      >
                        Создать тип обката
                      </Button>
                    </div>
                  </>
                )}
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={8}>
            <Form.Item label="Цена за м²" name="milling_cost_per_sqm">
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                precision={2}
                parser={numberParser}
                addonAfter={CURRENCY_SYMBOL}
                onChange={() => handleCostCalculation()}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label="Сумма"
              name="detail_cost"
              rules={[{ required: true, message: 'Сумма должна быть рассчитана' }]}
            >
              <InputNumber
                style={{ width: '100%' }}
                disabled
                value={calculatedCost}
                precision={2}
                formatter={(value) => numberFormatter(value, 2)}
                addonAfter={CURRENCY_SYMBOL}
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              label="Название детали"
              name="detail_name"
            >
              <Input placeholder="Опционально" />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item
              label="Приоритет"
              name="priority"
              initialValue={100}
              tooltip="1 — наивысший приоритет, большее число — ниже"
            >
              <InputNumber
                style={{ width: '100%' }}
                min={1}
                max={999}
              />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item label="Статус производства" name="production_status_id">
              <Select
                {...resolvedProductionStatusSelectProps}
                placeholder="Выберите статус"
                allowClear
              />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item name="doweling" valuePropName="checked" style={{ marginBottom: 8 }}>
          <Checkbox>Присадка</Checkbox>
        </Form.Item>

        <Form.Item label="Примечание" name="note">
          <Input.TextArea rows={3} placeholder="Дополнительная информация" />
        </Form.Item>
      </Form>
    </Modal>

    <MillingTypeQuickCreate
      open={millingTypeModalOpen}
      onClose={() => setMillingTypeModalOpen(false)}
      onSuccess={(millingTypeId) => {
        form.setFieldsValue({ milling_type_id: millingTypeId });
      }}
    />

    <EdgeTypeQuickCreate
      open={edgeTypeModalOpen}
      onClose={() => setEdgeTypeModalOpen(false)}
      onSuccess={(edgeTypeId) => {
        form.setFieldsValue({ edge_type_id: edgeTypeId });
      }}
    />
  </>
  );
};
