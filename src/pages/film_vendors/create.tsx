import { Create } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, Checkbox, message } from "antd";
import { useFormWithHighlight } from "../../hooks/useFormWithHighlight";

export const FilmVendorCreate: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps } = useFormWithHighlight({
    resource: "film_vendors",
    idField: "film_vendor_id",
  });

  return (
    <Create saveButtonProps={saveButtonProps}>
      <Form
        {...formProps}
        layout="vertical"
        onFinish={async (values) => {
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
        <Form.Item label="Активен" name="is_active" valuePropName="checked" initialValue={true}>
          <Checkbox />
        </Form.Item>
      </Form>
    </Create>
  );
};

