import { Create, useForm, useSelect } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, Select } from "antd";

export const MaterialCreate: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps } = useForm();
  const { selectProps: typeSelectProps } = useSelect({
    resource: "material_types",
    optionLabel: "material_type_name",
    optionValue: "material_type_id",
  });
  const { selectProps: vendorSelectProps } = useSelect({
    resource: "vendors",
    optionLabel: "vendor_name",
    optionValue: "vendor_id",
  });
  const { selectProps: supplierSelectProps } = useSelect({
    resource: "suppliers",
    optionLabel: "supplier_name",
    optionValue: "supplier_id",
  });
  const { selectProps: unitSelectProps } = useSelect({
    resource: "units",
    optionLabel: "unit_name",
    optionValue: "unit_id",
  });

  return (
    <Create saveButtonProps={saveButtonProps}>
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
        <Form.Item label="Unit" name="unit_id">
          <Select {...unitSelectProps} />
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
    </Create>
  );
};
