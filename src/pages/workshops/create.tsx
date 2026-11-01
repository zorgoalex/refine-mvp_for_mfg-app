import { nameRule } from '../../utils/nameRules';
import { useSelect } from "@refinedev/antd";
import { ReferenceCreate } from "../../components/referenceDrawer/ReferenceFormShell";
import { useReferenceForm } from "../../components/referenceDrawer/useReferenceForm";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, Select, Checkbox } from "antd";
import { ReferenceSortOrderFormItem } from "../../components/ReferenceSortOrder";

export const WorkshopCreate: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps } = useReferenceForm();

  const { selectProps: employeeSelectProps } = useSelect({
    resource: "employees",
    optionLabel: "full_name",
    optionValue: "employee_id",
  });

  return (
    <ReferenceCreate saveButtonProps={saveButtonProps}>
      <Form {...formProps} layout="vertical" initialValues={{ is_active: true }}>
        <Form.Item label="Название" name="workshop_name" rules={[...([{ required: true, message: 'Пожалуйста, введите название цеха' }]), nameRule("workshop_name")]}>
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
        <ReferenceSortOrderFormItem />
      </Form>
    </ReferenceCreate>
  );
};
