import { nameRule } from '../../utils/nameRules';
import { Create, useSelect } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, Switch, Select, Checkbox } from "antd";
import { useGetIdentity } from '@refinedev/core';
import { useFormWithHighlight } from "../../hooks/useFormWithHighlight";
import { ReferenceSortOrderFormItem } from "../../components/ReferenceSortOrder";
import { confirmSimilarFilmCreation } from './similarFilmConfirmation';

export const FilmCreate: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps } = useFormWithHighlight({
    resource: "films",
    idField: "film_id",
  });
  const { data: identity } = useGetIdentity<{ permissions?: string[] }>();
  const canViewSimilar = (identity?.permissions ?? []).includes('references.view');
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

  const handleFinish = async (values: Record<string, unknown>) => {
    const vendorId = Number(values.vendor_id);
    if (!Number.isInteger(vendorId) || vendorId < 1 || !await confirmSimilarFilmCreation(String(values.film_name ?? ''), vendorId, canViewSimilar)) return;
    await formProps.onFinish?.(values);
  };
  const vendorOptions = vendorSelectProps.options ?? [];

  return (
    <Create saveButtonProps={saveButtonProps}>
      <Form {...formProps} onFinish={handleFinish} layout="vertical">
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
        <Form.Item label="Поставщик" name="vendor_id" rules={[{ required: true, message: 'Выберите поставщика' }, {
          validator: async (_, value: number | undefined) => {
            const vendor = vendorOptions.find((item) => item.value === value);
            if (typeof vendor?.label === 'string' && vendor.label.trim().toLowerCase() === 'нд') throw new Error('Поставщик «нд» недопустим');
          },
        }]}>
          <Select {...vendorSelectProps} />
        </Form.Item>
        <Form.Item label="Тип номенклатуры" name="nomenclature_type" rules={[{ max: 50, message: 'Максимум 50 символов' }]}><Input maxLength={50} /></Form.Item>
        <Form.Item label="Категория номенклатуры" name="nomenclature_category" rules={[{ max: 150, message: 'Максимум 150 символов' }]}><Input maxLength={150} /></Form.Item>
        <Form.Item label="Texture" name="film_texture" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item label="Активен" name="is_active" valuePropName="checked" initialValue={true}>
          <Checkbox>Активен</Checkbox>
        </Form.Item>
        <ReferenceSortOrderFormItem />
      </Form>
    </Create>
  );
};
