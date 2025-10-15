import { Edit, useForm, useSelect } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, Select } from "antd";

export const MaterialEdit: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps, queryResult } = useForm();
  const current = queryResult?.data?.data;
  const { selectProps: typeSelectProps } = useSelect({
    resource: "material_types",
    optionLabel: "material_type_name",
    optionValue: "material_type_id",
    defaultValue: current?.material_type_id,
  });
  const { selectProps: vendorSelectProps } = useSelect({
    resource: "vendors",
    optionLabel: "vendor_name",
    optionValue: "vendor_id",
    defaultValue: current?.vendor_id,
  });
  const { selectProps: supplierSelectProps } = useSelect({
    resource: "suppliers",
    optionLabel: "name",
    optionValue: "supplier_id",
    defaultValue: current?.default_supplier_id,
  });

  return (
    <Edit saveButtonProps={saveButtonProps}>
      <Form {...formProps} layout="vertical">
        <Form.Item
          label="Name"
          name="material_name"
          rules={[
            {
              required: true,
            },
          ]}
        >
          <Input />
        </Form.Item>
        <Form.Item label="Unit" name="unit">
          <Input />
        </Form.Item>
        <Form.Item label="Material Type" name="material_type_id">
          <Select {...typeSelectProps} />
        </Form.Item>
        <Form.Item label="Vendor" name="vendor_id">
          <Select {...vendorSelectProps} />
        </Form.Item>
        <Form.Item label="Supplier" name="default_supplier_id">
          <Select {...supplierSelectProps} />
        </Form.Item>
        <Form.Item label="Description" name="description">
          <Input />
        </Form.Item>
        <Form.Item label="Ref Key 1C" name="ref_key_1c">
          <Input />
        </Form.Item>
      </Form>
    </Edit>
  );
};
