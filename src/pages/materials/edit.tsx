import { Edit, useSelect } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, Select, Checkbox } from "antd";
import { useFormWithHighlight } from "../../hooks/useFormWithHighlight";

export const MaterialEdit: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps, queryResult } = useFormWithHighlight({
    resource: "materials",
    idField: "material_id",
    action: "edit",
  });
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
    defaultValue: current?.vendor_id || undefined,
  });
  const { selectProps: supplierSelectProps } = useSelect({
    resource: "suppliers",
    optionLabel: "supplier_name",
    optionValue: "supplier_id",
    defaultValue: current?.default_supplier_id || undefined,
  });
  const { selectProps: unitSelectProps } = useSelect({
    resource: "units",
    optionLabel: "unit_name",
    optionValue: "unit_id",
    defaultValue: current?.unit_id,
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
        <Form.Item label="Unit" name="unit_id" rules={[{ required: true, message: "Unit is required" }]}>
          <Select {...unitSelectProps} />
        </Form.Item>
        <Form.Item label="Material Type" name="material_type_id" rules={[{ required: true, message: "Material Type is required" }]}>
          <Select {...typeSelectProps} />
        </Form.Item>
        <Form.Item label="Vendor" name="vendor_id">
          <Select {...vendorSelectProps} />
        </Form.Item>
        <Form.Item label="Supplier" name="default_supplier_id">
          <Select {...supplierSelectProps} />
        </Form.Item>
        <Form.Item label="Description" name="description">
          <Input.TextArea rows={3} />
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
