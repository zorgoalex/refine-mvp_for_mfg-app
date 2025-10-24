import { Create, useForm } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, InputNumber, Checkbox, message } from "antd";

export const MovementStatusCreate: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps } = useForm();

  return (
    <Create saveButtonProps={saveButtonProps}>
      <Form
        {...formProps}
        layout="vertical"
        initialValues={{ is_active: true, sort_order: 10 }}
        onFinish={async (values) => {
          const code = (values?.movement_status_code ?? "").trim();
          const name = (values?.movement_status_name ?? "").trim();
          if (!code || !name) {
            message.error("Code and Name are required");
            return;
          }
          return formProps.onFinish?.({
            ...values,
            movement_status_code: code,
            movement_status_name: name,
          });
        }}
      >
        <Form.Item
          label="Code"
          name="movement_status_code"
          rules={[{ required: true, whitespace: true }]}
        >
          <Input />
        </Form.Item>
        <Form.Item
          label="Name"
          name="movement_status_name"
          rules={[{ required: true, whitespace: true }]}
        >
          <Input />
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
