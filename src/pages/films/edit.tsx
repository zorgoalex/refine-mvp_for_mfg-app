import { nameRule } from '../../utils/nameRules';
import { Edit, useSelect } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, Switch, Select, Checkbox, Typography } from "antd";
import { useFormWithHighlight } from "../../hooks/useFormWithHighlight";
import { ReferenceSortOrderFormItem } from "../../components/ReferenceSortOrder";

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
    resource: "vendors",
    optionLabel: "vendor_name",
    optionValue: "vendor_id",
    defaultValue: current?.vendor_id,
  });

  return (
    <Edit saveButtonProps={saveButtonProps}>
      <Form {...formProps} layout="vertical">
        <Form.Item
          label="Name"
          name="film_name"
          rules={[...([
            {
              required: true,
            },
          ]), nameRule("film_name")]}
        >
          <Input />
        </Form.Item>
        <Form.Item label="Film Type" name="film_type_id">
          <Select {...typeSelectProps} />
        </Form.Item>
        <Form.Item label="Поставщик" name="vendor_id" rules={[{ required: true, message: 'Выберите поставщика' }]}>
          <Select {...vendorSelectProps} />
        </Form.Item>
        <Form.Item label="Тип номенклатуры" name="nomenclature_type" rules={[{ max: 50, message: 'Максимум 50 символов' }]}><Input maxLength={50} /></Form.Item>
        <Form.Item label="Категория номенклатуры" name="nomenclature_category" rules={[{ max: 150, message: 'Максимум 150 символов' }]}><Input maxLength={150} /></Form.Item>
        <Form.Item label="Texture" name="film_texture" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item label="Ref Key 1C"><Typography.Text copyable>{current?.ref_key_1c ?? '—'}</Typography.Text></Form.Item>
        <Form.Item label="Активен" name="is_active" valuePropName="checked">
          <Checkbox>Активен</Checkbox>
        </Form.Item>
        <ReferenceSortOrderFormItem />
      </Form>
    </Edit>
  );
};
