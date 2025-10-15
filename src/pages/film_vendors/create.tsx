import { Create, useForm } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, message } from "antd";

export const FilmVendorCreate: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps } = useForm();

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
      </Form>
    </Create>
  );
};
