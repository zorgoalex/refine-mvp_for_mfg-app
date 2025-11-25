import { Edit, useSelect } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, InputNumber, DatePicker, Select, Input, Row, Col, Divider } from "antd";
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
    <Edit saveButtonProps={saveButtonProps} title="Редактирование платежа">
      <Form {...formProps} layout="vertical">
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item label="Заказ" name="order_id" rules={[{ required: true, message: "Обязательное поле" }]}>
              <Select showSearch {...orderSelect} placeholder="Выберите заказ" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="Тип оплаты" name="type_paid_id" rules={[{ required: true, message: "Обязательное поле" }]}>
              <Select showSearch {...typeSelect} placeholder="Выберите тип оплаты" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="Сумма" name="amount" rules={[{ required: true, message: "Обязательное поле" }]}>
              <InputNumber min={0.01} step={0.01} style={{ width: "100%" }} placeholder="Введите сумму" />
            </Form.Item>
          </Col>
        </Row>

        <Divider style={{ margin: "16px 0" }} />

        <Row gutter={16}>
          <Col span={8}>
            <Form.Item label="Дата платежа" name="payment_date" rules={[{ required: true, message: "Обязательное поле" }]}>
              <DatePicker style={{ width: "100%" }} placeholder="Выберите дату" format="DD.MM.YYYY" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="1C-key" name="ref_key_1c">
              <Input placeholder="Ключ 1C" readOnly disabled />
            </Form.Item>
          </Col>
          <Col span={8}>
            {/* Пустая колонка для выравнивания */}
          </Col>
        </Row>

        <Divider style={{ margin: "16px 0" }} />

        <Row>
          <Col span={24}>
            <Form.Item label="Примечание" name="notes">
              <Input.TextArea rows={3} placeholder="Введите примечание" />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Edit>
  );
};

