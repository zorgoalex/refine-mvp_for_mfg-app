// Order Detail Modal
// Modal for creating/editing order details with auto-calculation

import React, { useEffect, useState } from 'react';
import { Modal, Form, Input, InputNumber, Row, Col, Select, Space, Button, Alert } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useSelect } from '@refinedev/antd';
import { useOne } from '@refinedev/core';
import { OrderDetail } from '../../../../types/orders';
import { numberFormatter, numberParser } from '../../../../utils/numberFormat';
import { CURRENCY_SYMBOL } from '../../../../config/currency';
import { MillingTypeQuickCreate } from './MillingTypeQuickCreate';
import { EdgeTypeQuickCreate } from './EdgeTypeQuickCreate';
import { DraggableModalWrapper } from '../../../../components/DraggableModalWrapper';
import {
  validateMaterialDimensions,
  getMaterialDimensionDescription,
  MaterialInfo
} from '../../../../utils/materialDimensionValidation';

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
  const [selectedMaterialId, setSelectedMaterialId] = useState<number | null>(null);
  const [dimensionValidationError, setDimensionValidationError] = useState<string | null>(null);

  // Load reference data with search
  const { selectProps: materialSelectProps } = useSelect({
    resource: 'materials',
    optionLabel: 'material_name',
    optionValue: 'material_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    pagination: { pageSize: 100 },
    ...(detail?.material_id ? { defaultValue: detail.material_id } : {}),
  });

  const { selectProps: millingTypeSelectProps } = useSelect({
    resource: 'milling_types',
    optionLabel: 'milling_type_name',
    optionValue: 'milling_type_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
    ...(detail?.milling_type_id ? { defaultValue: detail.milling_type_id } : {}),
  });

  const { selectProps: edgeTypeSelectProps } = useSelect({
    resource: 'edge_types',
    optionLabel: 'edge_type_name',
    optionValue: 'edge_type_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
    ...(detail?.edge_type_id ? { defaultValue: detail.edge_type_id } : {}),
  });

  const { selectProps: filmSelectProps } = useSelect({
    resource: 'films',
    optionLabel: 'film_name',
    optionValue: 'film_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    pagination: { pageSize: 100 },
    ...(detail?.film_id ? { defaultValue: detail.film_id } : {}),
  });

  const { selectProps: productionStatusSelectProps } = useSelect({
    resource: 'production_statuses',
    optionLabel: 'production_status_name',
    optionValue: 'production_status_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
    ...(detail?.production_status_id ? { defaultValue: detail.production_status_id } : {}),
  });

  // Load selected material with type information
  const { data: materialData } = useOne({
    resource: 'materials',
    id: selectedMaterialId || 0,
    queryOptions: {
      enabled: selectedMaterialId !== null && selectedMaterialId > 0,
    },
    meta: {
      fields: [
        'material_id',
        'material_name',
        { material_type: ['material_type_id', 'material_type_name'] }
      ],
    },
  });

  // Initialize form when detail changes
  useEffect(() => {
    if (open) {
      if (mode === 'edit' && detail) {
        form.setFieldsValue(detail);
        setCalculatedArea(detail.area || 0);
        setCalculatedCost(detail.detail_cost || 0);
        setSelectedMaterialId(detail.material_id || null);
      } else {
        form.resetFields();
        form.setFieldsValue({
          priority: 100,
          material_id: 1, // МДФ 16мм
          milling_type_id: 1, // Модерн
          edge_type_id: 1, // р-1
        });
        setCalculatedArea(0);
        setCalculatedCost(0);
        setSelectedMaterialId(1);
        setDimensionValidationError(null);
      }
    }
  }, [open, mode, detail, form]);

  // Validate dimensions against material limits
  const validateDimensions = () => {
    const height = form.getFieldValue('height');
    const width = form.getFieldValue('width');

    if (!height || !width || !materialData?.data) {
      setDimensionValidationError(null);
      return;
    }

    const material: MaterialInfo = {
      material_id: materialData.data.material_id,
      material_name: materialData.data.material_name,
      material_type_id: materialData.data.material_type?.material_type_id,
      material_type_name: materialData.data.material_type?.material_type_name,
    };

    const validationResult = validateMaterialDimensions(height, width, material);

    if (!validationResult.isValid) {
      setDimensionValidationError(validationResult.errorMessage || null);
    } else {
      setDimensionValidationError(null);
    }
  };

  // Auto-calculate area when height, width or quantity changes
  const handleDimensionChange = () => {
    const height = form.getFieldValue('height');
    const width = form.getFieldValue('width');
    const quantity = form.getFieldValue('quantity');

    console.log('[OrderDetailModal] handleDimensionChange - height:', height, 'width:', width, 'quantity:', quantity);

    if (height && width && quantity && height > 0 && width > 0 && quantity > 0) {
      // Formula: ROUNDUP((height_mm / 1000) * (width_mm / 1000) * quantity, 2)
      const areaPerPiece = (height / 1000) * (width / 1000);
      const totalArea = areaPerPiece * quantity;
      // Round UP to 2 decimal places: Math.ceil(value * 100) / 100
      const area = Math.ceil(totalArea * 100) / 100;
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

  // Handle material change
  const handleMaterialChange = (materialId: number) => {
    setSelectedMaterialId(materialId);
    // Validation will be triggered by useEffect when materialData loads
  };

  // Trigger validation when material data loads
  useEffect(() => {
    if (materialData?.data) {
      validateDimensions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materialData]);

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
            description={
              <div>
                <div>{dimensionValidationError}</div>
                {materialData?.data && (
                  <div style={{ marginTop: 8, fontSize: '12px', opacity: 0.8 }}>
                    {getMaterialDimensionDescription({
                      material_id: materialData.data.material_id,
                      material_name: materialData.data.material_name,
                      material_type_id: materialData.data.material_type?.material_type_id,
                      material_type_name: materialData.data.material_type?.material_type_name,
                    })}
                  </div>
                )}
              </div>
            }
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
              name="material_id"
              rules={[{ required: true, message: 'Обязательное поле' }]}
              tooltip={
                materialData?.data
                  ? getMaterialDimensionDescription({
                      material_id: materialData.data.material_id,
                      material_name: materialData.data.material_name,
                      material_type_id: materialData.data.material_type?.material_type_id,
                      material_type_name: materialData.data.material_type?.material_type_name,
                    })
                  : undefined
              }
            >
              <Select
                {...materialSelectProps}
                showSearch
                placeholder="Выберите материал"
                onChange={handleMaterialChange}
                dropdownRender={(menu) => (
                  <>
                    {menu}
                    <Space style={{ padding: '8px' }}>
                      <Button
                        type="text"
                        icon={<PlusOutlined />}
                        onClick={() => {
                          // TODO: Open MaterialQuickCreate modal
                          // console.log('Open MaterialQuickCreate');
                        }}
                      >
                        Создать материал
                      </Button>
                    </Space>
                  </>
                )}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              label="Пленка"
              name="film_id"
            >
              <Select
                {...filmSelectProps}
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
          <Col span={12}>
            <Form.Item
              label="Тип фрезеровки"
              name="milling_type_id"
              rules={[{ required: true, message: 'Обязательное поле' }]}
            >
              <Select
                {...millingTypeSelectProps}
                placeholder="Выберите тип"
                dropdownRender={(menu) => (
                  <>
                    {menu}
                    <div style={{ borderTop: '1px solid #f0f0f0', padding: '8px' }}>
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
          <Col span={12}>
            <Form.Item
              label="Тип обката"
              name="edge_type_id"
              rules={[{ required: true, message: 'Обязательное поле' }]}
            >
              <Select
                {...edgeTypeSelectProps}
                placeholder="Выберите тип"
                dropdownRender={(menu) => (
                  <>
                    {menu}
                    <div style={{ borderTop: '1px solid #f0f0f0', padding: '8px' }}>
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
                {...productionStatusSelectProps}
                placeholder="Выберите статус"
                allowClear
              />
            </Form.Item>
          </Col>
        </Row>

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
