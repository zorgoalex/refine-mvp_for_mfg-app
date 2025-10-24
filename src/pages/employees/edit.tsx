import { Edit, useForm } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, Checkbox } from "antd";

export const EmployeeEdit: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps } = useForm();

  return (
    <Edit saveButtonProps={saveButtonProps}>
      <Form {...formProps} layout="vertical">
        <Form.Item label="ФИО" name="full_name" rules={[{ required: true, message: 'Пожалуйста, введите ФИО сотрудника' }]}>
          <Input placeholder="Иванов Иван Иванович" />
        </Form.Item>
        <Form.Item label="Должность" name="position" rules={[{ required: true, message: 'Пожалуйста, введите должность' }]}>
          <Input placeholder="Менеджер, Оператор, Мастер..." />
        </Form.Item>
        <Form.Item label="Примечание" name="note">
          <Input.TextArea rows={3} placeholder="Дополнительная информация о сотруднике" />
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
