import { Create, useForm, useSelect } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, Select, Checkbox } from "antd";

export const WorkCenterCreate: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps } = useForm();

  const { selectProps: workshopSelectProps } = useSelect({
    resource: "workshops",
    optionLabel: "workshop_name",
    optionValue: "workshop_id",
  });

  return (
    <Create saveButtonProps={saveButtonProps}>
      <Form {...formProps} layout="vertical" initialValues={{ is_active: true }}>
        <Form.Item label="Код" name="workcenter_code" rules={[{ required: true, message: 'Пожалуйста, введите код участка' }]}>
          <Input placeholder="РС-1, ФР-2..." />
        </Form.Item>
        <Form.Item label="Название" name="workcenter_name" rules={[{ required: true, message: 'Пожалуйста, введите название участка' }]}>
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
      </Form>
    </Create>
  );
};
