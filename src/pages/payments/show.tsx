import { useShow, IResourceComponentsProps, useOne } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography } from "antd";

const { Title } = Typography;

export const PaymentShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({ meta: { idColumnName: "payment_id" } });
  const { data, isLoading } = queryResult;
  const record = data?.data;

  const { data: orderOne } = useOne({ resource: "orders", id: record?.order_id, queryOptions: { enabled: !!record?.order_id } });
  const { data: typeOne } = useOne({ resource: "payment_types", id: record?.type_paid_id, queryOptions: { enabled: !!record?.type_paid_id } });

  return (
    <Show isLoading={isLoading}>
      <Title level={5}>Payment ID</Title>
      <TextField value={record?.payment_id} />
      <Title level={5}>Order</Title>
      <TextField value={orderOne?.data?.order_number ?? record?.order_id} />
      <Title level={5}>Payment Type</Title>
      <TextField value={typeOne?.data?.type_paid_name ?? record?.type_paid_id} />
      <Title level={5}>Amount</Title>
      <TextField value={record?.amount} />
      <Title level={5}>Payment Date</Title>
      <DateField value={record?.payment_date} format="YYYY-MM-DD" />
      <Title level={5}>Notes</Title>
      <TextField value={record?.notes || "-"} />
      <Title level={5}>Ref Key 1C</Title>
      <TextField value={record?.ref_key_1c} />
      <Title level={5}>Создан</Title>
      <TextField value={record?.created_by || "-"} />
      <Title level={5}>Изменён</Title>
      <TextField value={record?.edited_by || "-"} />
      <Title level={5}>Создано</Title>
      <DateField value={record?.created_at} format="YYYY-MM-DD HH:mm:ss" />
      <Title level={5}>Обновлено</Title>
      <DateField value={record?.updated_at} format="YYYY-MM-DD HH:mm:ss" />
    </Show>
  );
};

