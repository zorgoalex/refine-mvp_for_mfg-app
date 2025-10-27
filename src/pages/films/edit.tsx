import { Edit, useSelect } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, Switch, Select, Checkbox } from "antd";
import { useFormWithHighlight } from "../../hooks/useFormWithHighlight";

export const FilmEdit: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps, queryResult } = useFormWithHighlight({
    resource: "films",
    idField: "film_id",
    action: "edit",
  });
  const current = queryResult?.data?.data;
  const { selectProps: typeSelectProps } = useSelect({
    resource: "film_types",
    optionLabel: "film_type_name",
    optionValue: "film_type_id",
    defaultValue: current?.film_type_id,
  });
  const { selectProps: vendorSelectProps } = useSelect({
    resource: "film_vendors",
    optionLabel: "film_vendor_name",
    optionValue: "film_vendor_id",
    defaultValue: current?.film_vendor_id,
  });

  return (
    <Edit saveButtonProps={saveButtonProps}>
      <Form {...formProps} layout="vertical">
        <Form.Item
          label="Name"
          name="film_name"
          rules={[
            {
              required: true,
            },
          ]}
        >
          <Input />
        </Form.Item>
        <Form.Item label="Film Type" name="film_type_id">
          <Select {...typeSelectProps} />
        </Form.Item>
        <Form.Item label="Film Vendor" name="film_vendor_id">
          <Select {...vendorSelectProps} />
        </Form.Item>
        <Form.Item label="Texture" name="film_texture" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item label="Ref Key 1C" name="ref_key_1c">
          <Input />
        </Form.Item>
        <Form.Item label="Активен" name="is_active" valuePropName="checked">
          <Checkbox>Активен</Checkbox>
        </Form.Item>
      </Form>
    </Edit>
  );
};

