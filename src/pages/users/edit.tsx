import { Edit, useForm, useSelect } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, Select, Checkbox } from "antd";

export const UserEdit: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps } = useForm();

  const { selectProps: roleSelectProps } = useSelect({
    resource: "roles",
    optionLabel: "role_name",
    optionValue: "role_id",
    defaultValue: formProps?.initialValues?.role_id,
  });

  const { selectProps: employeeSelectProps } = useSelect({
    resource: "employees",
    optionLabel: "full_name",
    optionValue: "employee_id",
    defaultValue: formProps?.initialValues?.employee_id,
  });

  return (
    <Edit saveButtonProps={saveButtonProps}>
      <Form {...formProps} layout="vertical">
        <Form.Item label="Логин" name="username" rules={[{ required: true, message: 'Пожалуйста, введите логин' }, { min: 2, message: 'Логин должен содержать минимум 2 символа' }]}>
          <Input placeholder="ivanov" />
        </Form.Item>
        <Form.Item label="Новый пароль" name="password_hash" help="Оставьте пустым, если не хотите менять пароль">
          <Input.Password placeholder="Введите новый пароль" />
        </Form.Item>
        <Form.Item label="Роль" name="role_id" rules={[{ required: true, message: 'Пожалуйста, выберите роль' }]}>
          <Select {...roleSelectProps} placeholder="Выберите роль пользователя" />
        </Form.Item>
        <Form.Item label="Сотрудник" name="employee_id">
          <Select {...employeeSelectProps} placeholder="Выберите сотрудника" allowClear />
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
