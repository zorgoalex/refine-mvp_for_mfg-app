import { Edit, useForm, useSelect } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, Select, Checkbox } from "antd";

export const WorkshopEdit: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps } = useForm();

  const { selectProps: employeeSelectProps } = useSelect({
    resource: "employees",
    optionLabel: "full_name",
    optionValue: "employee_id",
    defaultValue: formProps?.initialValues?.responsible_employee_id,
  });

  return (
    <Edit saveButtonProps={saveButtonProps}>
      <Form {...formProps} layout="vertical">
        <Form.Item label="Название" name="workshop_name" rules={[{ required: true, message: 'Пожалуйста, введите название цеха' }]}>
          <Input placeholder="Цех сборки, Цех обработки..." />
        </Form.Item>
        <Form.Item label="Адрес" name="address">
          <Input.TextArea rows={2} placeholder="Адрес цеха" />
        </Form.Item>
        <Form.Item label="Ответственный сотрудник" name="responsible_employee_id">
          <Select {...employeeSelectProps} placeholder="Выберите ответственного сотрудника" allowClear />
        </Form.Item>
        <Form.Item label="Активен" name="is_active" valuePropName="checked">
          <Checkbox />
        </Form.Item>
        <Form.Item label="Ключ 1C" name="ref_key_1c">
          <Input placeholder="UUID из 1C" />
        </Form.Item>
      </Form>
    </Edit>
  );
};
