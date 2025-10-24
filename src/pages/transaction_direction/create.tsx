import { Create, useForm } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, Checkbox, message } from "antd";

export const TransactionDirectionCreate: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps } = useForm();

  return (
    <Create saveButtonProps={saveButtonProps}>
      <Form
        {...formProps}
        layout="vertical"
        initialValues={{ is_active: true }}
        onFinish={async (values) => {
          const code = (values?.direction_code ?? "").trim();
          const name = (values?.direction_name ?? "").trim();
          if (!code) {
            message.error("Code is required");
            return;
          }
          if (!name) {
            message.error("Name is required");
            return;
          }
          return formProps.onFinish?.({
            ...values,
            direction_code: code,
            direction_name: name,
          });
        }}
      >
        <Form.Item
          label="Code"
          name="direction_code"
          rules={[{ required: true, whitespace: true }]}
        >
          <Input placeholder="e.g., IN, OUT" />
        </Form.Item>
        <Form.Item
          label="Name"
          name="direction_name"
          rules={[{ required: true, whitespace: true }]}
        >
          <Input placeholder="e.g., Inbound, Outbound" />
        </Form.Item>
        <Form.Item label="Description" name="description">
          <Input.TextArea rows={3} />
        </Form.Item>
        <Form.Item label="Active" name="is_active" valuePropName="checked">
          <Checkbox />
        </Form.Item>
      </Form>
    </Create>
  );
};
