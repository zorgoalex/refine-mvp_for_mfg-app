import { Edit, useForm } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, Checkbox } from "antd";

export const ClientEdit: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps } = useForm();

  return (
    <Edit saveButtonProps={saveButtonProps}>
      <Form {...formProps} layout="vertical">
        <Form.Item
          label="Name"
          name="client_name"
          rules={[
            {
              required: true,
            },
          ]}
        >
          <Input />
        </Form.Item>
        <Form.Item label="Notes" name="notes">
          <Input.TextArea rows={4} />
        </Form.Item>
        <Form.Item
          label="Active"
          name="is_active"
          valuePropName="checked"
        >
          <Checkbox>Active</Checkbox>
        </Form.Item>
        <Form.Item label="Ref Key 1C" name="ref_key_1c">
          <Input />
        </Form.Item>
      </Form>
    </Edit>
  );
};
