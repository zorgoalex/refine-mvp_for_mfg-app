import { nameRule } from '../../utils/nameRules';
import { useSelect } from "@refinedev/antd";
import { ReferenceEdit } from "../../components/referenceDrawer/ReferenceFormShell";
import { useReferenceForm } from "../../components/referenceDrawer/useReferenceForm";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, Select, Checkbox } from "antd";
import { ReferenceSortOrderFormItem } from "../../components/ReferenceSortOrder";

export const WorkCenterEdit: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps } = useReferenceForm();

  const { selectProps: workshopSelectProps } = useSelect({
    resource: "workshops",
    optionLabel: "workshop_name",
    optionValue: "workshop_id",
    defaultValue: formProps?.initialValues?.workshop_id,
  });

  return (
    <ReferenceEdit saveButtonProps={saveButtonProps}>
      <Form {...formProps} layout="vertical">
        <Form.Item label="Код" name="workcenter_code" rules={[{ required: true, message: 'Пожалуйста, введите код участка' }]}>
          <Input placeholder="РС-1, ФР-2..." />
        </Form.Item>
        <Form.Item label="Название" name="workcenter_name" rules={[...([{ required: true, message: 'Пожалуйста, введите название участка' }]), nameRule("workcenter_name")]}>
          <Input placeholder="Участок раскроя, Участок фрезеровки..." />
        </Form.Item>
        <Form.Item label="Цех" name="workshop_id">
          <Select {...workshopSelectProps} placeholder="Выберите цех" allowClear />
        </Form.Item>
        <Form.Item label="Активен" name="is_active" valuePropName="checked">
          <Checkbox />
        </Form.Item>
        <Form.Item label="Ключ 1C" name="ref_key_1c">
          <Input placeholder="UUID из 1C" />
        </Form.Item>
        <ReferenceSortOrderFormItem />
      </Form>
    </ReferenceEdit>
  );
};
