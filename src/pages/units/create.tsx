import { Create, useForm } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, InputNumber, message } from "antd";

export const UnitCreate: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps } = useForm();

  return (
    <Create saveButtonProps={saveButtonProps}>
      <Form
        {...formProps}
        layout="vertical"
        onFinish={async (values) => {
          const code = (values?.unit_code ?? "").trim();
          const name = (values?.unit_name ?? "").trim();
          if (!code || !name) {
            message.error("Code and Name are required");
            return;
          }
          return formProps.onFinish?.({
            ...values,
            unit_code: code,
            unit_name: name,
          });
        }}
      >
        <Form.Item
          label="Code"
          name="unit_code"
          rules={[{ required: true, whitespace: true }]}
        >
          <Input placeholder="e.g. m2, pcs" />
        </Form.Item>
        <Form.Item
          label="Name"
          name="unit_name"
          rules={[{ required: true, whitespace: true }]}
        >
          <Input placeholder="e.g. квадратный метр, штука" />
        </Form.Item>
        <Form.Item label="Symbol" name="unit_symbol">
          <Input placeholder="e.g. м², шт" />
        </Form.Item>
        <Form.Item label="Decimals" name="decimals">
          <InputNumber min={0} max={6} placeholder="2" />
        </Form.Item>
        <Form.Item label="Ref Key 1C" name="ref_key_1c">
          <Input />
        </Form.Item>
      </Form>
    </Create>
  );
};
