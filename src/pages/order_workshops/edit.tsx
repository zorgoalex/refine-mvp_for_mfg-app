import { Edit, useForm } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, InputNumber, DatePicker } from "antd";
import dayjs from "dayjs";

export const OrderWorkshopEdit: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps, queryResult } = useForm();

  // Convert date strings to dayjs objects for DatePicker
  const record = queryResult?.data?.data;
  if (record) {
    if (record.received_date) formProps.initialValues = { ...formProps.initialValues, received_date: dayjs(record.received_date) };
    if (record.started_date) formProps.initialValues = { ...formProps.initialValues, started_date: dayjs(record.started_date) };
    if (record.completed_date) formProps.initialValues = { ...formProps.initialValues, completed_date: dayjs(record.completed_date) };
    if (record.planned_completion_date) formProps.initialValues = { ...formProps.initialValues, planned_completion_date: dayjs(record.planned_completion_date) };
  }

  return (
    <Edit saveButtonProps={saveButtonProps}>
      <Form {...formProps} layout="vertical">
        <Form.Item label="Order ID" name="order_id" rules={[{ required: true }]}>
          <InputNumber style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Workshop ID" name="workshop_id" rules={[{ required: true }]}>
          <InputNumber style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Production Status ID" name="production_status_id" rules={[{ required: true }]}>
          <InputNumber style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Sequence Order" name="sequence_order">
          <InputNumber style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Received Date" name="received_date">
          <DatePicker showTime style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Started Date" name="started_date">
          <DatePicker showTime style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Completed Date" name="completed_date">
          <DatePicker showTime style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Planned Completion Date" name="planned_completion_date">
          <DatePicker style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Responsible Employee ID" name="responsible_employee_id">
          <InputNumber style={{ width: '100%' }} />
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
