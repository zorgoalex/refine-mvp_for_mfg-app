import { Edit, useSelect } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, InputNumber, DatePicker, Select } from "antd";
import { useFormWithHighlight } from "../../hooks/useFormWithHighlight";
import { useParams } from "react-router-dom";
import dayjs from "dayjs";

export const DowelOrderEdit: React.FC<IResourceComponentsProps> = () => {
  const { id } = useParams<{ id: string }>();

  const { formProps, saveButtonProps, queryResult } = useFormWithHighlight({
    resource: "doweling_orders",
    idField: "doweling_order_id",
    action: "edit",
    listUrl: "/doweling-orders",
    formProps: {
      id,
    },
  });

  const record = queryResult?.data?.data;

  // Справочник заказов
  const { selectProps: orderSelectProps } = useSelect({
    resource: "orders",
    optionLabel: "order_name",
    optionValue: "order_id",
    defaultValue: record?.order_id ?? undefined,
    pagination: { mode: "server", pageSize: 100 },
  });

  // Справочник статусов оплаты
  const { selectProps: paymentStatusSelectProps } = useSelect({
    resource: "payment_statuses",
    optionLabel: "payment_status_name",
    optionValue: "payment_status_id",
    defaultValue: record?.payment_status_id ?? undefined,
  });

  // Справочник статусов производства
  const { selectProps: productionStatusSelectProps } = useSelect({
    resource: "production_statuses",
    optionLabel: "production_status_name",
    optionValue: "production_status_id",
    defaultValue: record?.production_status_id ?? undefined,
  });

  // Справочник сотрудников (для конструктора и оператора)
  const { selectProps: employeeSelectProps } = useSelect({
    resource: "employees",
    optionLabel: "full_name",
    optionValue: "employee_id",
  });

  return (
    <Edit saveButtonProps={saveButtonProps} title="Редактирование присадки">
      <Form
        {...formProps}
        layout="vertical"
        initialValues={{
          ...formProps.initialValues,
          doweling_order_date: formProps.initialValues?.doweling_order_date
            ? dayjs(formProps.initialValues.doweling_order_date)
            : undefined,
          issue_date: formProps.initialValues?.issue_date
            ? dayjs(formProps.initialValues.issue_date)
            : undefined,
          payment_date: formProps.initialValues?.payment_date
            ? dayjs(formProps.initialValues.payment_date)
            : undefined,
        }}
      >
        <Form.Item
          label="Название присадки"
          name="doweling_order_name"
          rules={[{ required: true, message: "Обязательное поле" }]}
        >
          <Input />
        </Form.Item>

        <Form.Item
          label="Заказ"
          name="order_id"
          rules={[{ required: true, message: "Обязательное поле" }]}
        >
          <Select
            {...orderSelectProps}
            placeholder="Выберите заказ"
            showSearch
            filterOption={(input, option) =>
              String(option?.label ?? "")
                .toLowerCase()
                .includes(input.toLowerCase())
            }
          />
        </Form.Item>

        <Form.Item
          label="Дата заказа"
          name="doweling_order_date"
          rules={[{ required: true, message: "Обязательное поле" }]}
          getValueProps={(value) => ({
            value: value ? dayjs(value) : undefined,
          })}
        >
          <DatePicker style={{ width: "100%" }} format="DD.MM.YYYY" />
        </Form.Item>

        <Form.Item
          label="Статус оплаты"
          name="payment_status_id"
          rules={[{ required: true, message: "Обязательное поле" }]}
        >
          <Select {...paymentStatusSelectProps} placeholder="Выберите статус" />
        </Form.Item>

        <Form.Item
          label="Статус производства"
          name="production_status_id"
        >
          <Select
            {...productionStatusSelectProps}
            placeholder="Выберите статус"
            allowClear
          />
        </Form.Item>

        <Form.Item
          label="Конструктор"
          name="design_engineer_id"
          rules={[{ required: true, message: "Обязательное поле" }]}
        >
          <Select
            {...employeeSelectProps}
            placeholder="Выберите конструктора"
            showSearch
            filterOption={(input, option) =>
              String(option?.label ?? "")
                .toLowerCase()
                .includes(input.toLowerCase())
            }
          />
        </Form.Item>

        <Form.Item
          label="Оператор"
          name="operator_id"
          rules={[{ required: true, message: "Обязательное поле" }]}
        >
          <Select
            {...employeeSelectProps}
            placeholder="Выберите оператора"
            showSearch
            filterOption={(input, option) =>
              String(option?.label ?? "")
                .toLowerCase()
                .includes(input.toLowerCase())
            }
          />
        </Form.Item>

        <Form.Item label="Дата выдачи" name="issue_date">
          <DatePicker style={{ width: "100%" }} format="DD.MM.YYYY" />
        </Form.Item>

        <Form.Item label="Количество деталей" name="parts_count">
          <InputNumber min={0} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item label="Сумма" name="total_amount">
          <InputNumber
            min={0}
            precision={2}
            style={{ width: "100%" }}
            placeholder="0.00"
          />
        </Form.Item>

        <Form.Item label="Скидка" name="discount">
          <InputNumber
            min={0}
            precision={2}
            style={{ width: "100%" }}
            placeholder="0.00"
          />
        </Form.Item>

        <Form.Item label="Итого со скидкой" name="final_amount">
          <InputNumber
            min={0}
            precision={2}
            style={{ width: "100%" }}
            placeholder="0.00"
          />
        </Form.Item>

        <Form.Item label="Оплачено" name="paid_amount">
          <InputNumber
            min={0}
            precision={2}
            style={{ width: "100%" }}
            placeholder="0.00"
          />
        </Form.Item>

        <Form.Item label="Дата оплаты" name="payment_date">
          <DatePicker style={{ width: "100%" }} format="DD.MM.YYYY" />
        </Form.Item>

        <Form.Item label="Ссылка на CAD-файл" name="link_cad_file">
          <Input placeholder="https://..." />
        </Form.Item>

        <Form.Item label="Ссылка на PDF-файл" name="link_pdf_file">
          <Input placeholder="https://..." />
        </Form.Item>
      </Form>
    </Edit>
  );
};
