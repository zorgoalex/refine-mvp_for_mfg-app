import { Edit, useSelect } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, InputNumber, DatePicker, Select, Input } from "antd";
import { useFormWithHighlight } from "../../hooks/useFormWithHighlight";
import dayjs from "dayjs";

export const PaymentEdit: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps, queryResult } = useFormWithHighlight({ resource: "payments", idField: "payment_id", action: "edit" });
  const current = queryResult?.data?.data;
  const { selectProps: orderSelect } = useSelect({ resource: "orders", optionLabel: "order_name", optionValue: "order_id", defaultValue: current?.order_id });
  const { selectProps: typeSelect } = useSelect({ resource: "payment_types", optionLabel: "type_paid_name", optionValue: "type_paid_id", defaultValue: current?.type_paid_id });

  // Convert date string to dayjs object for DatePicker
  if (current?.payment_date) {
    formProps.initialValues = {
      ...formProps.initialValues,
      payment_date: dayjs(current.payment_date)
    };
  }

  return (
    <Edit saveButtonProps={saveButtonProps}>
      <Form {...formProps} layout="vertical">
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
    </Edit>
  );
};

