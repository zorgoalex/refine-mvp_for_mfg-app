// Order Legacy Section
// Contains: Material ID, Milling Type ID, Edge Type ID, Film ID (для обратной совместимости)

import React from 'react';
import { Form, Row, Col, Collapse, Select } from 'antd';
import { useSelect } from '@refinedev/antd';
import { useOrderFormStore } from '../../../../stores/orderFormStore';

const { Panel } = Collapse;

export const OrderLegacySection: React.FC = () => {
  const { header, updateHeaderField } = useOrderFormStore();

  // Load references
  const { selectProps: materialProps } = useSelect({
    resource: 'materials',
    optionLabel: 'material_name',
    optionValue: 'material_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
  });

  const { selectProps: millingTypeProps } = useSelect({
    resource: 'milling_types',
    optionLabel: 'milling_type_name',
    optionValue: 'milling_type_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
  });

  const { selectProps: edgeTypeProps } = useSelect({
    resource: 'edge_types',
    optionLabel: 'edge_type_name',
    optionValue: 'edge_type_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
  });

  const { selectProps: filmProps } = useSelect({
    resource: 'films',
    optionLabel: 'film_name',
    optionValue: 'film_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
  });

  return (
    <Collapse>
      <Panel header="Legacy поля (для совместимости)" key="1">
        <Form layout="vertical">
          <Row gutter={16}>
            <Col span={6}>
              <Form.Item label="Материал">
                <Select
                  {...materialProps}
                  value={header.material_id}
                  onChange={(value) => updateHeaderField('material_id', value)}
                  placeholder="Выберите материал"
                  allowClear
                  showSearch
                  filterOption={(input, option) =>
                    (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                  }
                />
              </Form.Item>
            </Col>

            <Col span={6}>
              <Form.Item label="Тип фрезеровки">
                <Select
                  {...millingTypeProps}
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
                  {...edgeTypeProps}
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
                  {...filmProps}
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
