import { Create, useForm, useSelect } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, Select, Checkbox } from "antd";

export const UserCreate: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps } = useForm();

  const { selectProps: roleSelectProps } = useSelect({
    resource: "roles",
    optionLabel: "role_name",
    optionValue: "role_id",
  });

  const { selectProps: employeeSelectProps } = useSelect({
    resource: "employees",
    optionLabel: "full_name",
    optionValue: "employee_id",
  });

  return (
    <Create saveButtonProps={saveButtonProps}>
      <Form {...formProps} layout="vertical" initialValues={{ is_active: true, role_id: 100 }}>
        <Form.Item label="Логин" name="username" rules={[{ required: true, message: 'Пожалуйста, введите логин' }, { min: 2, message: 'Логин должен содержать минимум 2 символа' }]}>
          <Input placeholder="ivanov" />
        </Form.Item>
        <Form.Item label="Пароль" name="password_hash" rules={[{ required: true, message: 'Пожалуйста, введите пароль' }]}>
          <Input.Password placeholder="Пароль будет захеширован" />
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
    </Create>
  );
};
