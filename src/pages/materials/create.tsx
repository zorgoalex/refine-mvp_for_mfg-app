import { nameRule } from '../../utils/nameRules';
import { Create, useSelect } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, Select, Checkbox } from "antd";
import { useFormWithHighlight } from "../../hooks/useFormWithHighlight";
import { ReferenceSortOrderFormItem } from "../../components/ReferenceSortOrder";

export const MaterialCreate: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps } = useFormWithHighlight({
    resource: "materials",
    idField: "material_id",
  });
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
          label="Название"
          name="material_name"
          rules={[...([
            {
              required: true,
            },
          ]), nameRule("material_name")]}
        >
          <Input />
        </Form.Item>
        <Form.Item label="Единица измерения" name="unit_id" rules={[{ required: true, message: "Укажите единицу измерения" }]}>
          <Select {...unitSelectProps} />
        </Form.Item>
        <Form.Item label="Тип материала" name="material_type_id" rules={[{ required: true, message: "Укажите тип материала" }]}>
          <Select {...typeSelectProps} />
        </Form.Item>
        <Form.Item label="Производитель" name="vendor_id">
          <Select {...vendorSelectProps} />
        </Form.Item>
        <Form.Item label="Поставщик" name="default_supplier_id">
          <Select {...supplierSelectProps} />
        </Form.Item>
        <Form.Item label="Описание" name="description">
          <Input.TextArea rows={3} />
        </Form.Item>
        <Form.Item
          label="Активен"
          name="is_active"
          valuePropName="checked"
          initialValue={true}
        >
          <Checkbox>Активен</Checkbox>
        </Form.Item>
        <Form.Item label="Ключ 1С" name="ref_key_1c">
          <Input />
        </Form.Item>
        <ReferenceSortOrderFormItem />
      </Form>
    </Create>
  );
};
