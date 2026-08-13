import { Table } from '../ui/tooltipDelay';
import React from 'react';
import { Form, InputNumber, Typography } from 'antd';
import { TextField } from '@refinedev/antd';

const { Title } = Typography;

export const ReferenceSortOrderFormItem: React.FC = () => (
  <Form.Item
    label="Порядок сортировки"
    name="sort_order"
    initialValue={100}
    rules={[{ required: true, message: 'Укажите порядок сортировки' }]}
  >
    <InputNumber min={-32768} max={32767} style={{ width: '100%' }} />
  </Form.Item>
);

export const ReferenceSortOrderColumn: React.FC = () => (
  <Table.Column dataIndex="sort_order" title="Порядок" sorter />
);

export const ReferenceSortOrderShow: React.FC<{ value: unknown }> = ({ value }) => (
  <div>
    <Title level={5}>Порядок сортировки</Title>
    <TextField value={value} />
  </div>
);
