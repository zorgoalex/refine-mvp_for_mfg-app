import { Create, useForm } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, InputNumber, Checkbox, message } from "antd";

export const RequisitionStatusCreate: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps } = useForm();

  return (
    <Create saveButtonProps={saveButtonProps}>
      <Form
        {...formProps}
        layout="vertical"
        initialValues={{ is_active: true, sort_order: 10 }}
        onFinish={async (values) => {
          const name = (values?.requisition_status_name ?? "").trim();
          if (!name) {
            message.error("Name is required");
            return;
          }
          return formProps.onFinish?.({
            ...values,
            requisition_status_name: name,
          });
        }}
      >
        <Form.Item
          label="Name"
          name="requisition_status_name"
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
