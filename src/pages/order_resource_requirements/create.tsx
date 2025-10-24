import { Create, useForm } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, InputNumber, Select, Checkbox, DatePicker } from "antd";

export const OrderResourceRequirementCreate: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps } = useForm();

  return (
    <Create saveButtonProps={saveButtonProps}>
      <Form {...formProps} layout="vertical" initialValues={{ is_active: true, waste_percentage: 10 }}>
        <Form.Item label="Order ID" name="order_id" rules={[{ required: true }]}>
          <InputNumber style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Resource Type" name="resource_type" rules={[{ required: true }]}>
          <Select>
            <Select.Option value="material">Material</Select.Option>
            <Select.Option value="film">Film</Select.Option>
            <Select.Option value="edge">Edge</Select.Option>
            <Select.Option value="hardware">Hardware</Select.Option>
            <Select.Option value="other">Other</Select.Option>
          </Select>
        </Form.Item>
        <Form.Item label="Material ID" name="material_id">
          <InputNumber style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Film ID" name="film_id">
          <InputNumber style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Edge Type ID" name="edge_type_id">
          <InputNumber style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Required Quantity" name="required_quantity" rules={[{ required: true }]}>
          <InputNumber min={0} step={0.001} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Unit ID" name="unit_id" rules={[{ required: true }]}>
          <InputNumber style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Waste Percentage" name="waste_percentage">
          <InputNumber min={0} step={0.01} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Requirement Status ID" name="requirement_status_id" rules={[{ required: true }]}>
          <InputNumber style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Supplier ID" name="supplier_id">
          <InputNumber style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Purchase Price" name="purchase_price">
          <InputNumber min={0} step={0.01} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Requisition ID" name="requisition_id">
          <InputNumber style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Warehouse ID" name="warehouse_id">
          <InputNumber style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Reserved At" name="reserved_at">
          <DatePicker showTime style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Consumed At" name="consumed_at">
          <DatePicker showTime style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Notes" name="notes">
          <Input.TextArea rows={3} />
        </Form.Item>
        <Form.Item label="Calculation Details (JSON)" name="calculation_details">
          <Input.TextArea rows={2} placeholder='{"key": "value"}' />
        </Form.Item>
        <Form.Item label="Active" name="is_active" valuePropName="checked">
          <Checkbox />
        </Form.Item>
        <Form.Item label="Ref Key 1C" name="ref_key_1c">
          <Input />
        </Form.Item>
      </Form>
    </Create>
  );
};
