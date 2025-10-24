import { Edit, useForm, useSelect } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, InputNumber, Checkbox, Select, message } from "antd";

export const MaterialTransactionTypeEdit: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps, queryResult } = useForm();
  const current = queryResult?.data?.data;

  const { selectProps: directionSelectProps } = useSelect({
    resource: "transaction_direction",
    optionLabel: "direction_name",
    optionValue: "direction_type_id",
    defaultValue: current?.direction_type_id,
  });

  return (
    <Edit saveButtonProps={saveButtonProps}>
      <Form
        {...formProps}
        layout="vertical"
        onFinish={(values) => {
          const name = (values?.transaction_type_name ?? "").trim();
          if (!name) {
            message.error("Name is required");
            return;
          }
          if (!values?.direction_type_id) {
            message.error("Direction is required");
            return;
          }
          return formProps.onFinish?.({
            ...values,
            transaction_type_name: name,
          });
        }}
      >
        <Form.Item
          label="Name"
          name="transaction_type_name"
          rules={[{ required: true, whitespace: true }]}
        >
          <Input />
        </Form.Item>
        <Form.Item
          label="Direction"
          name="direction_type_id"
          rules={[{ required: true }]}
        >
          <Select {...directionSelectProps} />
        </Form.Item>
        <Form.Item label="Affects Stock" name="affects_stock" valuePropName="checked">
          <Checkbox />
        </Form.Item>
        <Form.Item label="Requires Document" name="requires_document" valuePropName="checked">
          <Checkbox />
        </Form.Item>
        <Form.Item label="Sort Order" name="sort_order">
          <InputNumber min={0} />
        </Form.Item>
        <Form.Item label="Active" name="is_active" valuePropName="checked">
          <Checkbox />
        </Form.Item>
        <Form.Item label="Description" name="description">
          <Input.TextArea rows={3} />
        </Form.Item>
      </Form>
    </Edit>
  );
};
