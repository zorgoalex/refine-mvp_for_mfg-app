import { Create, useForm, useSelect } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, InputNumber, Checkbox, Select, message } from "antd";

export const MaterialTransactionTypeCreate: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps } = useForm();

  const { selectProps: directionSelectProps } = useSelect({
    resource: "transaction_direction",
    optionLabel: "direction_name",
    optionValue: "direction_type_id",
  });

  return (
    <Create saveButtonProps={saveButtonProps}>
      <Form
        {...formProps}
        layout="vertical"
        initialValues={{
          is_active: true,
          sort_order: 10,
          affects_stock: true,
          requires_document: false
        }}
        onFinish={async (values) => {
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
    </Create>
  );
};
