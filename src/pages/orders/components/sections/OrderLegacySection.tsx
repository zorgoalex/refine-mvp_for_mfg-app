// Order Legacy Section
// Contains: Material ID, Milling Type ID, Edge Type ID, Film ID (для обратной совместимости)

import React, { useMemo } from 'react';
import { Form, Row, Col, Collapse, Select } from 'antd';
import { useSelect } from '@refinedev/antd';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { createBackendSelectProps, useOrderFormData } from '../../../../hooks/useOrderFormData';
import {
  useSheetMaterialOptions,
  toSheetSelectOptions,
} from '../../../../hooks/useSheetMaterialOptions';

const { Panel } = Collapse;

export const OrderLegacySection: React.FC = () => {
  const { header, updateHeaderField } = useOrderFormStore();
  const orderFormData = useOrderFormData();
  const useBackendReferences = orderFormData.enabled;

  // SP3: sheet picker is backend-write + sheet_materials.view gated, and only for
  // SP3-era orders (create, or a loaded order whose sheet_eligible !== false).
  const sheetMaterials = useSheetMaterialOptions();
  const sheetEligible = header.sheet_eligible !== false;
  const showSheetPicker = sheetMaterials.enabled && sheetEligible;
  const hasSheetHeader =
    typeof header.sheet_material_type_id === 'number' && header.sheet_material_type_id > 0;

  // Check if any legacy fields are filled
  const hasLegacyFields = useMemo(() => {
    return !!(
      header.material_id ||
      header.sheet_material_type_id ||
      header.milling_type_id ||
      header.edge_type_id ||
      header.film_id
    );
  }, [
    header.material_id,
    header.sheet_material_type_id,
    header.milling_type_id,
    header.edge_type_id,
    header.film_id,
  ]);

  // Load references
  const { selectProps: materialProps } = useSelect({
    resource: 'materials',
    optionLabel: 'material_name',
    optionValue: 'material_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    queryOptions: { enabled: !useBackendReferences },
  });
  const resolvedMaterialProps = useBackendReferences
    ? createBackendSelectProps(orderFormData.references.materials, orderFormData.isLoading)
    : materialProps;

  const { selectProps: millingTypeProps } = useSelect({
    resource: 'milling_types',
    optionLabel: 'milling_type_name',
    optionValue: 'milling_type_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    queryOptions: { enabled: !useBackendReferences },
  });
  const resolvedMillingTypeProps = useBackendReferences
    ? createBackendSelectProps(orderFormData.references.millingTypes, orderFormData.isLoading)
    : millingTypeProps;

  const { selectProps: edgeTypeProps } = useSelect({
    resource: 'edge_types',
    optionLabel: 'edge_type_name',
    optionValue: 'edge_type_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    queryOptions: { enabled: !useBackendReferences },
  });
  const resolvedEdgeTypeProps = useBackendReferences
    ? createBackendSelectProps(orderFormData.references.edgeTypes, orderFormData.isLoading)
    : edgeTypeProps;

  const { selectProps: filmProps } = useSelect({
    resource: 'films',
    optionLabel: 'film_name',
    optionValue: 'film_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    queryOptions: { enabled: !useBackendReferences },
  });
  const resolvedFilmProps = useBackendReferences
    ? createBackendSelectProps(orderFormData.references.films, orderFormData.isLoading)
    : filmProps;

  return (
    <Collapse defaultActiveKey={hasLegacyFields ? ['1'] : []}>
      <Panel header="Legacy поля (для совместимости)" key="1">
        <Form layout="vertical">
          <Row gutter={16}>
            <Col span={6}>
              <Form.Item label="Материал">
                <Select
                  {...resolvedMaterialProps}
                  value={header.material_id}
                  onChange={(value) => updateHeaderField('material_id', value)}
                  placeholder="Выберите материал"
                  allowClear
                  showSearch
                  // SP3: a sheet material on the header authoritatively nulls
                  // material_id on the backend — disable the legacy picker to
                  // avoid a contradictory pair.
                  disabled={hasSheetHeader}
                  filterOption={(input, option) =>
                    (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                  }
                />
              </Form.Item>
            </Col>

            {showSheetPicker && (
              <Col span={6}>
                <Form.Item label="Листовой материал">
                  <Select
                    value={header.sheet_material_type_id ?? undefined}
                    options={toSheetSelectOptions(
                      sheetMaterials.options,
                      header.sheet_material_type_id,
                    )}
                    loading={sheetMaterials.isLoading}
                    onChange={(value) =>
                      updateHeaderField('sheet_material_type_id', value ?? null)
                    }
                    placeholder="Выберите листовой материал"
                    // No-clear once a sheet id is set: sheet->legacy revert is out
                    // of SP3 scope and the backend rejects it. Switch among sheets only.
                    allowClear={!hasSheetHeader}
                    showSearch
                    optionFilterProp="label"
                  />
                </Form.Item>
              </Col>
            )}

            <Col span={6}>
              <Form.Item label="Тип фрезеровки">
                <Select
                  {...resolvedMillingTypeProps}
                  value={header.milling_type_id}
                  onChange={(value) => updateHeaderField('milling_type_id', value)}
                  placeholder="Выберите тип фрезеровки"
                  allowClear
                />
              </Form.Item>
            </Col>

            <Col span={6}>
              <Form.Item label="Тип кромки">
                <Select
                  {...resolvedEdgeTypeProps}
                  value={header.edge_type_id}
                  onChange={(value) => updateHeaderField('edge_type_id', value)}
                  placeholder="Выберите тип кромки"
                  allowClear
                />
              </Form.Item>
            </Col>

            <Col span={6}>
              <Form.Item label="Пленка">
                <Select
                  {...resolvedFilmProps}
                  value={header.film_id}
                  onChange={(value) => updateHeaderField('film_id', value)}
                  placeholder="Выберите пленку"
                  allowClear
                  showSearch
                  filterOption={(input, option) =>
                    (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                  }
                />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Panel>
    </Collapse>
  );
};
