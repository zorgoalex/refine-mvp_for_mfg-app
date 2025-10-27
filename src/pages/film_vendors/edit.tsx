import { Edit, useForm } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, Checkbox, message } from "antd";

export const FilmVendorEdit: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps } = useForm();

  return (
    <Edit saveButtonProps={saveButtonProps}>
      <Form
        {...formProps}
        layout="vertical"
        onFinish={(values) => {
          const name = (values?.film_vendor_name ?? "").trim();
          if (!name) {
            message.error("Введите название поставщика плёнки");
            return;
          }
          return formProps.onFinish?.({
            ...values,
            film_vendor_name: name,
          });
        }}
      >
        <Form.Item label="Name" name="film_vendor_name" rules={[{ required: true, whitespace: true }]}>
          <Input />
        </Form.Item>
        <Form.Item label="Ref Key 1C" name="ref_key_1c">
          <Input />
        </Form.Item>
        <Form.Item label="Contact Info" name="contact_info">
          <Input.TextArea rows={3} />
        </Form.Item>
        <Form.Item label="Active" name="is_active" valuePropName="checked">
          <Checkbox />
        </Form.Item>
      </Form>
    </Edit>
  );
};
