import { Create, useForm } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, Checkbox } from "antd";

export const VendorCreate: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps } = useForm();

  return (
    <Create saveButtonProps={saveButtonProps}>
      <Form {...formProps} layout="vertical">
        <Form.Item label="Name" name="vendor_name" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item label="Contact Info" name="contact_info">
          <Input />
        </Form.Item>
        <Form.Item label="Ref Key 1C" name="ref_key_1c">
          <Input />
        </Form.Item>
        <Form.Item label="Active" name="is_active" initialValue={true} valuePropName="checked">
          <Checkbox />
        </Form.Item>
      </Form>
    </Create>
  );
};

