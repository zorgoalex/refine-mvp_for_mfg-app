import { Edit, useForm, useSelect } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { DatePicker, Form, Input, Select } from "antd";

export const OrderEdit: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps, queryResult } = useForm();

  const { selectProps: clientSelectProps } = useSelect({
    resource: "clients",
    optionLabel: "client_name",
    optionValue: "client_id",
    defaultValue: queryResult?.data?.data.client_id,
  });

  const { selectProps: materialSelectProps } = useSelect({
    resource: "materials",
    optionLabel: "material_name",
    optionValue: "material_id",
    defaultValue: queryResult?.data?.data.material_id,
  });

  const { selectProps: millingTypeSelectProps } = useSelect({
    resource: "milling_types",
    optionLabel: "milling_type_name",
    optionValue: "milling_type_id",
    defaultValue: queryResult?.data?.data.milling_type_id,
  });

  const { selectProps: filmSelectProps } = useSelect({
    resource: "films",
    optionLabel: "film_name",
    optionValue: "film_id",
    defaultValue: queryResult?.data?.data.film_id,
  });

  return (
    <Edit saveButtonProps={saveButtonProps}>
      <Form
        {...formProps}
        layout="vertical"
        onFinish={(values) => {
          const isoDate = values?.order_date
            ? (values.order_date.toDate?.()
                ? values.order_date.toDate().toISOString()
                : values.order_date.toISOString?.() ?? values.order_date)
            : null;
          return formProps.onFinish?.({
            ...values,
            order_date: isoDate,
          });
        }}
      >
        <Form.Item
          label="Order Date"
          name="order_date"
          rules={[
            {
              required: true,
            },
          ]}
        >
          <DatePicker />
        </Form.Item>
        <Form.Item
          label="Order Number"
          name="order_number"
          rules={[
            {
              required: true,
            },
          ]}
        >
          <Input />
        </Form.Item>
        <Form.Item
          label="Client"
          name="client_id"
          rules={[
            {
              required: true,
            },
          ]}
        >
          <Select {...clientSelectProps} />
        </Form.Item>
        <Form.Item
          label="Material"
          name="material_id"
          rules={[
            {
              required: true,
            },
          ]}
        >
          <Select {...materialSelectProps} />
        </Form.Item>
        <Form.Item
          label="Milling Type"
          name="milling_type_id"
          rules={[
            {
              required: true,
            },
          ]}
        >
          <Select {...millingTypeSelectProps} />
        </Form.Item>
        <Form.Item
          label="Film"
          name="film_id"
          rules={[
            {
              required: true,
            },
          ]}
        >
          <Select {...filmSelectProps} />
        </Form.Item>
        <Form.Item
          label="Price"
          name="price"
          rules={[
            {
              required: true,
            },
          ]}
        >
          <Input />
        </Form.Item>
      </Form>
    </Edit>
  );
};
