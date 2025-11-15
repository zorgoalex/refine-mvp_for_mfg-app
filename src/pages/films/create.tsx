import { Create, useSelect } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, Switch, Select, Checkbox } from "antd";
import { useFormWithHighlight } from "../../hooks/useFormWithHighlight";

export const FilmCreate: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps } = useFormWithHighlight({
    resource: "films",
    idField: "film_id",
  });
  const { selectProps: typeSelectProps } = useSelect({
    resource: "film_types",
    optionLabel: "film_type_name",
    optionValue: "film_type_id",
  });
  const { selectProps: vendorSelectProps } = useSelect({
    resource: "vendors",
    optionLabel: "vendor_name",
    optionValue: "vendor_id",
  });

  return (
    <Create saveButtonProps={saveButtonProps}>
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
        <Form.Item label="Производитель" name="vendor_id">
          <Select {...vendorSelectProps} />
        </Form.Item>
        <Form.Item label="Texture" name="film_texture" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item label="Ref Key 1C" name="ref_key_1c">
          <Input />
        </Form.Item>
        <Form.Item label="Активен" name="is_active" valuePropName="checked" initialValue={true}>
          <Checkbox>Активен</Checkbox>
        </Form.Item>
      </Form>
    </Create>
  );
};

