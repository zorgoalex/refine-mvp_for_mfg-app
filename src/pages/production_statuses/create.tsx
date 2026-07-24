import { Create, useForm } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, InputNumber, Checkbox } from "antd";
import { generateProductionStatusCode } from "./productionStatusCode";
import { StatusColorFormItem } from "../../components/StatusColor";

export const ProductionStatusCreate: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps } = useForm();

  return (
    <Create saveButtonProps={saveButtonProps}>
      <Form
        {...formProps}
        layout="vertical"
        initialValues={{ is_active: true, sort_order: 100 }}
        onFinish={(values) => {
          const name = String(values?.production_status_name ?? "").trim();
          return formProps.onFinish?.({
            ...values,
            production_status_name: name,
            production_status_code: generateProductionStatusCode(name),
          });
        }}
      >
        <Form.Item
          label="Name"
          name="production_status_name"
          extra="Технический код создаётся автоматически."
          rules={[{ required: true, whitespace: true }]}
        >
          <Input />
        </Form.Item>
        <Form.Item label="Порядок сортировки" name="sort_order" rules={[{ required: true }]}>
          <InputNumber min={1} style={{ width: '100%' }} />
        </Form.Item>
        <StatusColorFormItem />
        <Form.Item label="Description" name="description">
          <Input.TextArea rows={3} />
        </Form.Item>
        <Form.Item label="Active" name="is_active" valuePropName="checked">
          <Checkbox />
        </Form.Item>
        <Form.Item label="Ref Key 1C" name="ref_key_1c">
          <Input />
        </Form.Item>
      </Form>
    </Create>
  );
};
