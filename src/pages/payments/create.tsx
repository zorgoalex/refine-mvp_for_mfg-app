import { Create, useSelect } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, InputNumber, DatePicker, Select, Input } from "antd";
import { useFormWithHighlight } from "../../hooks/useFormWithHighlight";

export const PaymentCreate: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps } = useFormWithHighlight({ resource: "payments", idField: "payment_id", action: "create" });
  const { selectProps: orderSelect } = useSelect({ resource: "orders", optionLabel: "order_number", optionValue: "order_id" });
  const { selectProps: typeSelect } = useSelect({ resource: "payment_types", optionLabel: "type_paid_name", optionValue: "type_paid_id" });

  return (
    <Create saveButtonProps={saveButtonProps}>
      <Form {...formProps} layout="vertical" initialValues={{ payment_date: undefined }}>
        <Form.Item label="Order" name="order_id" rules={[{ required: true }]}>
          <Select showSearch {...orderSelect} />
        </Form.Item>
        <Form.Item label="Payment Type" name="type_paid_id" rules={[{ required: true }]}>
          <Select showSearch {...typeSelect} />
        </Form.Item>
        <Form.Item label="Amount" name="amount" rules={[{ required: true }]}> 
          <InputNumber min={0.01} step={0.01} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item label="Payment Date" name="payment_date" rules={[{ required: true }]}>
          <DatePicker style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item label="Notes" name="notes">
          <Input.TextArea rows={3} />
        </Form.Item>
        <Form.Item label="Ref Key 1C" name="ref_key_1c">
          <Input />
        </Form.Item>
      </Form>
    </Create>
  );
};

